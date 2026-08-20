/**
 * Block schemas and the port type system.
 *
 * Port shape encodes type, and the shape is a mnemonic:
 *   circle   -> rotational (N-m, rad/s)   round because it rotates
 *   square   -> linear     (N, m/s)       flat because it travels
 *   triangle -> electrical (V, A)
 *   hexagon  -> signal     (measurement, read-only)
 *   bar      -> control    (commanded duty, -1..1)
 *
 * The first three carry POWER and participate in the physics. Hexagon carries
 * MEASUREMENT: it does not affect the sim, has no cardinality limit, and can be
 * added or removed without re-running anything.
 *
 * The bar carries COMMAND, and it is the one that closes a loop. A controller
 * reads a measurement through a hexagon and drives a motor through a bar, so
 * the sim stops being a straight line through the graph -- the controller runs
 * inside every timestep, between reading state and computing torque.
 */

/*
 * A sixth type: mount. Unlike the other five, it carries neither power nor
 * measurement -- it's a structural claim ("this solid is attached here"),
 * which is why it gets a visually distinct treatment: a large gray square,
 * not part of the warm/cool palette the physical types use. Gray reads as
 * "structure," the same way it does on the mechanism box border.
 */
export type PortType = 'rotational' | 'linear' | 'electrical' | 'signal' | 'control' | 'mount';

export const PORT_SHAPE: Record<PortType, string> = {
  rotational: 'circle',
  linear: 'square',
  electrical: 'triangle',
  signal: 'hexagon',
  control: 'bar',
  mount: 'bigsquare',
};

export const PORT_UNITS: Record<PortType, string> = {
  rotational: 'N-m, rad/s',
  linear: 'N, m/s',
  mount: 'attachment reference',
  electrical: 'V, A',
  signal: 'varies by channel',
  control: 'duty cycle, -1..1',
};

export interface Port {
  id: string;
  type: PortType;
  direction: 'in' | 'out';
}

// --- Block definitions ------------------------------------------------------

export interface BatteryBlock {
  kind: 'battery';
  id: string;
  vOc: number;      // open-circuit voltage, V (12.6 fresh, ~12.0 mid-match)
  rBatt: number;    // internal resistance, ohms (~0.015-0.020)
  rBranch: number;  // wire + breaker resistance, ohms (~0.002)
}

export interface MotorBlock {
  kind: 'motor';
  id: string;
  motorId: string;   // key into MOTORS
  count: number;     // n motors on one shaft -- NOT n separate blocks
  /**
   * Duty cycle, -1..1. Settable from a signal in v2 (controller block), which
   * is why it is a field on the block rather than a constant in the solver.
   */
  duty: number;
  currentLimit: number; // per-motor stator limit, A
}

export type GearFlavor = 'gearbox' | 'belt' | 'drum';

export interface GearBlock {
  kind: 'gear';
  id: string;
  flavor: GearFlavor;
  ratio: number;        // reduction, output turns slower by this factor
  efficiency: number;   // 0..1 per stage (~0.95 spur, ~0.98 belt)
  /** Drum/pinion pitch radius in metres. Required iff flavor === 'drum'. */
  radius?: number;
  /**
   * A gearbox or belt stage can also carry its own drum, so one block does the
   * reduction AND the rotation-to-travel conversion instead of needing a
   * second block downstream. Ignored when flavor === 'drum', which is already
   * a pure conversion with no reduction of its own.
   */
  linearOutput?: boolean;
}

export type GravityMode = 'none' | 'constant' | 'angleDependent';

export interface SolidBlock {
  kind: 'solid';
  id: string;
  gravityMode: GravityMode;
  mass: number;         // kg
  /**
   * Moment of inertia about the axis of rotation, kg-m^2.
   * Required for 'none' and 'angleDependent'. For 'constant' (elevator) it is
   * derived from mass and the drum radius: J = m*r^2.
   */
  inertia?: number;
  /** Distance from pivot to centre of gravity, m. Required for 'angleDependent'. */
  cgRadius?: number;
  /**
   * Distance from pivot to this solid's tip (its mount point), m. Only
   * required when a joint actually mounts something here -- an ordinary
   * unjointed solid never needs it. Irrelevant for 'constant' (elevator)
   * solids, which reflect a mounted child's mass through their own drum
   * radius instead, the same way they reflect their own.
   */
  tipRadius?: number;
  /** Coulomb friction torque at the output shaft, N-m. */
  friction: number;
  /**
   * Display units for this mechanism's position and velocity channels. The
   * solver never sees these -- they only affect what channels report, what a
   * controller setpoint is written in, and how a chart is labelled.
   * Defaults: deg / deg-per-second rotational, m / m-per-second linear.
   */
  positionUnit?: string;
  velocityUnit?: string;
  /**
   * Starting position in DISPLAY units: degrees for rotational chains
   * (0 = horizontal for an arm), metres for linear ones.
   */
  initialPosition: number;
}

/**
 * Controllers are their own category: they consume a measurement and emit a
 * command. PID is the first one; bang-bang, feedforward, and profiled motion
 * would all slot in beside it with the same two ports.
 */
export interface PidBlock {
  kind: 'pid';
  id: string;
  /**
   * Channel key the error is measured from, e.g. "arm1.position". Populated
   * from whatever is wired into the hex input; falls back to the terminal
   * solid's position when nothing is connected.
   */
  source: string | null;
  /** Setpoint in the SAME display units as the source channel (deg, m, rad/s). */
  target: number;
  kP: number;
  kI: number;
  kD: number;
  /**
   * Constant feedforward added to the output, in duty. For an arm this is what
   * holds position against gravity without leaning on the integral term.
   */
  kF: number;
}

export type ControllerBlock = PidBlock | BangBangBlock | LqrBlock;

/**
 * Bang-bang: full output in whichever direction closes the error, nothing in
 * a deadband around the target. Cheap, chattery, and a useful contrast to PID
 * -- some FRC mechanisms (a simple intake roller) are tuned this way on purpose.
 */
export interface BangBangBlock {
  kind: 'bangbang';
  id: string;
  source: string | null;
  target: number;
  /** Output magnitude, 0..1. Applied as +output or -output, never in between. */
  output: number;
  /** Half-width of the dead zone around target, in the source channel's units. */
  deadband: number;
}

/**
 * LQR regulates the full state (position AND velocity) at once, unlike PID
 * which only ever sees one channel. Because it needs both, it does not use the
 * 'source' pattern -- it reads the terminal solid's shaft state directly, which
 * is unambiguous in v1 since a graph has exactly one mechanical chain.
 *
 * The plant is derived automatically from the compiled chain (motor constants,
 * ratio, efficiency, effective inertia) rather than asked of the user, and the
 * gains are the closed-form solution of the continuous Riccati equation for
 * this specific system shape (a zero-inertia integrator chain: theta-dot =
 * omega, omega-dot = -a*omega + b*duty). Setting qPos to 0 degrades gracefully
 * into pure velocity regulation, which is exactly what a flywheel wants.
 */
export interface LqrBlock {
  kind: 'lqr';
  id: string;
  /** State cost on position error. 0 disables position regulation entirely. */
  qPos: number;
  /** State cost on velocity error. */
  qVel: number;
  /** Control effort cost. Larger means gentler, lower-current control. */
  r: number;
  targetPos: number;
  targetVel: number;
  /**
   * Cancel gravity torque with a computed feedforward before the state-feedback
   * term is added. Only meaningful when the plant has a gravity load.
   */
  gravityFeedforward: boolean;
}

/** Blocks that command the physics rather than being part of it. */
export const CONTROL_KINDS: ReadonlySet<string> = new Set(['pid', 'bangbang', 'lqr']);

export type JointType = 'revolute' | 'prismatic';

/**
 * Connects a parent solid's tip to a child solid's mount, forming a
 * multi-joint chain (an arm carrying a wrist). Carries no physics of its own
 * -- the child has its own independent motor, gear, and solid, exactly like
 * any other mechanism. The joint is purely a structural claim: WHICH solid
 * this one is attached to, and what kind of attachment that is.
 *
 * jointType constrains what the CHILD can physically be:
 *   revolute  -- the child pivots, so it must be a rotating solid
 *                (gravityMode 'angleDependent' or 'none': an arm or flywheel)
 *   prismatic -- the child slides, so it must be a linear solid
 *                (gravityMode 'constant': an elevator)
 * The parent's own type is unconstrained -- an elevator can carry a pivoting
 * arm, and an arm can carry a telescoping slide, both are real mechanisms.
 */
export interface JointBlock {
  kind: 'joint';
  id: string;
  jointType: JointType;
}

export type Block =
  | BatteryBlock | MotorBlock | GearBlock | SolidBlock | ControllerBlock | JointBlock;

// --- Signal channels --------------------------------------------------------

export interface Channel {
  key: string;   // "motor1.current"
  label: string;
  unit: string;
  /** Unit family, used to decide when the plotter needs a second Y axis. */
  family:
    | 'current' | 'voltage' | 'torque' | 'angle' | 'angularRate'
    | 'length' | 'linearRate' | 'time'
    | 'setpoint' | 'error' | 'duty' | 'gain';
}

/** Which measurements a block exposes through its single hexagon port. */
export function channelsFor(block: Block): Channel[] {
  const p = (suffix: string) => `${block.id}.${suffix}`;
  switch (block.kind) {
    case 'battery':
      return [
        { key: p('busVoltage'), label: 'Bus voltage', unit: 'V', family: 'voltage' },
        { key: p('totalCurrent'), label: 'Total current', unit: 'A', family: 'current' },
      ];
    case 'motor':
      return [
        { key: p('current'), label: 'Current (total)', unit: 'A', family: 'current' },
        { key: p('currentPerMotor'), label: 'Current per motor', unit: 'A', family: 'current' },
        { key: p('appliedVoltage'), label: 'Applied voltage', unit: 'V', family: 'voltage' },
        { key: p('torque'), label: 'Torque', unit: 'N-m', family: 'torque' },
        { key: p('speed'), label: 'Rotor speed', unit: 'rad/s', family: 'angularRate' },
      ];
    case 'gear':
      return [
        { key: p('torqueIn'), label: 'Torque in', unit: 'N-m', family: 'torque' },
        { key: p('torqueOut'), label: 'Torque out', unit: 'N-m', family: 'torque' },
        { key: p('speedOut'), label: 'Speed out', unit: 'rad/s', family: 'angularRate' },
      ];
    case 'pid':
      return [
        { key: p('setpoint'), label: 'Setpoint', unit: '', family: 'setpoint' },
        { key: p('error'), label: 'Error', unit: '', family: 'error' },
        { key: p('output'), label: 'Output (duty)', unit: '', family: 'duty' },
        { key: p('pTerm'), label: 'P term', unit: '', family: 'duty' },
        { key: p('iTerm'), label: 'I term', unit: '', family: 'duty' },
        { key: p('dTerm'), label: 'D term', unit: '', family: 'duty' },
      ];
    case 'bangbang':
      return [
        { key: p('setpoint'), label: 'Setpoint', unit: '', family: 'setpoint' },
        { key: p('error'), label: 'Error', unit: '', family: 'error' },
        { key: p('output'), label: 'Output (duty)', unit: '', family: 'duty' },
      ];
    case 'lqr':
      return [
        { key: p('posError'), label: 'Position error', unit: '', family: 'error' },
        { key: p('velError'), label: 'Velocity error', unit: '', family: 'error' },
        { key: p('output'), label: 'Output (duty)', unit: '', family: 'duty' },
        { key: p('feedforward'), label: 'Gravity feedforward', unit: '', family: 'duty' },
        { key: p('k1'), label: 'K (position gain)', unit: '', family: 'gain' },
        { key: p('k2'), label: 'K (velocity gain)', unit: '', family: 'gain' },
      ];
    case 'solid': {
      const linear = block.gravityMode === 'constant';
      const posUnit = block.positionUnit ?? (linear ? 'm' : 'deg');
      const velUnit = block.velocityUnit ?? (linear ? 'm/s' : 'deg/s');
      return [
        { key: p('position'), label: 'Position', unit: posUnit, family: linear ? 'length' : 'angle' },
        { key: p('velocity'), label: 'Velocity', unit: velUnit, family: linear ? 'linearRate' : 'angularRate' },
        { key: p('acceleration'), label: 'Acceleration', unit: `${velUnit}²`, family: linear ? 'linearRate' : 'angularRate' },
        { key: p('gravityTorque'), label: 'Gravity torque', unit: 'N-m', family: 'torque' },
      ];
    }
    case 'joint':
      return [];
  }
}

// --- Connection validation --------------------------------------------------

export interface Edge {
  from: { blockId: string; portId: string };
  to: { blockId: string; portId: string };
}

/**
 * The rule React Flow's isValidConnection hook wants. Power ports are strictly
 * one-to-one; signal ports are unconstrained because they do not affect physics.
 */
export function canConnect(
  out: Port,
  inp: Port,
  inputOccupied: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (out.direction !== 'out' || inp.direction !== 'in') {
    return { ok: false, reason: 'Connections run from an output to an input.' };
  }
  if (out.type !== inp.type) {
    return {
      ok: false,
      reason: `A ${PORT_SHAPE[out.type]} port cannot drive a ${PORT_SHAPE[inp.type]} port.`,
    };
  }
  if (out.type !== 'signal' && inputOccupied) {
    return { ok: false, reason: 'That input is already connected.' };
  }
  return { ok: true };
}

/** Ports a block exposes, in canvas order. */
export function portsFor(block: Block): Port[] {
  const sig: Port = { id: 'signal', type: 'signal', direction: 'out' };
  switch (block.kind) {
    case 'battery':
      return [{ id: 'out', type: 'electrical', direction: 'out' }, sig];
    case 'motor':
      return [
        { id: 'power', type: 'electrical', direction: 'in' },
        { id: 'command', type: 'control', direction: 'in' },
        { id: 'out', type: 'rotational', direction: 'out' },
        sig,
      ];
    case 'gear': {
      const linear = block.flavor === 'drum' || block.linearOutput;
      return [
        { id: 'in', type: 'rotational', direction: 'in' },
        { id: 'out', type: linear ? 'linear' : 'rotational', direction: 'out' },
        sig,
      ];
    }
    case 'solid':
      return [
        { id: 'in', type: block.gravityMode === 'constant' ? 'linear' : 'rotational', direction: 'in' },
        // Every solid can be a joint's child (mount, in) or a joint's parent
        // (tip, out), regardless of configuration -- unlike the mechanical
        // ports, which vary port TYPE by flavor, these are uniform because
        // a joint's own type is what carries the compatibility constraint.
        { id: 'mount', type: 'mount', direction: 'in' },
        { id: 'tip', type: 'mount', direction: 'out' },
        sig,
      ];
    case 'joint':
      return [
        { id: 'parent', type: 'mount', direction: 'in' },
        { id: 'child', type: 'mount', direction: 'out' },
      ];
    case 'pid':
    case 'bangbang':
      return [
        { id: 'measure', type: 'signal', direction: 'in' },
        { id: 'command', type: 'control', direction: 'out' },
        sig,
      ];
    case 'lqr':
      return [
        // LQR reads BOTH position and velocity of the same shaft, so its
        // measure input is just a presence check -- wiring anything from the
        // terminal solid confirms which mechanism it is regulating.
        { id: 'measure', type: 'signal', direction: 'in' },
        { id: 'command', type: 'control', direction: 'out' },
        sig,
      ];
  }
}
