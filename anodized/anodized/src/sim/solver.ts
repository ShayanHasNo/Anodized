/**
 * Discrete forward simulation.
 *
 * Each timestep runs four phases in a fixed order:
 *   1. read state      -- shaft angle and speed
 *   2. evaluate signals -- no-op in v1; the controller block plugs in here in v2
 *   3. compute torque   -- closed-form electrical model, then the torque balance
 *   4. integrate        -- semi-implicit Euler
 *
 * Phase 2 exists now precisely so that adding a controller later does not mean
 * restructuring the loop.
 */

import { Compiled, G_ACCEL } from './compile';
import { Channel, channelsFor } from './blocks';

const RAD_TO_DEG = 180 / Math.PI;

export interface SimOptions {
  duration: number;      // seconds
  dt?: number;           // override the auto-selected timestep
  /** Stop early once the output reaches this position (rad or m, display units). */
  stopAtPosition?: number;
}

export interface SignalPhase {
  (t: number, state: { theta: number; omega: number; busVoltage: number }): { duty: number };
}

export interface SimResult {
  dt: number;
  timeConstant: number;
  steps: number;
  channels: Channel[];
  /** Columnar data, keyed by channel key. Every channel is recorded, always. */
  data: Record<string, Float64Array>;
  time: Float64Array;
  linearDisplay: boolean;
  /** Time to reach stopAtPosition, or null if never reached. */
  timeToTarget: number | null;
  minBusVoltage: number;
  peakCurrent: number;
  /** Error remaining at the end of the run, in the source channel's units. */
  steadyStateError: number | null;
  /** How far past the setpoint the mechanism travelled, same units. */
  overshoot: number | null;
}

/**
 * Mechanical time constant, reflected to the motor shaft. A high-ratio,
 * low-inertia mechanism can push this under 5 ms, which is why dt is derived
 * from it rather than fixed.
 */
export function timeConstant(c: Compiled): number {
  const n = c.motorBlock.count;
  const jReflected = c.inertiaSolid / (c.ratio * c.ratio) + n * c.motor.spec.rotorInertia;
  return (jReflected * c.motor.R) / (n * c.motor.Kt * c.motor.Ke);
}

export function simulate(
  c: Compiled,
  opts: SimOptions,
  signalPhase?: SignalPhase,
): SimResult {
  const n = c.motorBlock.count;
  const { R, Kt, Kv } = c.motor;
  const G = c.ratio;
  const eta = c.efficiency;
  const vOc = c.battery.vOc;
  const rBatt = c.battery.rBatt + c.battery.rBranch;

  const tauM = timeConstant(c);
  const dt = opts.dt ?? Math.min(1e-3, tauM / 20);
  const maxSteps = Math.ceil(opts.duration / dt) + 1;

  // Effective inertia at the output shaft, precomputed in the compile step so
  // an LQR controller can size its gains against the same number the physics
  // uses. Includes rotor inertia reflected UP through the ratio -- the term a
  // naive left-to-right evaluator drops, which makes high-ratio mechanisms
  // look far too quick.
  const jEff = c.jEffOutput;

  // Per-gear cumulative ratios, so each gear can report its own torque and speed.
  const gearCum: { ratio: number; eff: number }[] = [];
  {
    let r = 1, e = 1;
    for (const g of c.gears) {
      e *= g.efficiency;
      if (g.flavor !== 'drum') r *= g.ratio;
      gearCum.push({ ratio: r, eff: e });
    }
  }

  const channels: Channel[] = [
    ...channelsFor(c.battery),
    ...channelsFor(c.motorBlock),
    ...c.gears.flatMap((g) => channelsFor(g)),
    ...channelsFor(c.solid),
    ...(c.controller ? channelsFor(c.controller) : []),
  ];
  const data: Record<string, Float64Array> = {};
  for (const ch of channels) data[ch.key] = new Float64Array(maxSteps);
  const time = new Float64Array(maxSteps);

  // --- controller setup ----------------------------------------------------
  const ctrl = c.controller;
  const posScale = c.linearDisplay ? c.radius! : RAD_TO_DEG;

  /** Reads the error source from shaft state, in the source channel's units. */
  const measure = (theta: number, omega: number): number => {
    if (!c.errorSource) return 0;
    if (c.errorSource === `${c.motorBlock.id}.speed`) return omega * G;
    if (c.errorSource.endsWith('.velocity')) return omega * posScale;
    return theta * posScale;
  };

  let integral = 0;
  let prevMeas = NaN;
  let measMin = Infinity, measMax = -Infinity;
  let lastErr = 0;
  const pidLike = ctrl && (ctrl.kind === 'pid' || ctrl.kind === 'bangbang');
  const startMeas = ctrl ? c.theta0 * posScale : 0;

  let theta = c.theta0;
  let omega = 0;
  let alpha = 0;
  let busVoltage = vOc;
  let minBusVoltage = vOc;
  let peakCurrent = 0;
  let timeToTarget: number | null = null;

  const targetTheta = opts.stopAtPosition === undefined
    ? null
    : (c.linearDisplay ? opts.stopAtPosition / c.radius! : opts.stopAtPosition / RAD_TO_DEG);

  let i = 0;
  for (; i < maxSteps; i++) {
    const t = i * dt;

    // --- phase 2: signals and control ---------------------------------------
    let duty: number;
    let pidErr = 0, pidP = 0, pidI = 0, pidD = 0, pidOut = 0;
    let bbErr = 0, bbOut = 0;
    let lqrPosErr = 0, lqrVelErr = 0, lqrOut = 0, lqrFF = 0;

    if (ctrl && ctrl.kind === 'pid') {
      const pid = ctrl;
      const meas = measure(theta, omega);
      pidErr = pid.target - meas;

      // Derivative on MEASUREMENT, not on error. Differentiating the error term
      // makes the output spike the instant a setpoint changes, which is a real
      // problem on hardware and a confusing one to debug in a sim.
      const dMeas = Number.isNaN(prevMeas) ? 0 : (meas - prevMeas) / dt;
      prevMeas = meas;

      pidP = pid.kP * pidErr;
      pidD = -pid.kD * dMeas;

      // Conditional integration: stop accumulating while the output is pinned
      // and the error would push it further into the rail. Without this an arm
      // that saturates on the way up carries a huge integral past the setpoint
      // and overshoots badly -- the classic windup failure.
      const trial = pidP + pid.kI * (integral + pidErr * dt) + pidD + pid.kF;
      if (Math.abs(trial) < 1 || Math.sign(trial) !== Math.sign(pidErr)) {
        integral += pidErr * dt;
      }
      pidI = pid.kI * integral;

      pidOut = pidP + pidI + pidD + pid.kF;
      duty = pidOut;
    } else if (ctrl && ctrl.kind === 'bangbang') {
      const bb = ctrl;
      const meas = measure(theta, omega);
      bbErr = bb.target - meas;
      bbOut = bbErr > bb.deadband ? bb.output : bbErr < -bb.deadband ? -bb.output : 0;
      duty = bbOut;
    } else if (ctrl && ctrl.kind === 'lqr' && c.lqrGains) {
      const lqr = ctrl;
      const posMeas = theta * posScale;
      const velMeas = omega * posScale;
      lqrPosErr = lqr.targetPos - posMeas;
      lqrVelErr = lqr.targetVel - velMeas;

      if (lqr.gravityFeedforward) {
        // Duty needed to hold the shaft still against gravity at this angle:
        // solve tau_gravity = n*Kt*I*G*eta for I, then I = V/R at zero speed.
        const tauGrav = c.gravityTorque(theta);
        const holdCurrent = tauGrav / (n * Kt * G * eta);
        lqrFF = (holdCurrent * R) / vOc;
      }

      lqrOut = c.lqrGains.k1 * lqrPosErr + c.lqrGains.k2 * lqrVelErr + lqrFF;
      duty = lqrOut;
    } else if (signalPhase) {
      duty = signalPhase(t, { theta, omega, busVoltage }).duty;
    } else {
      duty = c.motorBlock.duty;
    }

    const D = Math.max(-1, Math.min(1, duty));

    // --- phase 3: torque ----------------------------------------------------
    const omegaMotor = omega * G;

    // Closed-form solution of the sag/current circular dependency. Current
    // depends on bus voltage and bus voltage sags with current, but the
    // relationship is linear, so no iteration is needed.
    const denom = R + n * Math.abs(D) * rBatt;
    let iTotal = (n * (D * vOc - omegaMotor / Kv)) / denom;

    const limit = n * c.motorBlock.currentLimit;
    if (iTotal > limit) iTotal = limit;
    else if (iTotal < -limit) iTotal = -limit;

    const tauMotor = Kt * iTotal;
    busVoltage = vOc - iTotal * rBatt;
    const appliedVoltage = D * busVoltage;

    const tauGrav = c.gravityTorque(theta);

    // Efficiency always opposes motion. When the motor drives, it eats motor
    // torque; when the load overhauls (an arm falling), it resists the fall
    // instead, so it is applied to the gravity term.
    const driving = tauMotor * omega >= 0;
    const tauDrive = driving ? tauMotor * G * eta : tauMotor * G;
    const tauGravEff = driving ? tauGrav : tauGrav * eta;

    let tauNet = tauDrive - tauGravEff;

    // Coulomb friction with a stiction band, so the mechanism can actually hold
    // still instead of chattering across zero.
    if (Math.abs(omega) > 1e-4) {
      tauNet -= c.friction * Math.sign(omega);
    } else if (Math.abs(tauNet) <= c.friction) {
      tauNet = 0;
    } else {
      tauNet -= c.friction * Math.sign(tauNet);
    }

    alpha = tauNet / jEff;

    // --- record -------------------------------------------------------------
    time[i] = t;
    data[`${c.battery.id}.busVoltage`][i] = busVoltage;
    data[`${c.battery.id}.totalCurrent`][i] = iTotal;
    data[`${c.motorBlock.id}.current`][i] = iTotal;
    data[`${c.motorBlock.id}.currentPerMotor`][i] = iTotal / n;
    data[`${c.motorBlock.id}.appliedVoltage`][i] = appliedVoltage;
    data[`${c.motorBlock.id}.torque`][i] = tauMotor;
    data[`${c.motorBlock.id}.speed`][i] = omegaMotor;

    for (let k = 0; k < c.gears.length; k++) {
      const g = c.gears[k];
      const prev = k === 0 ? { ratio: 1, eff: 1 } : gearCum[k - 1];
      const cum = gearCum[k];
      data[`${g.id}.torqueIn`][i] = tauMotor * prev.ratio * prev.eff;
      data[`${g.id}.torqueOut`][i] = tauMotor * cum.ratio * cum.eff;
      data[`${g.id}.speedOut`][i] = omegaMotor / cum.ratio;
    }

    const scale = c.linearDisplay ? c.radius! : RAD_TO_DEG;
    data[`${c.solid.id}.position`][i] = theta * scale;
    data[`${c.solid.id}.velocity`][i] = omega * scale;
    data[`${c.solid.id}.acceleration`][i] = alpha * scale;
    data[`${c.solid.id}.gravityTorque`][i] = tauGrav;

    if (pidLike) {
      const target = ctrl!.kind === 'pid' ? ctrl!.target : (ctrl as { target: number }).target;
      const err = ctrl!.kind === 'pid' ? pidErr : bbErr;
      const m = target - err;
      if (m < measMin) measMin = m;
      if (m > measMax) measMax = m;
      lastErr = err;

      // With a controller, "reached" means inside a tolerance band rather than
      // crossing a line -- a loop that overshoots and comes back has still
      // arrived, and one that creeps up short never does.
      const band = Math.max(Math.abs(target) * 0.02, 0.5);
      if (timeToTarget === null && Math.abs(err) <= band) timeToTarget = t;

      if (ctrl!.kind === 'pid') {
        data[`${ctrl!.id}.setpoint`][i] = ctrl!.target;
        data[`${ctrl!.id}.error`][i] = pidErr;
        data[`${ctrl!.id}.output`][i] = pidOut;
        data[`${ctrl!.id}.pTerm`][i] = pidP;
        data[`${ctrl!.id}.iTerm`][i] = pidI;
        data[`${ctrl!.id}.dTerm`][i] = pidD;
      } else {
        data[`${ctrl!.id}.setpoint`][i] = ctrl!.target;
        data[`${ctrl!.id}.error`][i] = bbErr;
        data[`${ctrl!.id}.output`][i] = bbOut;
      }
    } else if (ctrl && ctrl.kind === 'lqr' && c.lqrGains) {
      const m = theta * posScale;
      if (m < measMin) measMin = m;
      if (m > measMax) measMax = m;
      lastErr = lqrPosErr;

      const band = Math.max(Math.abs(ctrl.targetPos) * 0.02, 0.5);
      if (timeToTarget === null && Math.abs(lqrPosErr) <= band && Math.abs(lqrVelErr) <= band) {
        timeToTarget = t;
      }

      data[`${ctrl.id}.posError`][i] = lqrPosErr;
      data[`${ctrl.id}.velError`][i] = lqrVelErr;
      data[`${ctrl.id}.output`][i] = lqrOut;
      data[`${ctrl.id}.feedforward`][i] = lqrFF;
      data[`${ctrl.id}.k1`][i] = c.lqrGains.k1;
      data[`${ctrl.id}.k2`][i] = c.lqrGains.k2;
    }

    if (busVoltage < minBusVoltage) minBusVoltage = busVoltage;
    if (Math.abs(iTotal) > Math.abs(peakCurrent)) peakCurrent = iTotal;
    if (!ctrl && timeToTarget === null && targetTheta !== null && theta >= targetTheta) {
      timeToTarget = t;
    }

    // --- phase 4: integrate (semi-implicit: omega first, then theta) --------
    omega += alpha * dt;
    theta += omega * dt;
  }

  const steps = i;
  const trim = (a: Float64Array) => a.subarray(0, steps);
  const trimmed: Record<string, Float64Array> = {};
  for (const ch of channels) trimmed[ch.key] = trim(data[ch.key]);

  const targetForOvershoot = ctrl
    ? (ctrl.kind === 'lqr' ? ctrl.targetPos : ctrl.target)
    : 0;

  return {
    dt, timeConstant: tauM, steps, channels,
    data: trimmed, time: trim(time),
    linearDisplay: c.linearDisplay,
    timeToTarget, minBusVoltage, peakCurrent,
    steadyStateError: ctrl ? lastErr : null,
    overshoot: ctrl
      ? (targetForOvershoot >= startMeas
          ? Math.max(0, measMax - targetForOvershoot)
          : Math.max(0, targetForOvershoot - measMin))
      : null,
  };
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
