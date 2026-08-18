/**
 * Compile step: walk the block graph and flatten it into the handful of numbers
 * the solver actually needs.
 *
 * Everything is simulated in the ROTATIONAL domain at the output shaft. A drum
 * does not contribute to the gear ratio -- instead it records a radius, and the
 * carriage mass becomes equivalent inertia J = m*r^2 with gravity torque m*g*r.
 * Metres only reappear at plot time. This is why the solver never needs to know
 * that linear motion exists.
 */

import {
  Block, BatteryBlock, MotorBlock, GearBlock, SolidBlock,
  ControllerBlock, LqrBlock, CONTROL_KINDS, Edge,
} from './blocks';
import { MotorConstants, getMotor } from './motors';

export const G_ACCEL = 9.80665;

/**
 * Closed-form continuous-time Riccati solution for a system of the exact shape
 * every mechanism in this tool produces: theta-dot = omega, omega-dot =
 * -a*omega + b*u. With Q = diag(q1, q2) and scalar R, the algebraic Riccati
 * equation reduces to one square root and one quadratic -- no matrix library,
 * no iteration, and it is exact (not an approximation) for this plant shape.
 */
function solveLqrGains(a: number, b: number, q1: number, q2: number, r: number) {
  const p12 = Math.sqrt((q1 * r)) / b;
  const p22 = (-a + Math.sqrt(a * a + (b * b / r) * (2 * p12 + q2))) / (b * b / r);
  const k1 = (b / r) * p12;
  const k2 = (b / r) * p22;
  return { k1, k2 };
}

export interface Compiled {
  battery: BatteryBlock;
  motorBlock: MotorBlock;
  motor: MotorConstants;
  gears: GearBlock[];
  solid: SolidBlock;

  ratio: number;        // G, cumulative reduction (drums excluded)
  efficiency: number;   // eta, cumulative
  radius: number | null; // drum radius, m -- null for pure rotational chains

  inertiaSolid: number; // kg-m^2 at the output shaft
  jEffOutput: number;   // inertiaSolid + rotor inertia reflected through G^2
  friction: number;     // N-m at the output shaft
  theta0: number;       // initial output-shaft angle, rad

  /** true when the terminal solid should be displayed in metres, not degrees. */
  linearDisplay: boolean;

  /** Gravity torque at the output shaft as a function of shaft angle. */
  gravityTorque: (theta: number) => number;

  /** Controller driving the motor's command port, if one is wired up. */
  controller: ControllerBlock | null;
  /** Channel key the controller measures its error from (PID / bang-bang only). */
  errorSource: string | null;
  /**
   * Precomputed LQR gains, if the controller is an LQR block. The plant is
   * linear and time-invariant, so the gains are solved once here rather than
   * every timestep.
   */
  lqrGains: { k1: number; k2: number; a: number; b: number } | null;
}

export class CompileError extends Error {
  /** The block responsible, when one can be pinpointed, for canvas highlighting. */
  blockId?: string;
  constructor(message: string, blockId?: string) {
    super(message);
    this.blockId = blockId;
  }
}

export function compile(blocks: Block[], edges: Edge[]): Compiled {
  const byId = new Map(blocks.map((b) => [b.id, b]));

  const battery = blocks.find((b): b is BatteryBlock => b.kind === 'battery');
  const motorBlock = blocks.find((b): b is MotorBlock => b.kind === 'motor');
  if (!battery) throw new CompileError('No battery block. Add one to power the motors.');
  if (!motorBlock) throw new CompileError('No motor block. The chain needs a source of torque.');

  // Walk the mechanical chain from the motor to a terminal solid block.
  const next = new Map<string, string>();
  for (const e of edges) {
    const src = byId.get(e.from.blockId);
    // Signal and control edges are not part of the mechanical chain.
    if (src && src.kind !== 'battery'
        && e.from.portId !== 'signal' && e.from.portId !== 'command') {
      next.set(e.from.blockId, e.to.blockId);
    }
  }

  const gears: GearBlock[] = [];
  let solid: SolidBlock | undefined;
  let cursor: string | undefined = next.get(motorBlock.id);
  const seen = new Set<string>([motorBlock.id]);

  while (cursor) {
    if (seen.has(cursor)) throw new CompileError('The mechanical chain contains a loop.', cursor);
    seen.add(cursor);
    const b = byId.get(cursor);
    if (!b) throw new CompileError(`Edge points at a block that does not exist: ${cursor}`);
    if (b.kind === 'gear') gears.push(b);
    else if (b.kind === 'solid') { solid = b; break; }
    else throw new CompileError(`A ${b.kind} block cannot sit inside the mechanical chain.`, cursor);
    cursor = next.get(cursor);
  }

  if (!solid) throw new CompileError('The chain does not end in a solid block.');

  // Accumulate ratio, efficiency, and drum radius.
  let ratio = 1;
  let efficiency = 1;
  let radius: number | null = null;

  for (const g of gears) {
    efficiency *= g.efficiency;
    const hasDrum = g.flavor === 'drum' || g.linearOutput;
    if (hasDrum) {
      if (radius !== null) throw new CompileError('Only one drum is supported per chain.', g.id);
      if (!g.radius || g.radius <= 0) throw new CompileError(`"${g.id}" needs a positive drum radius.`, g.id);
      radius = g.radius;
    }
    // A pure drum has no reduction of its own -- everything else (including a
    // gearbox or belt with its own drum option turned on) still contributes
    // its ratio, so one block can reduce AND convert to travel at once.
    if (g.flavor !== 'drum') {
      if (g.ratio <= 0) throw new CompileError(`Gear "${g.id}" needs a positive ratio.`, g.id);
      ratio *= g.ratio;
    }
  }

  // Resolve the solid block into inertia + a gravity torque function.
  let inertiaSolid: number;
  let gravityTorque: (theta: number) => number;

  switch (solid.gravityMode) {
    case 'none': {
      if (solid.inertia === undefined) {
        throw new CompileError(`Solid "${solid.id}" needs an inertia value.`, solid.id);
      }
      inertiaSolid = solid.inertia;
      gravityTorque = () => 0;
      break;
    }
    case 'constant': {
      if (radius === null) {
        throw new CompileError(
          `Solid "${solid.id}" has constant gravity (an elevator or climber), so the chain needs a drum block to convert rotation into linear travel.`,
          solid.id,
        );
      }
      const r = radius;
      inertiaSolid = solid.mass * r * r;
      const tg = solid.mass * G_ACCEL * r;
      gravityTorque = () => tg;
      break;
    }
    case 'angleDependent': {
      if (solid.inertia === undefined) {
        throw new CompileError(`Solid "${solid.id}" needs an inertia value.`, solid.id);
      }
      if (solid.cgRadius === undefined) {
        throw new CompileError(`Solid "${solid.id}" needs a centre-of-gravity radius.`, solid.id);
      }
      inertiaSolid = solid.inertia;
      const peak = solid.mass * G_ACCEL * solid.cgRadius;
      gravityTorque = (theta) => peak * Math.cos(theta);
      break;
    }
  }

  // --- controller -----------------------------------------------------------
  let controller: ControllerBlock | null = null;
  for (const e of edges) {
    if (e.to.blockId !== motorBlock.id || e.to.portId !== 'command') continue;
    const src = byId.get(e.from.blockId);
    if (src && CONTROL_KINDS.has(src.kind)) controller = src as ControllerBlock;
  }

  const n = motorBlock.count;
  const motor = getMotor(motorBlock.motorId);
  const jEffOutput = inertiaSolid + n * motor.spec.rotorInertia * ratio * ratio;

  let errorSource: string | null = null;
  let lqrGains: Compiled['lqrGains'] = null;

  if (controller && (controller.kind === 'pid' || controller.kind === 'bangbang')) {
    errorSource = controller.source ?? `${solid.id}.position`;
    // The controller runs at the TOP of a timestep, so it can only read values
    // that follow from shaft state. Current, voltage, and torque are solved
    // later in the same step; feeding one back here would create an algebraic
    // loop rather than a control loop.
    const readable = new Set([
      `${solid.id}.position`, `${solid.id}.velocity`, `${motorBlock.id}.speed`,
    ]);
    if (!readable.has(errorSource)) {
      throw new CompileError(
        `"${errorSource}" cannot be used as a controller error source. Controllers read shaft state, so pick a position or velocity channel.`,
        controller.id,
      );
    }
  }

  if (controller && controller.kind === 'lqr') {
    const lqr = controller as LqrBlock;
    if (lqr.qPos < 0 || lqr.qVel < 0) {
      throw new CompileError(`LQR "${lqr.id}" needs non-negative state costs.`, lqr.id);
    }
    if (lqr.qVel <= 0 || lqr.r <= 0) {
      throw new CompileError(
        `LQR "${lqr.id}" needs a positive velocity cost and control cost -- both are in the denominator of the gain solution.`,
        lqr.id,
      );
    }
    const posScale = solid.gravityMode === 'constant' ? radius! : (180 / Math.PI);
    // Linearized plant at the output shaft: theta-dot = omega,
    // omega-dot = -a*omega + b*duty. Derived from the same closed-form
    // current/torque relationship the solver uses, holding battery sag and
    // current limiting aside -- both are secondary effects the regulator does
    // not need to see to compute a stabilizing gain.
    const a = (n * motor.Kt * ratio * ratio * efficiency) / (motor.Kv * motor.R * jEffOutput);
    const b = ((n * motor.Kt * ratio * efficiency * battery.vOc) / (motor.R * jEffOutput)) * posScale;
    const { k1, k2 } = solveLqrGains(a, b, lqr.qPos, lqr.qVel, lqr.r);
    lqrGains = { k1, k2, a, b };
  }

  const linearDisplay = solid.gravityMode === 'constant';
  // initialPosition is given in DISPLAY units -- metres for linear chains,
  // degrees for rotational -- matching how results are plotted.
  const theta0 = linearDisplay
    ? solid.initialPosition / radius!
    : (solid.initialPosition * Math.PI) / 180;

  return {
    battery, motorBlock, motor, gears, solid,
    ratio, efficiency, radius, inertiaSolid, jEffOutput,
    friction: solid.friction, theta0, linearDisplay, gravityTorque,
    controller, errorSource, lqrGains,
  };
}

/** Convenience constructors so common inertias do not have to be looked up. */
export const inertia = {
  /** Solid disc / flywheel about its centre. */
  disc: (mass: number, radius: number) => 0.5 * mass * radius * radius,
  /** Uniform rod about one end -- a bare arm. */
  rodAboutEnd: (mass: number, length: number) => (mass * length * length) / 3,
  /** Point mass at a distance -- a game piece on the end of an arm. */
  pointMass: (mass: number, radius: number) => mass * radius * radius,
};
