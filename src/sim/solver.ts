/**
 * Discrete forward simulation.
 *
 * A system can hold several independent mechanisms sharing one battery. Their
 * MOTION is independent -- an arm and a drivetrain do not push on each other
 * -- but their CURRENT is not: both draw from the same V_bus, and one sagging
 * it affects the other's torque. So every timestep runs two passes across all
 * mechanisms rather than one straight line down a single chain:
 *
 *   pass 1  each mechanism reads its own state and evaluates its controller,
 *           producing a duty cycle -- independent of every other mechanism
 *   solve   the shared bus voltage, closed-form across all branches at once
 *   pass 2  each mechanism computes its own current/torque against that
 *           shared V_bus, then integrates forward
 *
 * With one mechanism this collapses to exactly the single-branch formula the
 * tool always used; the N-branch case is a strict generalization of it, not a
 * different algorithm.
 */

import { System, Mechanism, G_ACCEL } from './compile';
import { Channel, channelsFor } from './blocks';


export interface SimOptions {
  duration: number; // seconds
  dt?: number;       // override the auto-selected timestep
}

export interface RunOptions {
  /** Seconds to pre-allocate for. A live run grows past this as needed. */
  duration: number;
  dt?: number;
}

/**
 * A resumable simulation. Batch mode advances it to completion in one go; a
 * live run advances it a chunk at a time against the wall clock, which is the
 * only difference between the two -- identical physics, identical stepping.
 */
export interface Run {
  readonly dt: number;
  /** Steps taken so far. */
  readonly steps: number;
  /** Advance by n steps, growing buffers if needed. Returns steps actually taken. */
  advance(n: number): number;
  /** Current results. Cheap -- returns views over the live buffers. */
  snapshot(): SimResult;
}

export interface MechanismResult {
  motorId: string;
  solidId: string;
  controllerId: string | null;
  timeConstant: number;
  linearDisplay: boolean;
  peakCurrent: number;
  /** Time to reach the controller's target, or null if never / no controller. */
  timeToTarget: number | null;
  /** Error remaining at the end of the run, in the source channel's units. */
  steadyStateError: number | null;
  /** How far past the setpoint the mechanism travelled, same units. */
  overshoot: number | null;
}

export interface SimResult {
  dt: number;
  steps: number;
  channels: Channel[];
  /** Columnar data, keyed by channel key. Every channel is recorded, always. */
  data: Record<string, Float64Array>;
  time: Float64Array;
  minBusVoltage: number;
  /** Peak of the SUM of every mechanism's current -- what actually stresses the battery. */
  peakCurrent: number;
  mechanisms: MechanismResult[];
}

/**
 * Mechanical time constant, reflected to the motor shaft. A high-ratio,
 * low-inertia mechanism can push this under 5 ms, which is why dt is derived
 * from it rather than fixed.
 */
export function timeConstant(m: Mechanism): number {
  const n = m.motorBlock.count;
  const jReflected = m.inertiaSolid / (m.ratio * m.ratio) + n * m.motor.spec.rotorInertia;
  return (jReflected * m.motor.R) / (n * m.motor.Kt * m.motor.Ke);
}

/** Everything about one mechanism that stays constant across the whole run. */
interface Branch {
  mech: Mechanism;
  n: number;
  R: number;   // motor winding resistance + this branch's own wire/breaker
  Kt: number;
  Kv: number;
  G: number;
  eta: number;
  jEff: number;
  posScale: number;
  velScale: number;
  gearCum: { ratio: number; eff: number }[];
  measure: (theta: number, omega: number) => number;
  // mutable per-step state
  theta: number;
  omega: number;
  integral: number;
  prevMeas: number;
  measMin: number;
  measMax: number;
  lastErr: number;
  startMeas: number;
  peakCurrent: number;
  timeToTarget: number | null;
}

export function createRun(sys: System, opts: RunOptions): Run {
  const vOc = sys.battery.vOc;
  const rBatt = sys.battery.rBatt; // shared, in series with the TOTAL current
  const rBranch = sys.battery.rBranch; // each branch's own wire/breaker

  const branches: Branch[] = sys.mechanisms.map((mech) => {
    const n = mech.motorBlock.count;
    const { R: Rm, Kt, Kv } = mech.motor;
    const posScale = mech.posScale;
    const velScale = mech.velScale;

    const gearCum: { ratio: number; eff: number }[] = [];
    {
      let r = 1, e = 1;
      for (const g of mech.gears) {
        e *= g.efficiency;
        if (g.flavor !== 'drum') r *= g.ratio;
        gearCum.push({ ratio: r, eff: e });
      }
    }

    // Each readable channel reports in its OWN unit, so the controller's
    // setpoint is read in whatever unit the channel it tracks is set to.
    const measure = (theta: number, omega: number): number => {
      if (!mech.errorSource) return 0;
      if (mech.errorSource === `${mech.motorBlock.id}.speed`) return omega * mech.ratio;
      if (mech.errorSource.endsWith('.velocity')) return omega * velScale;
      return theta * posScale;
    };

    return {
      mech, n, R: Rm + rBranch, Kt, Kv, G: mech.ratio, eta: mech.efficiency,
      jEff: mech.jEffOutput, posScale, velScale, gearCum, measure,
      theta: mech.theta0, omega: 0, integral: 0, prevMeas: NaN,
      measMin: Infinity, measMax: -Infinity, lastErr: 0,
      startMeas: mech.theta0 * posScale, peakCurrent: 0, timeToTarget: null,
    };
  });

  // dt is chosen against the STIFFEST mechanism -- the one with the shortest
  // time constant -- since every branch integrates in lockstep.
  const tConstants = sys.mechanisms.map(timeConstant);
  const dt = opts.dt ?? Math.min(1e-3, Math.min(...tConstants) / 20);
  let capacity = Math.max(64, Math.ceil(opts.duration / dt) + 1);

  const channels: Channel[] = [
    ...channelsFor(sys.battery),
    ...sys.mechanisms.flatMap((m) => [
      ...channelsFor(m.motorBlock),
      ...m.gears.flatMap((g) => channelsFor(g)),
      ...channelsFor(m.solid),
      ...(m.controller ? channelsFor(m.controller) : []),
    ]),
  ];
  const data: Record<string, Float64Array> = {};
  for (const ch of channels) data[ch.key] = new Float64Array(capacity);
  let time = new Float64Array(capacity);

  /* Doubling growth. A live run has no known end, so the buffers cannot be
     sized up front -- but reallocating every step would be quadratic, and at
     1 kHz that shows up as stutter within seconds. */
  function grow() {
    capacity *= 2;
    for (const ch of channels) {
      const next = new Float64Array(capacity);
      next.set(data[ch.key]);
      data[ch.key] = next;
    }
    const t2 = new Float64Array(capacity);
    t2.set(time);
    time = t2;
  }

  let minBusVoltage = vOc;
  let peakTotalCurrent = 0;

  let i = 0;
  function stepOnce() {
    if (i >= capacity) grow();
    const t = i * dt;

    // ---- pass 1: each branch's controller, independent of the others -------
    const branchOut = branches.map((br) => {
      const { mech } = br;
      const ctrl = mech.controller;
      let duty: number;
      let pidErr = 0, pidP = 0, pidI = 0, pidD = 0, pidOut = 0;
      let bbErr = 0, bbOut = 0;
      let lqrPosErr = 0, lqrVelErr = 0, lqrOut = 0, lqrFF = 0;

      if (ctrl && ctrl.kind === 'pid') {
        const pid = ctrl;
        const meas = br.measure(br.theta, br.omega);
        pidErr = pid.target - meas;

        // Derivative on MEASUREMENT, not on error -- differentiating error
        // spikes the output the instant a setpoint changes.
        const dMeas = Number.isNaN(br.prevMeas) ? 0 : (meas - br.prevMeas) / dt;
        br.prevMeas = meas;

        pidP = pid.kP * pidErr;
        pidD = -pid.kD * dMeas;

        // Conditional integration: stop accumulating while output is pinned
        // and error would push it further into the rail -- the standard
        // anti-windup fix for a saturating actuator.
        const trial = pidP + pid.kI * (br.integral + pidErr * dt) + pidD + pid.kF;
        if (Math.abs(trial) < 1 || Math.sign(trial) !== Math.sign(pidErr)) {
          br.integral += pidErr * dt;
        }
        pidI = pid.kI * br.integral;

        pidOut = pidP + pidI + pidD + pid.kF;
        duty = pidOut;
      } else if (ctrl && ctrl.kind === 'bangbang') {
        const bb = ctrl;
        const meas = br.measure(br.theta, br.omega);
        bbErr = bb.target - meas;
        bbOut = bbErr > bb.deadband ? bb.output : bbErr < -bb.deadband ? -bb.output : 0;
        duty = bbOut;
      } else if (ctrl && ctrl.kind === 'lqr' && mech.lqrGains) {
        const lqr = ctrl;
        // LQR regulates a two-element state, so both components have to share
        // a consistent scale or the gain solve stops being valid. It works in
        // position units and position-units-per-second regardless of what the
        // velocity CHANNEL is set to display -- targetVel is in posUnit/s.
        const posMeas = br.theta * br.posScale;
        const velMeas = br.omega * br.posScale;
        lqrPosErr = lqr.targetPos - posMeas;
        lqrVelErr = lqr.targetVel - velMeas;

        if (lqr.gravityFeedforward) {
          const tauGrav = mech.gravityTorque(br.theta);
          const holdCurrent = tauGrav / (br.n * br.Kt * br.G * br.eta);
          lqrFF = (holdCurrent * br.R) / vOc;
        }

        lqrOut = mech.lqrGains.k1 * lqrPosErr + mech.lqrGains.k2 * lqrVelErr + lqrFF;
        duty = lqrOut;
      } else {
        duty = mech.motorBlock.duty;
      }

      const D = Math.max(-1, Math.min(1, duty));
      const omegaMotor = br.omega * br.G;
      // The motor sees D*V_bus across its windings, so its own current is
      //   I_motor = n*(D*V_bus - omega/Kv)/R
      // but the BATTERY only supplies D times that, by power conservation
      // through the H-bridge: V_bus*I_batt = (D*V_bus)*I_motor.
      //
      // Writing the battery-side draw as I_batt = A*V_bus - B therefore puts
      // D SQUARED in the A term, which is always non-negative. That matters:
      // using D directly lets A go negative on reverse duty, which can drive
      // the shared-bus denominator (1 + rBatt*sum A) through zero and invert
      // the whole solve.
      const A = (br.n * D * D) / br.R;
      const B = (br.n * D * omegaMotor) / (br.Kv * br.R);
      return { D, omegaMotor, A, B, pidErr, pidP, pidI, pidD, pidOut, bbErr, bbOut, lqrPosErr, lqrVelErr, lqrOut, lqrFF };
    });

    // ---- solve the shared bus: V_bus(1 + Rbatt*sum A) = Voc + Rbatt*sum B ---
    // sum A >= 0 always, so the denominator is >= 1 and this can never invert.
    let sumA = 0, sumB = 0;
    for (const o of branchOut) { sumA += o.A; sumB += o.B; }
    const busVoltage = (vOc + rBatt * sumB) / (1 + rBatt * sumA);

    // ---- pass 2: per-branch current, torque, and integration ---------------
    let totalCurrent = 0;
    for (let bi = 0; bi < branches.length; bi++) {
      const br = branches[bi];
      const { mech } = br;
      const o = branchOut[bi];

      // Motor current from the resolved bus. This is what a stator current
      // sensor reads, and what the current limit applies to.
      let iTotal = (br.n * (o.D * busVoltage - o.omegaMotor / br.Kv)) / br.R;
      const limit = br.n * mech.motorBlock.currentLimit;
      if (iTotal > limit) iTotal = limit;
      else if (iTotal < -limit) iTotal = -limit;
      // Battery-side draw is D times the motor current -- a motor at 20% duty
      // pulling 100 A from its controller only pulls about 20 A from the
      // battery, which is why a robot can run several mechanisms at once.
      totalCurrent += o.D * iTotal;

      const tauMotor = br.Kt * iTotal;
      const appliedVoltage = o.D * busVoltage;
      const tauGrav = mech.gravityTorque(br.theta);

      // Efficiency always opposes motion: eats motor torque while driving,
      // resists the gravity term while the load is overhauling the motor.
      const driving = tauMotor * br.omega >= 0;
      const tauDrive = driving ? tauMotor * br.G * br.eta : tauMotor * br.G;
      const tauGravEff = driving ? tauGrav : tauGrav * br.eta;

      let tauNet = tauDrive - tauGravEff;

      // Coulomb friction with a stiction band, so the mechanism can hold
      // still instead of chattering across zero.
      if (Math.abs(br.omega) > 1e-4) {
        tauNet -= mech.friction * Math.sign(br.omega);
      } else if (Math.abs(tauNet) <= mech.friction) {
        tauNet = 0;
      } else {
        tauNet -= mech.friction * Math.sign(tauNet);
      }

      const alpha = tauNet / br.jEff;

      // ---- record ------------------------------------------------------------
      data[`${mech.motorBlock.id}.current`][i] = iTotal;
      data[`${mech.motorBlock.id}.currentPerMotor`][i] = iTotal / br.n;
      data[`${mech.motorBlock.id}.appliedVoltage`][i] = appliedVoltage;
      data[`${mech.motorBlock.id}.torque`][i] = tauMotor;
      data[`${mech.motorBlock.id}.speed`][i] = o.omegaMotor;

      for (let k = 0; k < mech.gears.length; k++) {
        const g = mech.gears[k];
        const prev = k === 0 ? { ratio: 1, eff: 1 } : br.gearCum[k - 1];
        const cum = br.gearCum[k];
        data[`${g.id}.torqueIn`][i] = tauMotor * prev.ratio * prev.eff;
        data[`${g.id}.torqueOut`][i] = tauMotor * cum.ratio * cum.eff;
        data[`${g.id}.speedOut`][i] = o.omegaMotor / cum.ratio;
      }

      data[`${mech.solid.id}.position`][i] = br.theta * br.posScale;
      data[`${mech.solid.id}.velocity`][i] = br.omega * br.velScale;
      data[`${mech.solid.id}.acceleration`][i] = alpha * br.velScale;
      data[`${mech.solid.id}.gravityTorque`][i] = tauGrav;

      const ctrl = mech.controller;
      const pidLike = ctrl && (ctrl.kind === 'pid' || ctrl.kind === 'bangbang');
      if (pidLike) {
        const target = ctrl!.kind === 'pid' ? ctrl!.target : (ctrl as { target: number }).target;
        const err = ctrl!.kind === 'pid' ? o.pidErr : o.bbErr;
        const m = target - err;
        if (m < br.measMin) br.measMin = m;
        if (m > br.measMax) br.measMax = m;
        br.lastErr = err;

        const band = Math.max(Math.abs(target) * 0.02, 0.5);
        if (br.timeToTarget === null && Math.abs(err) <= band) br.timeToTarget = t;

        if (ctrl!.kind === 'pid') {
          data[`${ctrl!.id}.setpoint`][i] = ctrl!.target;
          data[`${ctrl!.id}.error`][i] = o.pidErr;
          data[`${ctrl!.id}.output`][i] = o.pidOut;
          data[`${ctrl!.id}.pTerm`][i] = o.pidP;
          data[`${ctrl!.id}.iTerm`][i] = o.pidI;
          data[`${ctrl!.id}.dTerm`][i] = o.pidD;
        } else {
          data[`${ctrl!.id}.setpoint`][i] = ctrl!.target;
          data[`${ctrl!.id}.error`][i] = o.bbErr;
          data[`${ctrl!.id}.output`][i] = o.bbOut;
        }
      } else if (ctrl && ctrl.kind === 'lqr' && mech.lqrGains) {
        const m = br.theta * br.posScale;
        if (m < br.measMin) br.measMin = m;
        if (m > br.measMax) br.measMax = m;
        br.lastErr = o.lqrPosErr;

        const band = Math.max(Math.abs(ctrl.targetPos) * 0.02, 0.5);
        if (br.timeToTarget === null && Math.abs(o.lqrPosErr) <= band && Math.abs(o.lqrVelErr) <= band) {
          br.timeToTarget = t;
        }

        data[`${ctrl.id}.posError`][i] = o.lqrPosErr;
        data[`${ctrl.id}.velError`][i] = o.lqrVelErr;
        data[`${ctrl.id}.output`][i] = o.lqrOut;
        data[`${ctrl.id}.feedforward`][i] = o.lqrFF;
        data[`${ctrl.id}.k1`][i] = mech.lqrGains.k1;
        data[`${ctrl.id}.k2`][i] = mech.lqrGains.k2;
      }

      if (Math.abs(iTotal) > Math.abs(br.peakCurrent)) br.peakCurrent = iTotal;

      // ---- integrate (semi-implicit: omega first, then theta) ----------------
      br.omega += alpha * dt;
      br.theta += br.omega * dt;
    }

    time[i] = t;
    data[`${sys.battery.id}.busVoltage`][i] = busVoltage;
    data[`${sys.battery.id}.totalCurrent`][i] = totalCurrent;
    if (busVoltage < minBusVoltage) minBusVoltage = busVoltage;
    if (Math.abs(totalCurrent) > Math.abs(peakTotalCurrent)) peakTotalCurrent = totalCurrent;
    i++;
  }

  function snapshot(): SimResult {
  const steps = i;
  const trim = (a: Float64Array) => a.subarray(0, steps);
  const trimmed: Record<string, Float64Array> = {};
  for (const ch of channels) trimmed[ch.key] = trim(data[ch.key]);

  const mechanisms: MechanismResult[] = branches.map((br, bi) => {
    const { mech } = br;
    const ctrl = mech.controller;
    const targetForOvershoot = ctrl ? (ctrl.kind === 'lqr' ? ctrl.targetPos : ctrl.target) : 0;
    return {
      motorId: mech.motorBlock.id, solidId: mech.solid.id,
      controllerId: ctrl?.id ?? null,
      timeConstant: tConstants[bi],
      linearDisplay: mech.linearDisplay,
      peakCurrent: br.peakCurrent,
      timeToTarget: br.timeToTarget,
      steadyStateError: ctrl ? br.lastErr : null,
      overshoot: ctrl
        ? (targetForOvershoot >= br.startMeas
            ? Math.max(0, br.measMax - targetForOvershoot)
            : Math.max(0, targetForOvershoot - br.measMin))
        : null,
    };
  });

  return {
    dt, steps, channels, data: trimmed, time: trim(time),
    minBusVoltage, peakCurrent: peakTotalCurrent, mechanisms,
  };
  }

  return {
    dt,
    get steps() { return i; },
    advance(n: number) {
      for (let k = 0; k < n; k++) stepOnce();
      return n;
    },
    snapshot,
  };
}

/** Batch helper: run to completion and return the finished result. */
export function simulate(sys: System, opts: SimOptions): SimResult {
  const run = createRun(sys, opts);
  run.advance(Math.ceil(opts.duration / run.dt) + 1);
  return run.snapshot();
}

/** Brownout reference lines for the voltage plot. */
export const BROWNOUT = { rioV2: 6.3, rioV1: 6.8 };

/** Downsample for plotting without hiding spikes: keeps min and max per bucket. */
export function decimate(x: Float64Array, y: Float64Array, target = 2000) {
  if (x.length <= target) return { x, y };
  const bucket = Math.ceil(x.length / (target / 2));
  const ox: number[] = [], oy: number[] = [];
  for (let i = 0; i < x.length; i += bucket) {
    const end = Math.min(i + bucket, x.length);
    let lo = i, hi = i;
    for (let k = i; k < end; k++) {
      if (y[k] < y[lo]) lo = k;
      if (y[k] > y[hi]) hi = k;
    }
    const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
    ox.push(x[a], x[b]); oy.push(y[a], y[b]);
  }
  return { x: Float64Array.from(ox), y: Float64Array.from(oy) };
}

export { G_ACCEL };
