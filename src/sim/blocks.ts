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
/*
 * Two more types for the programming layer, and the same mnemonic rule:
 *
 *   pentagon -> sense   ("this watches a solid")
 *   diamond  -> boolean ("this carries a true/false")
 *
 * The split is deliberate. A sensor has BOTH: a pentagon into the solid it
 * observes, and a diamond out toward the logic that uses it. Shape therefore
 * always answers "what does this connect to" rather than "which block owns
 * it" -- a diamond means boolean whether it sits on a sensor, an if block, or
 * a manual trigger, so a wire's legality is readable without knowing either
 * end's block type. Diamond is the traditional flowchart decision shape, which
 * is free prior knowledge for anyone who has seen one.
 */
export type PortType =
  | 'rotational' | 'linear' | 'electrical' | 'signal' | 'control' | 'mount'
  | 'sense' | 'boolean';

export const PORT_SHAPE: Record<PortType, string> = {
  rotational: 'circle',
  linear: 'square',
  electrical: 'triangle',
  signal: 'hexagon',
  control: 'bar',
  mount: 'bigsquare',
  sense: 'pentagon',
  boolean: 'diamond',
};

export const PORT_UNITS: Record<PortType, string> = {
  rotational: 'N-m, rad/s',
  linear: 'N, m/s',
  mount: 'attachment reference',
  electrical: 'V, A',
  signal: 'varies by channel',
  control: 'duty cycle, -1..1',
  sense: 'observes a solid',
  boolean: 'true / false',
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

export type ControllerBlock = PidBlock | BangBangBlock | LqrBlock | VoltageBlock;

/**
 * Voltage: the one controller with no feedback at all. It commands a fixed
 * number of VOLTS at the motor, and the duty needed to produce them follows
 * from the bus: duty = V_command / V_bus.
 *
 * That division is the entire point, and it is why this is not the same thing
 * as typing a duty into the motor block. A duty of 0.5 means half of whatever
 * the bus happens to be -- 6.3 V on a fresh battery, 5.5 V once four
 * mechanisms are pulling it down, so the mechanism gets weaker exactly when
 * the rest of the robot gets busy. A voltage command holds 6 V through the
 * sag by raising duty to compensate, which is what WPILib's setVoltage() does
 * and why feedforward gains (kS, kV, kA) are published in volts rather than
 * duty. Commanding more volts than the bus can supply saturates at full duty,
 * the same as the real thing.
 */
export interface VoltageBlock {
  kind: 'voltage';
  id: string;
  /** Commanded motor voltage, signed. Negative drives the other way. */
  volts: number;
}

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
export const CONTROL_KINDS: ReadonlySet<string> = new Set(['pid', 'bangbang', 'lqr', 'voltage']);

export type JointType = 'revolute' | 'prismatic';

/**
 * A named set of controller targets -- "stowed", "scoring", "intake". The
 * targets map is keyed by controller block id, so a state can command several
 * controllers at once (an arm AND its wrist) from one selection.
 */
export interface MechanismState {
  name: string;
  /** controller block id -> target, in that controller's own display units. */
  targets: Record<string, number>;
}

/**
 * Attaches to a MECHANISM BOX -- wire the box's hex port into this block's
 * input -- and holds named target presets for every controller inside that
 * box, plus every controller on anything jointed below it.
 *
 * The box is the right thing to attach to because the box is already the
 * app's unit of "one mechanism": it is what the compiler validates as holding
 * exactly one complete chain, and what carries the human-readable name. Wiring
 * to a solid instead made the state block point at an implementation detail of
 * the mechanism rather than the mechanism itself, and left the arbitrary
 * question of WHICH solid to pick in a chain that has several. Attaching to a
 * solid still works, so older files keep loading, but the box is the path the
 * UI offers.
 */
export interface StateBlock {
  kind: 'state';
  id: string;
  label: string;
  states: MechanismState[];
}

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

/* --- the programming layer ------------------------------------------------
 *
 * These blocks answer a question the mechanism layer cannot: WHEN should a
 * mechanism change what it is doing. They live on the same canvas and the same
 * graph as the mechanism blocks -- the Design/Programming switch only changes
 * which half is emphasised -- because a condition is about a specific solid,
 * and splitting them into two documents would mean keeping two graphs in sync
 * and re-deriving the link between them on every edit.
 *
 * They carry no physics. Nothing here changes a torque or draws a current;
 * they read state that the solver already computes and decide what the
 * mechanism should be asked for next.
 */

/**
 * Fires when a solid passes a position threshold.
 *
 * Restricted to arms and elevators on purpose: a limit switch is a physical
 * object bolted at a place the mechanism travels past, and a flywheel has no
 * position to bolt it at -- its "position" is an ever-growing revolution count
 * that no switch could be placed against. The compiler rejects the wire rather
 * than accepting it and quietly never firing.
 */
export interface LimitSwitchBlock {
  kind: 'limitSwitch';
  id: string;
  label: string;
  /** Threshold in the watched solid's display units. */
  position: number;
  /** Which side of the threshold reads true. */
  direction: 'above' | 'below';
}

/**
 * Fires when a solid's position or velocity passes a threshold.
 *
 * This is a CONDITION, not a piece of hardware. It reads the same state the
 * solver already tracks for that solid, so it implies no second encoder on the
 * robot and generates no extra hardware object in the exported code -- it
 * becomes a comparison against the inputs the mechanism already reports.
 */
export interface EncoderBlock {
  kind: 'encoder';
  id: string;
  label: string;
  mode: 'position' | 'velocity';
  threshold: number;
  direction: 'above' | 'below';
}

/** Boolean combinator. Two inputs for and/or, one for not. */
export interface IfBlock {
  kind: 'if';
  id: string;
  label: string;
  op: 'and' | 'or' | 'not';
}

/**
 * Latches true once its input has been true.
 *
 * Distinct from a bare condition because it does not go false again when the
 * input does: "the elevator reached the top at some point" is a different
 * claim from "the elevator is at the top right now", and sequencing needs the
 * first one.
 */
export interface WaitUntilBlock {
  kind: 'waitUntil';
  id: string;
  label: string;
}

/**
 * Holds its target state for as long as the condition is true.
 *
 * The distinction from a plain transition is what happens when the condition
 * goes false: a transition has already fired and does not undo itself, while a
 * while block releases, letting a lower-priority rule or the resting state
 * take over again.
 */
export interface WhileBlock {
  kind: 'while';
  id: string;
  label: string;
}

/**
 * A boolean a person flips by hand from the Motion tab.
 *
 * Stands in for everything the simulator cannot model -- an operator button, a
 * beam break with a game piece in it, a vision target coming into view -- so a
 * programming graph can be exercised before any of that exists. In exported
 * code it becomes a settable field with the same shape as a real sensor, so
 * swapping it for hardware later is a one-line change.
 */
export interface TriggerBlock {
  kind: 'trigger';
  id: string;
  label: string;
  /** Value the trigger holds when a run starts. */
  initial: boolean;
}

export type SensorBlock = LimitSwitchBlock | EncoderBlock;
export type LogicBlock = IfBlock | WaitUntilBlock | WhileBlock | TriggerBlock;

/** Blocks belonging to the programming layer rather than the mechanism. */
export const PROGRAMMING_KINDS: ReadonlySet<string> =
  new Set(['limitSwitch', 'encoder', 'if', 'waitUntil', 'while', 'trigger']);

export const SENSOR_KINDS: ReadonlySet<string> = new Set(['limitSwitch', 'encoder']);

export type Block =
  | BatteryBlock | MotorBlock | GearBlock | SolidBlock | ControllerBlock
  | JointBlock | StateBlock | SensorBlock | LogicBlock;

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
    case 'voltage':
      return [
        { key: p('commanded'), label: 'Commanded voltage', unit: 'V', family: 'voltage' },
        { key: p('applied'), label: 'Applied voltage', unit: 'V', family: 'voltage' },
        { key: p('output'), label: 'Output (duty)', unit: '', family: 'duty' },
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
    case 'state':
      return [];
    /* Programming blocks expose their boolean as a plottable channel: seeing
       WHEN a condition went true, lined up against the position trace that
       caused it, is most of debugging a state machine. */
    case 'limitSwitch':
    case 'encoder':
    case 'if':
    case 'waitUntil':
    case 'while':
    case 'trigger':
      return [{ key: p('value'), label: block.label || 'Value', unit: '0/1', family: 'duty' }];
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
  /* Sense and boolean wires carry no power, so fan-out is free and meaningful:
     several sensors can watch one solid, and one condition can feed several
     rules. Only the input side stays single, since a logic block reading two
     booleans on one port would have no defined combination. */
  if (out.type !== 'signal' && inputOccupied) {
    return { ok: false, reason: 'That input is already connected.' };
  }
  return { ok: true };
}

/** Ports a block exposes, in canvas order. */
export function portsFor(block: Block): Port[] {
  const sig: Port = { id: 'signal', type: 'signal', direction: 'out' };
  /* Sensors take a pentagon from the solid they watch and hand out a diamond.
     Logic blocks are diamond-in, diamond-out. A trigger has no input at all --
     it is a source, which is exactly what makes it a stand-in for hardware
     that does not exist yet. */
  const senseIn: Port = { id: 'solid', type: 'sense', direction: 'in' };
  const boolOut: Port = { id: 'value', type: 'boolean', direction: 'out' };
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
        // Pentagon out: what sensors attach to. On the solid rather than on
        // the mechanism box because a condition is about one body's position
        // -- "the carriage is at the top" names a specific stage, and a box
        // holding a four-stage cascade has four different answers.
        { id: 'sense', type: 'sense', direction: 'out' },
        sig,
      ];
    case 'joint':
      return [
        { id: 'parent', type: 'mount', direction: 'in' },
        { id: 'child', type: 'mount', direction: 'out' },
      ];
    case 'state':
      // One signal input: wire a MECHANISM BOX into it. The state block then
      // discovers every controller in that box, plus every controller on
      // anything jointed below it.
      /* One hex for the mechanism, plus one diamond per state. Per-state
         ports rather than a single input with a dropdown: the whole point of
         the programming layer is that you can SEE what drives what, and a
         wire landing on "L4" says that without opening an inspector. The port
         id carries the state name so a renamed state drops its wires rather
         than silently rerouting them to a different state. */
      return [
        { id: 'mechanism', type: 'signal', direction: 'in' },
        ...block.states.map((st): Port => ({
          id: `when:${st.name}`, type: 'boolean', direction: 'in',
        })),
      ];
    case 'limitSwitch':
    case 'encoder':
      return [senseIn, boolOut, sig];
    case 'if':
      // 'not' takes one input; and/or take two. Rendering only the ports that
      // apply keeps an unwired second input from looking like a mistake.
      return block.op === 'not'
        ? [{ id: 'a', type: 'boolean', direction: 'in' }, boolOut, sig]
        : [
            { id: 'a', type: 'boolean', direction: 'in' },
            { id: 'b', type: 'boolean', direction: 'in' },
            boolOut, sig,
          ];
    case 'waitUntil':
    case 'while':
      return [{ id: 'a', type: 'boolean', direction: 'in' }, boolOut, sig];
    case 'trigger':
      return [boolOut, sig];
    case 'pid':
    case 'bangbang':
      return [
        { id: 'measure', type: 'signal', direction: 'in' },
        { id: 'command', type: 'control', direction: 'out' },
        sig,
      ];
    case 'voltage':
      // No hex input: there is nothing to measure. An open-loop voltage
      // command is a function of the bus and its own setting, full stop --
      // giving it a measure port would imply a feedback path that does not
      // exist.
      return [
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
