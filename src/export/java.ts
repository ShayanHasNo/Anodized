/**
 * WPILib + AdvantageKit code export.
 *
 * The generated code is STATE-BASED, not command-based. Each subsystem owns an
 * enum of goals and a `setGoal`; `periodic()` drives whatever the current goal
 * says. No `Command` factories, no `Commands.run(...)`, nothing that takes
 * ownership of the mechanism for a while -- the subsystem asks "what state am
 * I in, and what does that state want?" every loop. That makes behaviour a
 * pure function of state, which is the shape this simulator already models.
 *
 * Subsystems DO extend `SubsystemBase`, which is not a contradiction. Extending
 * it buys scheduler-driven `periodic()`, `AdvantageScope`/`Shuffleboard`
 * registration, and the requirements plumbing that the rest of a WPILib robot
 * expects to exist -- none of which forces a command-based control flow. The
 * command-vs-state distinction is about HOW behaviour is expressed, not about
 * which base class a subsystem happens to have.
 *
 * FIVE FILES PER MECHANISM, matching the layout of a real robot project:
 *
 *   <Name>Constants.java   gains, goal positions, conversions, hardware ids
 *   <Name>IO.java          the hardware boundary -- inputs struct + setters
 *   <Name>IOPhysical.java  real motor controllers and sensors, configured
 *   <Name>IOSim.java       a WPILib plant seeded from the simulated mechanism
 *   <Name>.java            goals and control, hardware-independent
 *
 * Constants live in their own file rather than inline because they are the
 * things a person actually edits at the field: gains get retuned, setpoints get
 * nudged, a CAN id changes when a controller is swapped. Keeping them in one
 * `static import`-able place means none of that requires touching logic, and it
 * is where a team's tunable-number plumbing drops in if they have it.
 *
 * The IO split follows the same two-call shape a real implementation converges
 * on: `setPosition` records the target, `goToSetpoint` acts on it. Separating
 * them lets the hardware layer own what happens between deciding and doing --
 * homing before it trusts its encoder, refusing to move while uncalibrated --
 * without the subsystem knowing any of it.
 *
 * A NOTE ON WHAT THIS CANNOT KNOW: CAN ids, inversion, sensor phase, and soft
 * limits are not physics, so the simulator has no opinion about them. They come
 * out as named constants with TODO markers rather than plausible guesses -- a
 * wrong CAN id that looks deliberate is worse than an obvious blank. Gains are
 * translated from the simulated tune and marked as a starting point, since a
 * simulated plant is never the real one.
 */

import {
  System, Mechanism, MechanismGroup, ResolvedStateGroup,
  ConditionNode, ProgramGraph,
} from '../sim/compile';
import {
  conditionExpr, conditionFields, triggerSetters, latchUpdates,
  needsDigitalInput, type ConditionContext,
} from './conditions';
import { generateCmd3 } from './java2027';
import { UNITS } from '../sim/units';
import { MOTORS } from '../sim/motors';
import type { ZipEntry } from './zip';

/* --- naming ---------------------------------------------------------------
   Box labels are free text ("Elevator (cascade)", "4-bar / wrist"), and Java
   identifiers are not. Sanitising has to be total: every label has to produce
   SOME legal identifier, including labels that are entirely punctuation. */

function pascal(raw: string, fallback: string): string {
  const words = raw.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const joined = words
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  // A leading digit is legal in the middle of an identifier but not at the
  // front, so a label like "4 Bar" needs a prefix rather than a rejection.
  const safe = /^[0-9]/.test(joined) ? `M${joined}` : joined;
  return safe || fallback;
}

const camel = (s: string) => s[0].toLowerCase() + s.slice(1);

/** SCREAMING_SNAKE for enum constants, from a state name like "Score L4". */
function constantName(raw: string, fallback: string): string {
  const s = raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const safe = /^[0-9]/.test(s) ? `S_${s}` : s;
  return safe || fallback;
}

/** Unit suffix used in generated field names: 'm' -> 'Meters'. */
const UNIT_SUFFIX: Record<string, string> = {
  m: 'Meters', cm: 'Centimeters', mm: 'Millimeters', in: 'Inches', ft: 'Feet',
  deg: 'Degrees', rad: 'Radians', rot: 'Rotations',
  'm/s': 'MetersPerSec', 'cm/s': 'CentimetersPerSec', 'mm/s': 'MillimetersPerSec',
  'in/s': 'InchesPerSec', 'ft/s': 'FeetPerSec',
  'deg/s': 'DegreesPerSec', 'rad/s': 'RadiansPerSec', rpm: 'Rpm', 'rot/s': 'RotationsPerSec',
};

const unitSuffix = (u: string) => UNIT_SUFFIX[u] ?? pascal(u, 'Units');

/* --- vendor mapping ------------------------------------------------------- */

type Vendor = 'talonfx' | 'sparkmax' | 'unknown';

/** Which controller a motor is realistically wired to. */
function vendorFor(motorId: string): Vendor {
  switch (motorId) {
    case 'krakenX60': case 'krakenX60Foc': case 'falcon500':
      return 'talonfx';
    case 'neo': case 'neo550': case 'neoVortex':
      return 'sparkmax';
    default:
      // Brushed motors (CIM, 775pro) run on a controller this generator does
      // not template. Emitting TalonFX code for them would be a lie, so the
      // file says so instead.
      return 'unknown';
  }
}

/** WPILib DCMotor factory for the physics sim. */
const DC_MOTOR: Record<string, string> = {
  krakenX60: 'getKrakenX60', krakenX60Foc: 'getKrakenX60Foc', falcon500: 'getFalcon500',
  neoVortex: 'getNeoVortex', neo: 'getNEO', neo550: 'getNeo550',
  cim: 'getCIM', miniCim: 'getCIM', redline775: 'getVex775Pro',
};

/* --- the per-mechanism view the templates render -------------------------- */

export interface SubsystemPlan {
  className: string;
  /** Lowercase package leaf, e.g. "elevator". */
  pkg: string;
  mech: Mechanism;
  /** 'position' when a controller tracks position, 'voltage' for open loop. */
  mode: 'position' | 'velocity' | 'voltage';
  posUnit: string;
  velUnit: string;
  posSuffix: string;
  velSuffix: string;
  /** Enum constants: name plus the setpoint this subsystem holds in that state. */
  goals: { name: string; value: number; from: string }[];
  archetype: 'elevator' | 'arm' | 'flywheel';
  /** Display units travelled per ROTOR rotation -- the conversion constant. */
  unitsPerMotorRotation: number;
}

const archetypeOf = (m: Mechanism): SubsystemPlan['archetype'] =>
  m.solid.gravityMode === 'constant' ? 'elevator'
    : m.solid.gravityMode === 'angleDependent' ? 'arm' : 'flywheel';

/**
 * Builds one plan per powered mechanism.
 *
 * A subsystem is named after the mechanism BOX it lives in, because the box is
 * what the person named and what already means "one mechanism" everywhere else
 * in this tool. An ungrouped chain falls back to its solid's id, which is at
 * least stable and unique.
 */
export function planSubsystems(
  sys: System, groups: MechanismGroup[],
): SubsystemPlan[] {
  const boxOf = new Map<string, MechanismGroup>();
  for (const g of groups) for (const id of g.memberIds) boxOf.set(id, g);

  const used = new Set<string>();
  return sys.mechanisms.map((mech, i) => {
    const box = boxOf.get(mech.motorBlock.id);
    let className = pascal(box?.label ?? mech.solid.id, `Mechanism${i + 1}`);
    // Two boxes can carry the same label; classes cannot share a name.
    let n = 2;
    while (used.has(className)) className = `${pascal(box?.label ?? mech.solid.id, 'Mechanism')}${n++}`;
    used.add(className);

    const ctrl = mech.controller;
    const mode: SubsystemPlan['mode'] = !ctrl || ctrl.kind === 'voltage'
      ? 'voltage'
      : (ctrl.kind !== 'lqr' && ctrl.source?.endsWith('.velocity')) ? 'velocity' : 'position';

    const posUnit = mech.positionUnit;
    const velUnit = mech.velocityUnit;

    /* Goals come from whichever state block reaches this mechanism's
       controller. Without one there is still exactly one goal -- the target
       already typed into the controller -- so the generated enum is never
       empty and the state machine shape is the same either way. */
    const group: ResolvedStateGroup | undefined = ctrl
      ? sys.stateGroups.find((g) => g.controllerIds.includes(ctrl.id))
      : undefined;

    let goals: SubsystemPlan['goals'];
    if (group && group.states.length > 0 && ctrl) {
      const seen = new Set<string>();
      goals = group.states.map((st, k) => {
        let name = constantName(st.name, `STATE_${k + 1}`);
        while (seen.has(name)) name = `${name}_${k + 1}`;
        seen.add(name);
        return { name, value: st.targets[ctrl.id] ?? 0, from: st.name };
      });
    } else {
      const fallback = !ctrl ? mech.motorBlock.duty * 12
        : ctrl.kind === 'voltage' ? ctrl.volts
        : ctrl.kind === 'lqr' ? ctrl.targetPos
        : ctrl.target;
      goals = [{ name: 'DEFAULT', value: fallback, from: 'controller default' }];
    }

    // Rotor rotations -> display units. A drum converts rotation to travel;
    // a rotational chain just divides by the reduction.
    const perOutputRotation = mech.linearDisplay
      ? 2 * Math.PI * (mech.radius ?? 0)   // metres of cable per output turn
      : 2 * Math.PI;                        // radians per output turn
    const toBase = UNITS[mode === 'velocity' ? velUnit : posUnit]?.toBase ?? 1;
    const unitsPerMotorRotation = perOutputRotation / mech.ratio / toBase;

    return {
      className, pkg: camel(className).replace(/[^A-Za-z0-9]/g, '').toLowerCase(),
      mech, mode, posUnit, velUnit,
      posSuffix: unitSuffix(posUnit), velSuffix: unitSuffix(velUnit),
      goals, archetype: archetypeOf(mech), unitsPerMotorRotation,
    };
  });
}

/* --- number formatting ----------------------------------------------------
   Java needs a decimal point to infer double, and long float tails are noise
   in source that a human has to read and retune. */
function num(v: number, places = 6): string {
  if (!Number.isFinite(v)) return '0.0';
  const s = v.toFixed(places).replace(/0+$/, '').replace(/\.$/, '.0');
  return s.includes('.') ? s : `${s}.0`;
}

/* --- gain translation -----------------------------------------------------
   Simulated gains are in DUTY per unit of error (-1..1 out). Both vendors'
   closed-loop gains here are configured against a voltage output, so the
   conversion is a factor of nominal bus voltage. This is a starting point and
   the generated comments say so: a simulated plant is not the real one, and
   nothing about friction, backlash, or sensor noise survives the trip. */
const NOMINAL_VOLTS = 12.0;

interface Gains { kP: number; kI: number; kD: number; kG: number; kS: number; kV: number; }

/**
 * Volts needed just to break the mechanism loose, derived from the Coulomb
 * friction the simulator actually models.
 *
 * The solver applies `friction` as a torque at the OUTPUT shaft with a stiction
 * band (solver.ts), so the motor has to produce friction/(G*eta) of torque to
 * move at all. At zero speed there is no back-EMF, so the volts to make that
 * torque follow straight from the stall figures: a motor makes `stallTorque` at
 * `vNom`, hence volts = (tau / stallTorque) * vNom, split across the motors on
 * the shaft.
 *
 * This is what KS means in WPILib's feedforward classes, so the simulated
 * friction lands in exactly the right place rather than being thrown away.
 */
function staticVolts(mech: Mechanism): number {
  const spec = MOTORS[mech.motorBlock.motorId];
  if (!spec || mech.friction <= 0) return 0;
  const tauPerMotor =
    mech.friction / Math.max(1e-9, mech.ratio * mech.efficiency * mech.motorBlock.count);
  return (tauPerMotor / spec.stallTorque) * spec.vNom;
}

function gainsFor(mech: Mechanism): Gains {
  const c = mech.controller;
  if (c && c.kind === 'pid') {
    return {
      kP: c.kP * NOMINAL_VOLTS, kI: c.kI * NOMINAL_VOLTS, kD: c.kD * NOMINAL_VOLTS,
      kG: c.kF * NOMINAL_VOLTS, kS: staticVolts(mech), kV: 0,
    };
  }
  if (c && c.kind === 'lqr' && mech.lqrGains) {
    // LQR gains are already position-error -> duty, same conversion.
    return {
      kP: mech.lqrGains.k1 * NOMINAL_VOLTS, kI: 0, kD: mech.lqrGains.k2 * NOMINAL_VOLTS,
      kG: 0, kS: 0, kV: 0,
    };
  }
  return { kP: 0, kI: 0, kD: 0, kG: 0, kS: 0, kV: 0 };
}

export { gainsFor, num, pascal, camel, constantName, vendorFor, DC_MOTOR, goalConstant, constantsFile, ioFile, physicalFile, simFile, toleranceFor, BASE_PKG };
export type { Vendor };

/* -------------------------------------------------------------------------
   Templates
   ------------------------------------------------------------------------- */

const BASE_PKG = 'frc.robot.subsystems';

/** A short human phrase for a condition, used in generated comments. */
function describe(node: ConditionNode): string {
  switch (node.kind) {
    case 'sensor':
      return `${node.label} (${node.signal} ${node.direction === 'above' ? '\u2265' : '\u2264'} ${num(node.threshold, 3)} ${node.unit})`;
    case 'trigger': return node.label;
    case 'and': return `${describe(node.a)} and ${describe(node.b)}`;
    case 'or': return `${describe(node.a)} or ${describe(node.b)}`;
    case 'not': return `not ${describe(node.a)}`;
    case 'latch': return `${node.label} has fired`;
  }
}

/** SCREAMING_SNAKE constant name for a goal's setpoint in the Constants file. */
const goalConstant = (p: SubsystemPlan, goalName: string) =>
  `${goalName}_${p.mode === 'voltage' ? 'VOLTS' : p.mode === 'velocity' ? 'VELOCITY' : 'POSITION'}`;

/* --- constants ------------------------------------------------------------ */

function constantsFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const g = gainsFor(m);
  const vendor = vendorFor(m.motorBlock.motorId);
  const unit = p.mode === 'voltage' ? 'volts' : p.mode === 'velocity' ? p.velUnit : p.posUnit;

  const goalConsts = p.goals.map((goal) =>
    `  /** "${goal.from}" — ${num(goal.value)} ${unit}. */\n`
    + `  public static final double ${goalConstant(p, goal.name)} = ${num(goal.value)};`,
  ).join('\n');

  const conversionComment = m.linearDisplay
    ? `   * One output rotation pays out 2*pi*r = ${num(2 * Math.PI * (m.radius ?? 0), 6)} m of cable,\n`
      + `   * and the rotor turns ${num(m.ratio, 4)} times per output rotation.`
    : `   * One output rotation is 2*pi rad, and the rotor turns ${num(m.ratio, 4)} times\n`
      + `   * per output rotation.`;

  return `package ${BASE_PKG}.${p.pkg};

/**
 * Tuning and hardware constants for ${N}.
 *
 * Everything here is something a person edits without touching logic: gains get
 * retuned, setpoints get nudged between matches, a CAN id changes when a
 * controller is swapped. Values the simulator derived are filled in; values it
 * cannot know are marked TODO.
 *
 * If your project has tunable-number plumbing, this is where it goes — swap the
 * gain fields for tunables and nothing else in the mechanism has to change.
 *
 * Generated by Anodized. Safe to edit.
 */
public final class ${N}Constants {
  private ${N}Constants() {}

  /* ---- hardware ---- */

  // TODO: replace this — set the real CAN id${m.motorBlock.count > 1 ? 's' : ''}.
  public static final int MOTOR_CAN_ID = 0;${m.motorBlock.count > 1
    ? `\n  public static final int[] FOLLOWER_CAN_IDS = new int[] {${
      Array.from({ length: m.motorBlock.count - 1 }, () => '0').join(', ')}};`
    : ''}${vendor === 'talonfx' ? '\n  public static final String CAN_BUS = "rio";' : ''}

  // TODO: replace this — confirm against the real mechanism. Positive should
  // move it the same way positive moves it in the simulator.
  public static final boolean INVERTED = false;

  /** Per-motor current limit, from the simulated mechanism. */
  public static final int CURRENT_LIMIT_AMPS = ${Math.round(m.motorBlock.currentLimit)};

  /* ---- conversion ---- */

  /**
   * ${p.posUnit} of mechanism travel per ROTOR rotation.
   *
${conversionComment}
   *
   * Applied to the encoder so every reading is already in ${p.posUnit} — the
   * subsystem, the gains, and the setpoints then share one unit and nothing has
   * to remember to convert.
   */
  public static final double ENCODER_CONVERSION_FACTOR = ${num(p.unitsPerMotorRotation, 8)};
${p.archetype === 'arm' ? `
  /**
   * Radians per ${p.posUnit}. ArmFeedforward needs the angle in radians to work out
   * the gravity load, no matter what unit the rest of the mechanism uses.
   */
  public static final double RADIANS_PER_UNIT = ${num(UNITS[p.posUnit]?.toBase ?? 1, 8)};
` : ''}

  /* ---- gains ----
     Translated from the simulated tune: the simulator works in duty per unit of
     error and these output volts, so each is scaled by a nominal ${num(NOMINAL_VOLTS, 1)} V bus.

     TREAT THESE AS A STARTING POINT. The model has Coulomb friction and
     gravity, but no backlash, no compliance, no belt stretch, and no sensor
     noise. Those all cost phase margin on a real mechanism. */

  public static final double KP = ${num(g.kP)};
  public static final double KI = ${num(g.kI)};
  public static final double KD = ${num(g.kD)};
  /** Gravity feedforward, from the simulated kF. */
  public static final double KG = ${num(g.kG)};
  /**
   * Volts needed just to break the mechanism loose, derived from the ${num(m.friction, 3)} N·m of
   * Coulomb friction on this mechanism's solid block. The solver really does
   * integrate that friction (with a stiction band), so this is a computed
   * number rather than a placeholder — but it is only as good as the friction
   * figure that was entered.
   */
  public static final double KS = ${num(g.kS, 4)};
  /**
   * Velocity feedforward. Zero because the simulator models Coulomb friction
   * but not viscous (speed-proportional) drag, which is what KV represents —
   * there is nothing honest to derive it from. Characterise on the robot.
   */
  public static final double KV = ${num(g.kV)};

  /* ---- motion limits ----
     Infinity means no motion profile: the controller drives straight at the
     setpoint, which is what the simulation modelled. Set real numbers here to
     profile the approach, and expect to retune KP when you do. */

  public static final double MAX_VELOCITY = Double.POSITIVE_INFINITY;
  public static final double MAX_ACCELERATION = Double.POSITIVE_INFINITY;

  // TODO: replace this — set the mechanism's real range of travel. The
  // simulator has no hard stops, so it cannot infer these.
  public static final double FORWARD_SOFT_LIMIT = 0.0;
  public static final double REVERSE_SOFT_LIMIT = 0.0;
  public static final boolean SOFT_LIMITS_ENABLED = false;

  /* ---- setpoints ---- */

  /** How close counts as "there", in ${unit}. TODO: replace this — tune on the robot. */
  public static final double TOLERANCE = ${num(toleranceFor(p))};

${goalConsts}
}
`;
}

/* --- IO interface --------------------------------------------------------- */

function ioFile(p: SubsystemPlan): string {
  const N = p.className;

  return `package ${BASE_PKG}.${p.pkg};

import org.littletonrobotics.junction.AutoLog;

/**
 * Hardware boundary for the ${N} mechanism.
 *
 * Deliberately dumb: it reports what the sensors say and applies the volts it
 * is told to apply. It runs no control loop of its own. The feedback lives in
 * ${N} so that the state machine, the gains, and the setpoints are all readable
 * in one file instead of split between here and a motor controller's flash.
 *
 * Generated by Anodized from the simulated mechanism. Safe to edit.
 */
public interface ${N}IO {
  @AutoLog
  class ${N}IOInputs {
    /** False when the motor controller has stopped answering. */
    public boolean connected = false;

    public double position${p.posSuffix} = 0.0;
    public double velocity${p.velSuffix} = 0.0;

    public double appliedVolts = 0.0;
    public double currentAmps = 0.0;
  }

  default void updateInputs(${N}IOInputs inputs) {}

  /** The one way to command this mechanism. */
  default void setVoltage(double volts) {}

  default void stop() {}

  default void setBrakeMode(boolean enabled) {}

  /** Teaches the encoder where the mechanism currently is. */
  default void resetPosition(double position${p.posSuffix}) {}
}
`;
}

/* --- subsystem ------------------------------------------------------------ */

function subsystemFile(p: SubsystemPlan): string {
  const N = p.className;
  const closedLoop = p.mode !== 'voltage';
  const velocityMode = p.mode === 'velocity';
  const measured = velocityMode
    ? `inputs.velocity${p.velSuffix}` : `inputs.position${p.posSuffix}`;

  /* THE STATE MACHINE.
     Each case RUNS its state -- it calls the routine that drives the mechanism,
     rather than setting a variable that something further down acts on. That
     way the case body is the behaviour: a state that needs to do something
     different (hold instead of drive, run a second setpoint, home first) has
     the obvious place to say so, and reading one case tells you everything that
     state does.

     A switch rather than values hung off the enum, because an enum constructor
     argument can only ever be a number. The compiler also points straight at
     this switch the moment a state is added and left unhandled. */
  const cases = p.goals.map((g) =>
    `      case ${g.name} -> ${closedLoop ? 'runSetpoint' : 'runVolts'}(${goalConstant(p, g.name)});`,
  ).join('\n');

  const stateNames = p.goals.map((g) => g.name).join(', ');

  const feedforward = p.archetype === 'arm'
    ? `  /* Arm gravity load varies with angle, so the feedforward needs the angle --
     hence ArmFeedforward rather than the simpler Elevator form. It wants
     radians regardless of the unit the rest of this file works in. */
  private final ArmFeedforward feedforward = new ArmFeedforward(KS, KG, KV);`
    : p.archetype === 'elevator'
      ? `  /* Elevator gravity load is constant, so KG is a flat volts offset. */
  private final ElevatorFeedforward feedforward = new ElevatorFeedforward(KS, KG, KV);`
      : `  private final SimpleMotorFeedforward feedforward = new SimpleMotorFeedforward(KS, KV);`;

  const ffCall = p.archetype === 'arm'
    ? `feedforward.calculate(inputs.position${p.posSuffix} * RADIANS_PER_UNIT, 0.0)`
    : p.archetype === 'elevator'
      ? 'feedforward.calculate(0.0)'
      : `feedforward.calculate(${velocityMode ? 'setpoint' : '0.0'})`;

  const ffImport = p.archetype === 'arm'
    ? 'import edu.wpi.first.math.controller.ArmFeedforward;'
    : p.archetype === 'elevator'
      ? 'import edu.wpi.first.math.controller.ElevatorFeedforward;'
      : 'import edu.wpi.first.math.controller.SimpleMotorFeedforward;';

  if (!closedLoop) {
    // Open loop: the state picks a voltage and that voltage is applied. No
    // controller, because there is no measurement being regulated.
    return `package ${BASE_PKG}.${p.pkg};

import static ${BASE_PKG}.${p.pkg}.${N}Constants.*;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import org.littletonrobotics.junction.AutoLogOutput;
import org.littletonrobotics.junction.Logger;

/**
 * ${N} — a STATE-BASED subsystem.
 *
 * The mechanism is always in exactly one {@link State}, and {@link #periodic()}
 * executes that state every loop. Changing what the mechanism does means
 * changing its state; nothing takes ownership of it and there is no queue of
 * pending work, so it can never be left holding a state nobody asked for.
 *
 * This one runs OPEN LOOP: each state names a voltage, and that voltage is
 * applied. There is no controller because there is no measurement being
 * regulated — a roller either spins or it does not.
 *
 * Generated by Anodized from the simulated mechanism. Safe to edit.
 */
public class ${N} extends SubsystemBase {
  /** Every state this mechanism can be in: ${stateNames}. */
  public enum State {
${p.goals.map((g) => `    /** From the "${g.from}" state. */\n    ${g.name}`).join(',\n')}
  }

  private final ${N}IO io;
  private final ${N}IOInputsAutoLogged inputs = new ${N}IOInputsAutoLogged();

  /**
   * The state this mechanism is in. Public so anything can read it without
   * going through an accessor — a superstructure deciding whether it is safe to
   * move, a dashboard, an auto routine checking where things stand.
   *
   * Prefer {@link #setState} for writes: it is the same assignment, but it is
   * greppable, so every place that changes this mechanism's behaviour can be
   * found.
   */
  @AutoLogOutput public State state = State.${p.goals[0].name};

  /** Volts the running state last asked for. */
  @AutoLogOutput private double appliedVolts = 0.0;

  public ${N}(${N}IO io) {
    this.io = io;
  }

  @Override
  public void periodic() {
    io.updateInputs(inputs);
    Logger.processInputs("${N}", inputs);

    // Run the current state.
    switch (state) {
${cases}
    }
  }

  /** Drives the mechanism at a fixed voltage. What every state here does. */
  private void runVolts(double volts) {
    appliedVolts = MathUtil.clamp(volts, -12.0, 12.0);
    io.setVoltage(appliedVolts);
  }

  public void setState(State state) {
    this.state = state;
  }

  public State getState() {
    return state;
  }

  /**
   * Open loop, so there is nothing to converge on — the request is either
   * issued or it is not. Reporting a tolerance check would invent a closed loop
   * that does not exist.
   */
  public boolean atState() {
    return true;
  }

  public double getVelocity${p.velSuffix}() {
    return inputs.velocity${p.velSuffix};
  }

  public boolean isConnected() {
    return inputs.connected;
  }

  /** Cuts output. The next {@link #periodic()} resumes running the state. */
  public void stop() {
    appliedVolts = 0.0;
    io.stop();
  }
}
`;
  }

  return `package ${BASE_PKG}.${p.pkg};

import static ${BASE_PKG}.${p.pkg}.${N}Constants.*;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.controller.PIDController;
${ffImport}
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import org.littletonrobotics.junction.AutoLogOutput;
import org.littletonrobotics.junction.Logger;

/**
 * ${N} — a STATE-BASED subsystem.
 *
 * The mechanism is always in exactly one {@link State}, and {@link #periodic()}
 * executes that state every loop, unconditionally. Changing what the mechanism
 * does means changing its state; nothing takes ownership of it and there is no
 * queue of pending work, so it can never be left holding a state nobody asked
 * for because a command ended early.
 *
 * The feedback loop lives HERE rather than on the motor controller. That costs
 * some loop rate — the controller could close at 1 kHz internally, this closes
 * at the 50 Hz robot loop — and buys the thing that matters more while a
 * mechanism is being brought up: the gains, the setpoint, and the state that
 * chose it are all visible in one file and all logged, instead of being split
 * between this file and a value burned into the controller's flash. Move it
 * onboard once the mechanism is tuned and the gains have stopped changing.
 *
 * Generated by Anodized from the simulated mechanism. Safe to edit.
 */
public class ${N} extends SubsystemBase {
  /** Every state this mechanism can be in: ${stateNames}. */
  public enum State {
${p.goals.map((g) => `    /** From the "${g.from}" state. */\n    ${g.name}`).join(',\n')}
  }

  private final ${N}IO io;
  private final ${N}IOInputsAutoLogged inputs = new ${N}IOInputsAutoLogged();

  private final PIDController controller = new PIDController(KP, KI, KD);
${feedforward}

  /**
   * The state this mechanism is in. Public so anything can read it without
   * going through an accessor — a superstructure deciding whether it is safe to
   * move, a dashboard, an auto routine checking where things stand.
   *
   * Prefer {@link #setState} for writes: it is the same assignment, but it is
   * greppable, so every place that changes this mechanism's behaviour can be
   * found.
   */
  @AutoLogOutput public State state = State.${p.goals[0].name};

  /** What the running state is asking for, in ${velocityMode ? p.velUnit : p.posUnit}. */
  @AutoLogOutput private double setpoint = ${goalConstant(p, p.goals[0].name)};

  public ${N}(${N}IO io) {
    this.io = io;
    controller.setTolerance(TOLERANCE);
  }

  @Override
  public void periodic() {
    io.updateInputs(inputs);
    Logger.processInputs("${N}", inputs);

    // Run the current state.
    switch (state) {
${cases}
    }

    Logger.recordOutput("${N}/Error", controller.getError());
    Logger.recordOutput("${N}/AtState", atState());
  }

  /**
   * Closes the loop on a setpoint, in ${velocityMode ? p.velUnit : p.posUnit}. What every state here does.
   *
   * Lives in one place rather than being spelled out per case so that the
   * control math cannot drift between states — a state that needs to do
   * something genuinely different calls something else instead.
   */
  private void runSetpoint(double setpoint) {
    this.setpoint = setpoint;
    controller.setSetpoint(setpoint);
    double volts = controller.calculate(${measured}) + ${ffCall};
    io.setVoltage(MathUtil.clamp(volts, -12.0, 12.0));
  }

  /** Asks the mechanism to hold a state. Takes effect on the next loop. */
  public void setState(State state) {
    this.state = state;
  }

  public State getState() {
    return state;
  }

  /** True once the measurement is inside TOLERANCE of the state's setpoint. */
  public boolean atState() {
    return controller.atSetpoint();
  }

  public double getPosition${p.posSuffix}() {
    return inputs.position${p.posSuffix};
  }

  public double getVelocity${p.velSuffix}() {
    return inputs.velocity${p.velSuffix};
  }

  /** True when the hardware has stopped reporting — worth surfacing to drivers. */
  public boolean isConnected() {
    return inputs.connected;
  }

  /** Cuts output. The next {@link #periodic()} resumes driving the state. */
  public void stop() {
    io.stop();
  }
}
`;
}

function toleranceFor(p: SubsystemPlan): number {
  if (p.mode === 'voltage') return 0;
  const span = p.goals.reduce((max, g) => Math.max(max, Math.abs(g.value)), 0);
  // 2% of the largest commanded setpoint, floored so a mechanism whose states
  // are all near zero still gets a usable band rather than 0.
  const unit = p.mode === 'velocity' ? p.velUnit : p.posUnit;
  const floor = unit === 'm' ? 0.005 : unit === 'deg' ? 1 : unit === 'rot' ? 0.01 : 0.01;
  return Math.max(span * 0.02, floor);
}

/* --- hardware layer ------------------------------------------------------- */

function physicalFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const vendor = vendorFor(m.motorBlock.motorId);

  if (vendor === 'unknown') {
    return `package ${BASE_PKG}.${p.pkg};

/**
 * ${N} hardware layer — NOT GENERATED.
 *
 * The simulated mechanism uses ${m.motorBlock.count}x "${m.motorBlock.motorId}", a brushed
 * motor. Anodized only templates smart controllers (TalonFX via Phoenix 6 and
 * SPARK MAX via REVLib), and emitting one of those here would produce code that
 * compiles and then does not run.
 *
 * Implement ${N}IO against whatever controller actually drives this mechanism.
 * Everything the simulator derived is in ${N}Constants, in the units the rest of
 * the generated code expects.
 */
public class ${N}IOPhysical implements ${N}IO {
  // TODO: replace this — implement against the real motor controller.
}
`;
  }
  return vendor === 'talonfx' ? talonFile(p) : sparkFile(p);
}

function talonFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const followers = m.motorBlock.count - 1;

  return `package ${BASE_PKG}.${p.pkg};

import static ${BASE_PKG}.${p.pkg}.${N}Constants.*;

import com.ctre.phoenix6.BaseStatusSignal;
import com.ctre.phoenix6.StatusSignal;
import com.ctre.phoenix6.configs.TalonFXConfiguration;
import com.ctre.phoenix6.controls.NeutralOut;
import com.ctre.phoenix6.controls.VoltageOut;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.signals.InvertedValue;
import com.ctre.phoenix6.signals.NeutralModeValue;
import edu.wpi.first.units.measure.Angle;
import edu.wpi.first.units.measure.AngularVelocity;
import edu.wpi.first.units.measure.Current;
import edu.wpi.first.units.measure.Temperature;
import edu.wpi.first.units.measure.Voltage;

/**
 * ${N} hardware: ${m.motorBlock.count}x ${m.motorBlock.motorId} on TalonFX (Phoenix 6).
 *
 * Configures the motor and reports what it sees; it runs no control loop. The
 * feedback lives in ${N}, so the only command this layer takes is a voltage.
 *
 * Generated by Anodized. Safe to edit.
 */
public class ${N}IOPhysical implements ${N}IO {
  private final TalonFX leader = new TalonFX(MOTOR_CAN_ID, CAN_BUS);${followers
    ? `\n  private final TalonFX[] followers = new TalonFX[FOLLOWER_CAN_IDS.length];`
    : ''}

  private final StatusSignal<Angle> positionSignal;
  private final StatusSignal<AngularVelocity> velocitySignal;
  private final StatusSignal<Voltage> appliedVoltsSignal;
  private final StatusSignal<Current> currentSignal;
  private final StatusSignal<Temperature> tempSignal;

  /* Reused request objects. Phoenix allocates inside a control request, so
     building one per loop is avoidable garbage in the hot path. */
  private final VoltageOut voltageRequest = new VoltageOut(0.0);
  private final NeutralOut neutralRequest = new NeutralOut();

  public ${N}IOPhysical() {
    TalonFXConfiguration config = new TalonFXConfiguration();

    config.MotorOutput.Inverted =
        INVERTED ? InvertedValue.Clockwise_Positive : InvertedValue.CounterClockwise_Positive;
    config.MotorOutput.NeutralMode = NeutralModeValue.Brake;

    config.CurrentLimits.StatorCurrentLimit = CURRENT_LIMIT_AMPS;
    config.CurrentLimits.StatorCurrentLimitEnable = true;
    config.CurrentLimits.SupplyCurrentLimit = CURRENT_LIMIT_AMPS;
    config.CurrentLimits.SupplyCurrentLimitEnable = true;

    // Reports ${p.posUnit} directly, so the gains in ${N} need no conversion.
    config.Feedback.SensorToMechanismRatio = 1.0 / ENCODER_CONVERSION_FACTOR;

    config.SoftwareLimitSwitch.ForwardSoftLimitEnable = SOFT_LIMITS_ENABLED;
    config.SoftwareLimitSwitch.ForwardSoftLimitThreshold = FORWARD_SOFT_LIMIT;
    config.SoftwareLimitSwitch.ReverseSoftLimitEnable = SOFT_LIMITS_ENABLED;
    config.SoftwareLimitSwitch.ReverseSoftLimitThreshold = REVERSE_SOFT_LIMIT;

    leader.getConfigurator().apply(config);
${followers ? `
    for (int i = 0; i < FOLLOWER_CAN_IDS.length; i++) {
      followers[i] = new TalonFX(FOLLOWER_CAN_IDS[i], CAN_BUS);
      followers[i].getConfigurator().apply(config);
      // TODO: replace this — second argument is "opposeMasterDirection", true
      // when the motors face opposite ways on the gearbox.
      followers[i].setControl(new com.ctre.phoenix6.controls.Follower(MOTOR_CAN_ID, false));
    }
` : ''}
    positionSignal = leader.getPosition();
    velocitySignal = leader.getVelocity();
    appliedVoltsSignal = leader.getMotorVoltage();
    currentSignal = leader.getStatorCurrent();
    tempSignal = leader.getDeviceTemp();

    BaseStatusSignal.setUpdateFrequencyForAll(
        50.0, positionSignal, velocitySignal, appliedVoltsSignal, currentSignal, tempSignal);
    leader.optimizeBusUtilization();
  }

  @Override
  public void updateInputs(${N}IOInputs inputs) {
    inputs.connected =
        BaseStatusSignal.refreshAll(
                positionSignal, velocitySignal, appliedVoltsSignal, currentSignal, tempSignal)
            .isOK();

    inputs.position${p.posSuffix} = positionSignal.getValueAsDouble();
    inputs.velocity${p.velSuffix} = velocitySignal.getValueAsDouble();
    inputs.appliedVolts = appliedVoltsSignal.getValueAsDouble();
    inputs.currentAmps = currentSignal.getValueAsDouble();
  }

  @Override
  public void setVoltage(double volts) {
    leader.setControl(voltageRequest.withOutput(volts));
  }

  @Override
  public void stop() {
    leader.setControl(neutralRequest);
  }

  @Override
  public void setBrakeMode(boolean enabled) {
    leader.setNeutralMode(enabled ? NeutralModeValue.Brake : NeutralModeValue.Coast);
  }

  @Override
  public void resetPosition(double position${p.posSuffix}) {
    leader.setPosition(position${p.posSuffix});
  }
}
`;
}

function sparkFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const followers = m.motorBlock.count - 1;

  return `package ${BASE_PKG}.${p.pkg};

import static ${BASE_PKG}.${p.pkg}.${N}Constants.*;

import com.revrobotics.RelativeEncoder;
import com.revrobotics.spark.SparkBase.PersistMode;
import com.revrobotics.spark.SparkBase.ResetMode;
import com.revrobotics.spark.SparkLowLevel.MotorType;
import com.revrobotics.spark.SparkMax;
import com.revrobotics.spark.config.SparkBaseConfig.IdleMode;
import com.revrobotics.spark.config.SparkMaxConfig;

/**
 * ${N} hardware: ${m.motorBlock.count}x ${m.motorBlock.motorId} on SPARK MAX (REVLib).
 *
 * Configures the motor and reports what it sees; it runs no control loop. The
 * feedback lives in ${N}, so the only command this layer takes is a voltage.
 *
 * Generated by Anodized. Safe to edit.
 */
public class ${N}IOPhysical implements ${N}IO {
  private final SparkMax spark = new SparkMax(MOTOR_CAN_ID, MotorType.kBrushless);${followers
    ? `\n  private final SparkMax[] followers = new SparkMax[FOLLOWER_CAN_IDS.length];`
    : ''}
  private final RelativeEncoder encoder = spark.getEncoder();

  public ${N}IOPhysical() {
    SparkMaxConfig config = new SparkMaxConfig();
    config
        .idleMode(IdleMode.kBrake)
        .inverted(INVERTED)
        .smartCurrentLimit(CURRENT_LIMIT_AMPS)
        // Makes a voltage request mean the same thing at 12.6 V and at 9 V,
        // which is what the feedforward in ${N} assumes.
        .voltageCompensation(12.0);

    /* Scaled so every reading is already in ${p.posUnit} — the state machine, the
       gains, and the setpoints then share one unit and nothing has to remember
       to convert. */
    config
        .encoder
        .positionConversionFactor(ENCODER_CONVERSION_FACTOR)
        .velocityConversionFactor(ENCODER_CONVERSION_FACTOR / 60.0);

    config
        .softLimit
        .forwardSoftLimit(FORWARD_SOFT_LIMIT)
        .forwardSoftLimitEnabled(SOFT_LIMITS_ENABLED)
        .reverseSoftLimit(REVERSE_SOFT_LIMIT)
        .reverseSoftLimitEnabled(SOFT_LIMITS_ENABLED);

    spark.configure(config, ResetMode.kResetSafeParameters, PersistMode.kPersistParameters);
${followers ? `
    for (int i = 0; i < FOLLOWER_CAN_IDS.length; i++) {
      followers[i] = new SparkMax(FOLLOWER_CAN_IDS[i], MotorType.kBrushless);
      SparkMaxConfig followerConfig = new SparkMaxConfig();
      followerConfig.apply(config);
      // TODO: replace this — second argument is "invert relative to leader".
      followerConfig.follow(MOTOR_CAN_ID, false);
      followers[i].configure(
          followerConfig, ResetMode.kResetSafeParameters, PersistMode.kPersistParameters);
    }
` : ''}
    encoder.setPosition(0.0);
  }

  @Override
  public void updateInputs(${N}IOInputs inputs) {
    // REVLib surfaces faults rather than a link state; a firmware frame that
    // never arrives leaves this false.
    inputs.connected = spark.getFirmwareVersion() != 0;

    inputs.position${p.posSuffix} = encoder.getPosition();
    inputs.velocity${p.velSuffix} = encoder.getVelocity();
    inputs.appliedVolts = spark.getAppliedOutput() * spark.getBusVoltage();
    inputs.currentAmps = spark.getOutputCurrent();
  }

  @Override
  public void setVoltage(double volts) {
    spark.setVoltage(volts);
  }

  @Override
  public void stop() {
    spark.stopMotor();
  }

  @Override
  public void setBrakeMode(boolean enabled) {
    SparkMaxConfig config = new SparkMaxConfig();
    config.idleMode(enabled ? IdleMode.kBrake : IdleMode.kCoast);
    spark.configure(
        config, ResetMode.kNoResetSafeParameters, PersistMode.kNoPersistParameters);
  }

  @Override
  public void resetPosition(double position${p.posSuffix}) {
    encoder.setPosition(position${p.posSuffix});
  }
}
`;
}

/* --- sim layer ------------------------------------------------------------ */

function simFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const dc = DC_MOTOR[m.motorBlock.motorId] ?? 'getKrakenX60';
  const count = m.motorBlock.count;
  const toBase = UNITS[p.posUnit]?.toBase ?? 1;

  let decl: string, read: string, readVel: string, imports: string, limits: string;
  if (p.archetype === 'elevator') {
    imports = 'import edu.wpi.first.wpilibj.simulation.ElevatorSim;';
    limits = `  // TODO: replace this — set the mechanism's real hard stops.
  private static final double MIN_HEIGHT_METERS = 0.0;
  private static final double MAX_HEIGHT_METERS = 2.0;
`;
    decl = `  private final ElevatorSim sim =
      new ElevatorSim(
          DCMotor.${dc}(${count}),
          ${num(m.ratio, 4)},
          ${num(m.solid.mass, 4)},
          ${num(m.radius ?? 0.025, 5)},
          MIN_HEIGHT_METERS,
          MAX_HEIGHT_METERS,
          true,
          0.0);`;
    read = 'sim.getPositionMeters()';
    readVel = 'sim.getVelocityMetersPerSecond()';
  } else if (p.archetype === 'arm') {
    imports = 'import edu.wpi.first.wpilibj.simulation.SingleJointedArmSim;';
    limits = `  // TODO: replace this — set the mechanism's real hard stops.
  private static final double MIN_ANGLE_RADS = -Math.PI;
  private static final double MAX_ANGLE_RADS = Math.PI;
`;
    decl = `  private final SingleJointedArmSim sim =
      new SingleJointedArmSim(
          DCMotor.${dc}(${count}),
          ${num(m.ratio, 4)},
          ${num(m.inertiaSolid, 6)},
          ${num(m.solid.cgRadius ?? 0.3, 4)},
          MIN_ANGLE_RADS,
          MAX_ANGLE_RADS,
          true,
          0.0);`;
    read = 'sim.getAngleRads()';
    readVel = 'sim.getVelocityRadPerSec()';
  } else {
    imports = 'import edu.wpi.first.math.system.plant.LinearSystemId;\nimport edu.wpi.first.wpilibj.simulation.FlywheelSim;';
    limits = '';
    decl = `  private final FlywheelSim sim =
      new FlywheelSim(
          LinearSystemId.createFlywheelSystem(
              DCMotor.${dc}(${count}), ${num(m.inertiaSolid, 8)}, ${num(m.ratio, 4)}),
          DCMotor.${dc}(${count}));`;
    read = '0.0';
    readVel = 'sim.getAngularVelocityRadPerSec()';
  }

  return `package ${BASE_PKG}.${p.pkg};

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.system.plant.DCMotor;
${imports}

/**
 * ${N} against a WPILib physics sim, seeded with the plant Anodized solved:
 * ${num(m.ratio, 3)}:1 reduction, ${num(m.solid.mass, 3)} kg, ${p.archetype} geometry.
 *
 * Like the hardware layer, it runs no control loop — the same PID in ${N} drives
 * it, which is the point: the loop you tune here is the loop that runs on the
 * robot. It is not the same integrator Anodized uses, so it will not reproduce
 * the tool's traces exactly.
 *
 * Generated by Anodized. Safe to edit.
 */
public class ${N}IOSim implements ${N}IO {
  private static final double LOOP_PERIOD_SECS = 0.02;

  /** SI per display unit, so the sim's metres/radians become ${p.posUnit}. */
  private static final double BASE_PER_UNIT = ${num(toBase, 8)};

${limits}${decl}

  private double appliedVolts = 0.0;

  @Override
  public void updateInputs(${N}IOInputs inputs) {
    sim.setInputVoltage(appliedVolts);
    sim.update(LOOP_PERIOD_SECS);

    inputs.connected = true;
    inputs.position${p.posSuffix} = ${read} / BASE_PER_UNIT;
    inputs.velocity${p.velSuffix} = ${readVel} / BASE_PER_UNIT;
    inputs.appliedVolts = appliedVolts;
    inputs.currentAmps = sim.getCurrentDrawAmps();
  }

  @Override
  public void setVoltage(double volts) {
    appliedVolts = MathUtil.clamp(volts, -12.0, 12.0);
  }

  @Override
  public void stop() {
    setVoltage(0.0);
  }
}
`;
}

function superstructureFile(
  group: ResolvedStateGroup, plans: SubsystemPlan[], program: ProgramGraph,
): string {
  const N = pascal(group.label, 'Superstructure');
  const members = plans.filter((p) => p.mech.controller
    && group.controllerIds.includes(p.mech.controller.id));

  const fields = members
    .map((p) => `  private final ${p.className} ${camel(p.className)};`).join('\n');
  const params = members
    .map((p) => `${p.className} ${camel(p.className)}`).join(', ');
  const assigns = members
    .map((p) => `    this.${camel(p.className)} = ${camel(p.className)};`).join('\n');

  const seen = new Set<string>();
  const stateNames = group.states.map((st, k) => {
    let name = constantName(st.name, `STATE_${k + 1}`);
    while (seen.has(name)) name = `${name}_${k + 1}`;
    seen.add(name);
    return name;
  });

  const enumBody = stateNames.map((n) => `    ${n}`).join(',\n');

  const dispatch = stateNames.map((n, k) => {
    const lines = members.map((p) => {
      // Each subsystem's goal enum was built from the same state list in the
      // same order, so index k lines up across all of them.
      const goal = p.goals[k]?.name ?? p.goals[0].name;
      return `        ${camel(p.className)}.setState(${p.className}.State.${goal});`;
    }).join('\n');
    return `      case ${n} ->  {\n${lines}\n      }`;
  }).join('\n');

  const atGoal = members
    .map((p) => `${camel(p.className)}.atState()`).join('\n        && ');

  /* --- the programming layer -------------------------------------------
     Rules that target THIS group become checks in the loop. The classic
     framework has no transition graph to hand them to, so they are plain ifs
     evaluated every tick, in declaration order, last match winning -- which is
     the same precedence the simulator applies. */
  const ctx: ConditionContext = { plans };
  const myRules = program.rules.filter((r) => r.groupId === group.blockId);
  const roots = myRules.map((r) => r.condition);

  const ruleChecks = myRules.map((r, k) => {
    const stateConst = stateNames[group.states.findIndex((st) => st.name === r.stateName)]
      ?? stateNames[0];
    return `    // ${r.hold ? 'While' : 'When'} ${describe(r.condition)}\n`
      + `    if (${conditionExpr(r.condition, ctx)}) {\n`
      + `      state = State.${stateConst};\n`
      + `    }${k === myRules.length - 1 ? '' : ''}`;
  }).join('\n');

  const fieldBlock = conditionFields(roots, ctx);
  const setters = triggerSetters(roots);
  const latches = latchUpdates(roots, ctx);
  const usesDio = needsDigitalInput(roots);

  /* Subsystems extend SubsystemBase, so the scheduler already calls each
     periodic(). Calling them again here would run every mechanism's loop twice
     per tick -- doubling the PID's effective sample rate and silently changing
     how the gains behave. */
  const periodic = '';

  return `package frc.robot.superstructure;

${usesDio ? 'import edu.wpi.first.wpilibj.DigitalInput;\n' : ''}import org.littletonrobotics.junction.Logger;
${members.map((p) => `import ${BASE_PKG}.${p.pkg}.${p.className};`).join('\n')}

/**
 * ${N} -- the coupled state of ${members.map((p) => p.className).join(' and ')}.
 *
 * A state here is a claim about the WHOLE mechanism group at once: asking for
 * {@code State.${stateNames[0] ?? 'DEFAULT'}} sets every subsystem's goal together, so the
 * combination can never be half-applied. That is why the states live here and
 * not in the caller -- a caller that sets each subsystem itself will eventually
 * set one and forget the other.
 *
 * Generated by Anodized from the "${group.label}" state block. Safe to edit.
 */
public class ${N} {
${fields}

  private State state = State.${stateNames[0] ?? 'DEFAULT'};

  /** Every combined state this mechanism group can hold. */
  public enum State {
${enumBody}
  }

${fieldBlock ? `\n${fieldBlock}\n` : ''}
  public ${N}(${params}) {
${assigns}
  }

  /**
   * Call once per loop from Robot.robotPeriodic().
   *
   * This only assigns states. Each subsystem's own periodic() is already run by
   * the command scheduler, so calling them again from here would step every
   * mechanism twice per tick and quietly double the PID sample rate.
   */
  public void periodic() {
${latches ? `    updateLatches();\n` : ''}${ruleChecks ? `    evaluateRules();\n` : ''}    applyState();
${periodic}
    Logger.recordOutput("${N}/State", state);
    Logger.recordOutput("${N}/AtState", atState());
  }
${ruleChecks ? `
  /**
   * The programming graph, checked every loop.
   *
   * Evaluated in the order the rules were wired, last match winning — the same
   * precedence the simulator applies, so what you saw there is what runs here.
   */
  private void evaluateRules() {
${ruleChecks}
  }
` : ''}${latches ? `
  /** Refreshes sticky conditions. Must run before the rules that read them. */
  private void updateLatches() {
${latches}
  }
` : ''}${setters ? `\n${setters}\n` : ''}
  public void setState(State state) {
    this.state = state;
  }

  public State getState() {
    return state;
  }

  /** True once every subsystem in the group has reached its part of the state. */
  public boolean atState() {
    return ${atGoal || 'true'};
  }

  /* Re-applied every loop rather than only on change: a subsystem that is
     reset, reconnected, or otherwise loses its goal gets it back on the next
     tick instead of sitting idle until something happens to call setState. */
  private void applyState() {
    switch (state) {
${dispatch}
    }
  }
}
`;
}

/* --- assembly ------------------------------------------------------------- */

function readmeFile(plans: SubsystemPlan[], groups: ResolvedStateGroup[]): string {
  const rows = plans.map((p) => {
    const v = vendorFor(p.mech.motorBlock.motorId);
    return `| \`${p.className}\` | ${p.mech.motorBlock.count}x ${p.mech.motorBlock.motorId} | ${
      v === 'talonfx' ? 'TalonFX / Phoenix 6' : v === 'sparkmax' ? 'SPARK MAX / REVLib' : '**not templated**'
    } | ${p.mode} | ${p.goals.length} |`;
  }).join('\n');

  const first = plans[0];

  return `# Generated subsystems

Exported from Anodized. These are **state-based**: each subsystem owns an enum
of states, \`setState\` changes which one is active, and \`periodic()\` runs it
every loop through a switch where each case drives the mechanism. The current
state is a public field, so anything can read it without an accessor. There are no \`Command\` factories — nothing takes
ownership of a mechanism for a while, so it can never be left holding a state
nobody asked for because a command ended early.

Subsystems do extend \`SubsystemBase\`, for scheduler-driven \`periodic()\`,
logging registration, and requirements plumbing. That is a base class, not a
control-flow style. If you want a Command at the edge (for a button binding),
write one that calls \`setGoal\` rather than one that drives hardware:

\`\`\`java
controller.a().onTrue(Commands.runOnce(() -> elevator.setState(State.L4), elevator));
\`\`\`

## What is here

| Subsystem | Motors | Hardware layer | Control | States |
| --- | --- | --- | --- | --- |
${rows}

Five files per mechanism, under \`frc/robot/subsystems/<name>/\`:

- \`<Name>Constants.java\` — gains, goal setpoints, conversion factor, current
  limit, CAN ids. Everything you edit at the field, in one \`static import\`-able
  place.
- \`<Name>IO.java\` — the hardware boundary: an \`@AutoLog\` inputs struct and the
  setters. Knows nothing about motor controllers.
- \`<Name>IOPhysical.java\` — real hardware, configured from the constants.
- \`<Name>IOSim.java\` — a WPILib physics sim seeded with the same plant.
- \`<Name>.java\` — goals and control, hardware-independent.

${groups.length ? `Combined states live in \`frc/robot/superstructure/\`, one class per state
block, because a state like "score L4" is a claim about several mechanisms at
once and splitting it across subsystems loses that.

` : ''}## Where the control loop lives

In the subsystem, not on the motor controller. Each closed-loop subsystem builds
a \`PIDController\` and a feedforward from its constants, and \`periodic()\` runs
them every tick:

\`\`\`java
// periodic()
switch (state) {
  case STOW -> runSetpoint(STOW_POSITION);
  case L4   -> runSetpoint(L4_POSITION);
}

// each case runs the state:
private void runSetpoint(double setpoint) {
  controller.setSetpoint(setpoint);
  double volts = controller.calculate(inputs.positionMeters) + feedforward.calculate(0.0);
  io.setVoltage(MathUtil.clamp(volts, -12.0, 12.0));
}
\`\`\`

That costs loop rate — a SPARK or Talon can close at 1 kHz internally, this
closes at the 50 Hz robot loop — and buys visibility: the gains, the setpoint,
and the state that chose it are in one file and all logged, rather than split
between code and a value burned into controller flash. Move it onboard once the
mechanism is tuned and the gains have stopped changing.

The IO layer takes exactly one command, \`setVoltage\`, and runs no loop of its
own. The sim layer is driven by the same controller, so the loop you tune
against the sim is the loop that runs on the robot.

## Wiring it up

\`\`\`java
// RobotContainer.java
private final ${first?.className ?? 'Elevator'} ${first ? camel(first.className) : 'elevator'} =
    new ${first?.className ?? 'Elevator'}(
        Robot.isReal()
            ? new ${first?.className ?? 'Elevator'}IOPhysical()
            : new ${first?.className ?? 'Elevator'}IOSim());
\`\`\`

\`periodic()\` is called by the scheduler — you do not need to call it yourself.

## Before this runs

Search the export for \`TODO\`. The simulator models physics, so it knows
gearing, inertia, and current limits. It has no way to know:

- **CAN ids** — every one is \`0\`.
- **Inversion and sensor phase** — positive must move the mechanism the same way
  positive moves it in the simulator.
- **Soft limits** — the simulator has no hard stops, so they ship disabled.

## About the gains

Gains are translated from the simulated tune (duty per unit of error, scaled by
a nominal 12 V bus) and are **a starting point only**. They were tuned against a
rigid, backlash-free, noise-free model. \`KS\` and \`KV\` start at zero because
static friction and velocity feedforward are not modelled at all. Retune on the
real mechanism.

\`MAX_VELOCITY\` and \`MAX_ACCELERATION\` are infinite, meaning no motion profile —
the controller drives straight at the setpoint, which is what was simulated. Set
real numbers to profile the approach, and expect to retune \`KP\` when you do.

## If you have tunable numbers

The constants files are the drop-in point. Replace a gain field with your
tunable type and nothing else in the mechanism changes — no logic file reads a
gain directly.

## Dependencies

AdvantageKit (for \`@AutoLog\`, \`@AutoLogOutput\`, and \`Logger\`), WPILib, plus
Phoenix 6 and/or REVLib depending on the hardware layers above.
`;
}

export interface GeneratedExport {
  entries: ZipEntry[];
  plans: SubsystemPlan[];
  warnings: string[];
}

/**
 * Which flavour of robot code to emit.
 *
 * 'classic' targets today's WPILib: SubsystemBase, a switch in periodic().
 * 'cmd3' targets the 2027 commands-v3 framework: Mechanism, coroutine-backed
 * commands, and the declarative StateMachine API. They are separate generators
 * rather than one with flags because the two frameworks disagree about what a
 * subsystem IS -- one is scheduled and polls, the other hands out commands that
 * own it -- and a single template trying to be both would serve neither.
 */
export type CodegenTarget = 'classic' | 'cmd3';

export function generateJava(
  sys: System, groups: MechanismGroup[], designName: string,
  target: CodegenTarget = 'classic',
): GeneratedExport {
  if (target === 'cmd3') return generateCmd3(sys, groups, designName);
  const plans = planSubsystems(sys, groups);
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];

  const root = pascal(designName, 'Anodized');

  for (const p of plans) {
    const dir = `${root}/src/main/java/frc/robot/subsystems/${p.pkg}`;
    entries.push({ path: `${dir}/${p.className}Constants.java`, text: constantsFile(p) });
    entries.push({ path: `${dir}/${p.className}IO.java`, text: ioFile(p) });
    entries.push({ path: `${dir}/${p.className}.java`, text: subsystemFile(p) });
    entries.push({ path: `${dir}/${p.className}IOPhysical.java`, text: physicalFile(p) });
    entries.push({ path: `${dir}/${p.className}IOSim.java`, text: simFile(p) });

    if (vendorFor(p.mech.motorBlock.motorId) === 'unknown') {
      warnings.push(
        `${p.className} uses ${p.mech.motorBlock.motorId}, a brushed motor — its hardware layer is a stub.`,
      );
    }
    if (p.goals.length === 1 && p.goals[0].name === 'DEFAULT') {
      warnings.push(
        `${p.className} has no state block, so it exported a single DEFAULT goal.`,
      );
    }
  }

  for (const group of sys.stateGroups) {
    const name = pascal(group.label, 'Superstructure');
    entries.push({
      path: `${root}/src/main/java/frc/robot/superstructure/${name}.java`,
      text: superstructureFile(group, plans, sys.program),
    });
  }

  entries.push({ path: `${root}/README.md`, text: readmeFile(plans, sys.stateGroups) });
  return { entries, plans, warnings };
}
