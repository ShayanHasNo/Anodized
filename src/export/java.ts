/**
 * WPILib + AdvantageKit code export.
 *
 * The generated code is STATE-BASED, not command-based. Each subsystem owns an
 * enum of goals and a `setGoal`; `periodic()` drives whatever the current goal
 * says. There are no Command classes, no `SubsystemBase`, and no imports from
 * `edu.wpi.first.wpilibj2.command` anywhere in the output -- a superstructure
 * asks "what state am I in, and what does that state want?" every loop, rather
 * than scheduling objects that own the mechanism for a while. That makes the
 * mechanism's behaviour a pure function of its state, which is exactly the
 * shape this simulator already models.
 *
 * The AdvantageKit split is the standard three files per mechanism:
 *
 *   <Name>IO.java          the hardware boundary -- inputs struct + setters
 *   <Name>IOPhysical.java  real motor controllers and sensors, configured
 *   <Name>.java            hardware-independent logic: goals and control
 *
 * plus a <Name>IOSim.java, because this tool already knows the plant exactly
 * (gearing, inertia, mass, drum radius), so seeding a WPILib physics sim with
 * those numbers is free and gives the generated code something to run against
 * before the mechanism is built.
 *
 * A NOTE ON WHAT THIS CANNOT KNOW: CAN ids, inversion, sensor phase, and
 * soft limits are not physics, so the simulator has no opinion about them.
 * They come out as named constants with TODO markers rather than plausible
 * guesses -- a wrong CAN id that looks deliberate is worse than an obvious
 * blank. Gains are translated from the simulated tune and marked as a starting
 * point, since a simulated plant is never the real one.
 */

import { System, Mechanism, MechanismGroup, ResolvedStateGroup } from '../sim/compile';
import { UNITS } from '../sim/units';
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

function gainsFor(mech: Mechanism): Gains {
  const c = mech.controller;
  if (c && c.kind === 'pid') {
    return {
      kP: c.kP * NOMINAL_VOLTS, kI: c.kI * NOMINAL_VOLTS, kD: c.kD * NOMINAL_VOLTS,
      kG: c.kF * NOMINAL_VOLTS, kS: 0, kV: 0,
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

export { gainsFor, num, pascal, vendorFor, DC_MOTOR };
export type { Vendor };

/* -------------------------------------------------------------------------
   Templates
   ------------------------------------------------------------------------- */

const BASE_PKG = 'frc.robot.subsystems';

function ioFile(p: SubsystemPlan): string {
  const N = p.className;
  return `package ${BASE_PKG}.${p.pkg};

import org.littletonrobotics.junction.AutoLog;

/**
 * Hardware boundary for the ${N} mechanism.
 *
 * Everything the subsystem can observe is an input; everything it can command
 * is a method. Nothing in this file knows what a motor controller is, which is
 * what lets ${N} run identically against real hardware, a physics sim, or a
 * replayed log.
 *
 * Generated by Anodized from the simulated mechanism. Safe to edit.
 */
public interface ${N}IO {
  @AutoLog
  public static class ${N}IOInputs {
    /** False when the motor controller has stopped answering. */
    public boolean connected = false;

    public double position${p.posSuffix} = 0.0;
    public double velocity${p.velSuffix} = 0.0;

    public double appliedVolts = 0.0;
    /** One entry per motor on the shaft (${p.mech.motorBlock.count} here). */
    public double[] statorCurrentAmps = new double[] {};
    public double[] supplyCurrentAmps = new double[] {};
    public double[] tempCelsius = new double[] {};
  }

  /** Reads every input from hardware. Called once per loop, before logic. */
  public default void updateInputs(${N}IOInputs inputs) {}

  /** Closed-loop position request, in ${p.posUnit}. */
  public default void setPositionSetpoint(double position${p.posSuffix}) {}

  /** Closed-loop velocity request, in ${p.velUnit}. */
  public default void setVelocitySetpoint(double velocity${p.velSuffix}) {}

  /** Open-loop voltage request. */
  public default void setVoltage(double volts) {}

  /** Neutral output. */
  public default void stop() {}

  public default void setBrakeMode(boolean enabled) {}

  /** Teaches the controller where the mechanism currently is. */
  public default void setPosition(double position${p.posSuffix}) {}
}
`;
}

function subsystemFile(p: SubsystemPlan): string {
  const N = p.className;
  const setpointUnit = p.mode === 'velocity' ? p.velUnit
    : p.mode === 'voltage' ? 'volts' : p.posUnit;
  const setpointSuffix = p.mode === 'velocity' ? p.velSuffix
    : p.mode === 'voltage' ? 'Volts' : p.posSuffix;
  const measured = p.mode === 'velocity'
    ? `inputs.velocity${p.velSuffix}` : `inputs.position${p.posSuffix}`;

  const goalLines = p.goals
    .map((g) => `    /** From the "${g.from}" state. */\n    ${g.name}(${num(g.value)})`)
    .join(',\n');

  const applyLine = p.mode === 'voltage'
    ? `io.setVoltage(goal.getSetpoint${setpointSuffix}());`
    : p.mode === 'velocity'
      ? `io.setVelocitySetpoint(goal.getSetpoint${setpointSuffix}());`
      : `io.setPositionSetpoint(goal.getSetpoint${setpointSuffix}());`;

  const atGoalBody = p.mode === 'voltage'
    ? `    // Open loop: there is no measurement being regulated, so "at goal"
    // only means the request has been issued. Reporting a tolerance check
    // here would invent a closed loop that does not exist.
    return true;`
    : `    return Math.abs(${measured} - goal.getSetpoint${setpointSuffix}()) <= TOLERANCE;`;

  return `package ${BASE_PKG}.${p.pkg};

import org.littletonrobotics.junction.Logger;

/**
 * ${N} -- a STATE-BASED subsystem.
 *
 * The mechanism is always in exactly one {@link Goal}, and {@link #periodic()}
 * drives toward whatever that goal asks for, every loop, unconditionally.
 * Changing what the mechanism does means changing its goal; nothing takes
 * ownership of it, and there is no queue of pending work. That is the whole
 * difference from a command-based subsystem, and it is why a mechanism can
 * never be left in a state nobody asked for because a command ended early.
 *
 * Call {@link #periodic()} from Robot.robotPeriodic() once per loop.
 *
 * Generated by Anodized from the simulated mechanism. Safe to edit.
 */
public class ${N} {
  /** Every state this mechanism can be asked to hold. */
  public enum Goal {
${goalLines};

    private final double setpoint;

    Goal(double setpoint) {
      this.setpoint = setpoint;
    }

    /** Setpoint for this goal, in ${setpointUnit}. */
    public double getSetpoint${setpointSuffix}() {
      return setpoint;
    }
  }

  /** How close counts as "there", in ${setpointUnit}. TODO: tune on the robot. */
  private static final double TOLERANCE = ${num(toleranceFor(p))};

  private final ${N}IO io;
  private final ${N}IOInputsAutoLogged inputs = new ${N}IOInputsAutoLogged();

  private Goal goal = Goal.${p.goals[0].name};

  public ${N}(${N}IO io) {
    this.io = io;
  }

  public void periodic() {
    io.updateInputs(inputs);
    Logger.processInputs("${N}", inputs);

    ${applyLine}

    Logger.recordOutput("${N}/Goal", goal);
    Logger.recordOutput("${N}/Setpoint", goal.getSetpoint${setpointSuffix}());
    Logger.recordOutput("${N}/AtGoal", atGoal());
  }

  /** Asks the mechanism to hold a different state. Takes effect next loop. */
  public void setGoal(Goal goal) {
    this.goal = goal;
  }

  public Goal getGoal() {
    return goal;
  }

  public boolean atGoal() {
${atGoalBody}
  }

  public double getPosition${p.posSuffix}() {
    return inputs.position${p.posSuffix};
  }

  public double getVelocity${p.velSuffix}() {
    return inputs.velocity${p.velSuffix};
  }

  /** True when the hardware has stopped reporting -- worth surfacing to drivers. */
  public boolean isConnected() {
    return inputs.connected;
  }

  public void stop() {
    io.stop();
  }
}
`;
}

/** A tolerance that is meaningful in the mechanism's own units. */
function toleranceFor(p: SubsystemPlan): number {
  if (p.mode === 'voltage') return 0;
  const span = p.goals.reduce((max, g) => Math.max(max, Math.abs(g.value)), 0);
  // 2% of the largest commanded setpoint, floored so a mechanism whose states
  // are all near zero still gets a usable band rather than 0.
  const unit = p.mode === 'velocity' ? p.velUnit : p.posUnit;
  const floor = unit === 'm' ? 0.005 : unit === 'deg' ? 1 : unit === 'rot' ? 0.01 : 0.01;
  return Math.max(span * 0.02, floor);
}

function physicalFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const vendor = vendorFor(m.motorBlock.motorId);
  const g = gainsFor(m);
  const count = m.motorBlock.count;

  if (vendor === 'unknown') {
    return `package ${BASE_PKG}.${p.pkg};

/**
 * ${N} hardware layer -- NOT GENERATED.
 *
 * The simulated mechanism uses ${count}x "${m.motorBlock.motorId}", a brushed
 * motor. Anodized only templates smart controllers (TalonFX via Phoenix 6, and
 * SPARK MAX via REVLib), and emitting one of those here would produce code that
 * compiles and then does not run.
 *
 * Implement ${N}IO against whatever controller actually drives this mechanism.
 * The numbers the simulator does know are below, in the units the rest of the
 * generated code expects.
 *
 *   reduction              ${num(m.ratio, 4)} : 1
 *   ${p.posUnit} per rotor rotation   ${num(p.unitsPerMotorRotation, 8)}
 *   current limit          ${m.motorBlock.currentLimit} A per motor
 *   suggested kP / kI / kD ${num(g.kP)} / ${num(g.kI)} / ${num(g.kD)}  (volts per ${p.posUnit} of error)
 */
public class ${N}IOPhysical implements ${N}IO {
  // TODO: implement against the real motor controller.
}
`;
  }

  const conv = `  /**
   * ${p.posUnit} of mechanism travel per ROTOR rotation.
   *
   * ${m.linearDisplay
      ? `The drum turns rotation into travel: one output turn pays out
   * 2*pi*r = ${num(2 * Math.PI * (m.radius ?? 0), 6)} m of cable, and the rotor turns
   * ${num(m.ratio, 4)} times per output turn.`
      : `One output turn is 2*pi rad, and the rotor turns
   * ${num(m.ratio, 4)} times per output turn.`}
   */
  private static final double UNITS_PER_ROTOR_ROTATION = ${num(p.unitsPerMotorRotation, 8)};`;

  return vendor === 'talonfx'
    ? talonFile(p, g, conv)
    : sparkFile(p, g, conv);
}

function talonFile(p: SubsystemPlan, g: Gains, conv: string): string {
  const N = p.className;
  const m = p.mech;
  const count = m.motorBlock.count;
  const followers = Array.from({ length: count - 1 }, (_, i) => i + 1);
  const gravityType = p.archetype === 'arm' ? 'Arm_Cosine' : 'Elevator_Static';

  return `package ${BASE_PKG}.${p.pkg};

import com.ctre.phoenix6.BaseStatusSignal;
import com.ctre.phoenix6.StatusSignal;
import com.ctre.phoenix6.configs.TalonFXConfiguration;
import com.ctre.phoenix6.controls.NeutralOut;
import com.ctre.phoenix6.controls.PositionVoltage;
import com.ctre.phoenix6.controls.VelocityVoltage;
import com.ctre.phoenix6.controls.VoltageOut;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.signals.GravityTypeValue;
import com.ctre.phoenix6.signals.InvertedValue;
import com.ctre.phoenix6.signals.NeutralModeValue;
import edu.wpi.first.units.measure.Angle;
import edu.wpi.first.units.measure.AngularVelocity;
import edu.wpi.first.units.measure.Current;
import edu.wpi.first.units.measure.Temperature;
import edu.wpi.first.units.measure.Voltage;

/**
 * ${N} hardware: ${count}x ${m.motorBlock.motorId} on TalonFX (Phoenix 6).
 *
 * This is the only file that knows about motor controllers. Everything the
 * simulator could derive is filled in; everything it cannot -- CAN ids, which
 * way is positive, where the soft limits are -- is marked TODO, because a
 * plausible-looking guess is harder to catch than an obvious blank.
 *
 * Generated by Anodized. Safe to edit.
 */
public class ${N}IOPhysical implements ${N}IO {
  // TODO: set the real CAN ids and bus name.
  private static final int LEADER_CAN_ID = 0;${followers.length
    ? `\n  private static final int[] FOLLOWER_CAN_IDS = new int[] {${followers.map(() => '0').join(', ')}};`
    : ''}
  private static final String CAN_BUS = "rio";

  // TODO: confirm direction against the real mechanism -- positive should move
  // the mechanism the same way positive does in the simulator.
  private static final InvertedValue INVERSION = InvertedValue.CounterClockwise_Positive;

  /** Per-motor stator limit, from the simulated mechanism. */
  private static final double STATOR_LIMIT_AMPS = ${num(m.motorBlock.currentLimit, 1)};
  private static final double SUPPLY_LIMIT_AMPS = ${num(Math.min(m.motorBlock.currentLimit, 60), 1)};

${conv}

  private final TalonFX leader = new TalonFX(LEADER_CAN_ID, CAN_BUS);${followers.length
    ? `\n  private final TalonFX[] followers = new TalonFX[FOLLOWER_CAN_IDS.length];`
    : ''}

  private final StatusSignal<Angle> positionRotations;
  private final StatusSignal<AngularVelocity> velocityRps;
  private final StatusSignal<Voltage> appliedVolts;
  private final StatusSignal<Current> statorCurrent;
  private final StatusSignal<Current> supplyCurrent;
  private final StatusSignal<Temperature> temperature;

  /* Reused request objects. Phoenix allocates inside a control request, so
     building one per loop is avoidable garbage in the hot path. */
  private final PositionVoltage positionRequest = new PositionVoltage(0.0).withSlot(0);
  private final VelocityVoltage velocityRequest = new VelocityVoltage(0.0).withSlot(0);
  private final VoltageOut voltageRequest = new VoltageOut(0.0);
  private final NeutralOut neutralRequest = new NeutralOut();

  public ${N}IOPhysical() {
    TalonFXConfiguration config = new TalonFXConfiguration();

    config.MotorOutput.Inverted = INVERSION;
    config.MotorOutput.NeutralMode = NeutralModeValue.Brake;

    config.CurrentLimits.StatorCurrentLimit = STATOR_LIMIT_AMPS;
    config.CurrentLimits.StatorCurrentLimitEnable = true;
    config.CurrentLimits.SupplyCurrentLimit = SUPPLY_LIMIT_AMPS;
    config.CurrentLimits.SupplyCurrentLimitEnable = true;

    /* Gains translated from the simulated tune: the simulator works in duty
       per unit of error, and these requests output volts, so each gain is
       scaled by the nominal ${num(NOMINAL_VOLTS, 1)} V bus.

       TREAT THESE AS A STARTING POINT. They were tuned against a rigid,
       backlash-free, noise-free model of this mechanism. Real friction,
       real compliance, and real sensor noise are not in that model. */
    config.Slot0.kP = ${num(g.kP)};
    config.Slot0.kI = ${num(g.kI)};
    config.Slot0.kD = ${num(g.kD)};
    config.Slot0.kG = ${num(g.kG)};
    config.Slot0.GravityType = GravityTypeValue.${gravityType};

    // Gains are in ${p.posUnit}, so the controller has to report ${p.posUnit}.
    config.Feedback.SensorToMechanismRatio = 1.0 / UNITS_PER_ROTOR_ROTATION;

    // TODO: set soft limits once the mechanism's real range is known.
    // config.SoftwareLimitSwitch.ForwardSoftLimitEnable = true;
    // config.SoftwareLimitSwitch.ForwardSoftLimitThreshold = 0.0;

    leader.getConfigurator().apply(config);
${followers.length ? `
    for (int i = 0; i < FOLLOWER_CAN_IDS.length; i++) {
      followers[i] = new TalonFX(FOLLOWER_CAN_IDS[i], CAN_BUS);
      followers[i].getConfigurator().apply(config);
      // TODO: second argument is "opposeMasterDirection" -- true when the
      // motors face opposite ways on the gearbox.
      followers[i].setControl(new com.ctre.phoenix6.controls.Follower(LEADER_CAN_ID, false));
    }
` : ''}
    positionRotations = leader.getPosition();
    velocityRps = leader.getVelocity();
    appliedVolts = leader.getMotorVoltage();
    statorCurrent = leader.getStatorCurrent();
    supplyCurrent = leader.getSupplyCurrent();
    temperature = leader.getDeviceTemp();

    BaseStatusSignal.setUpdateFrequencyForAll(
        50.0, positionRotations, velocityRps, appliedVolts,
        statorCurrent, supplyCurrent, temperature);
    leader.optimizeBusUtilization();
  }

  @Override
  public void updateInputs(${N}IOInputs inputs) {
    inputs.connected =
        BaseStatusSignal.refreshAll(
                positionRotations, velocityRps, appliedVolts,
                statorCurrent, supplyCurrent, temperature)
            .isOK();

    inputs.position${p.posSuffix} = positionRotations.getValueAsDouble();
    inputs.velocity${p.velSuffix} = velocityRps.getValueAsDouble();
    inputs.appliedVolts = appliedVolts.getValueAsDouble();
    inputs.statorCurrentAmps = new double[] {statorCurrent.getValueAsDouble()};
    inputs.supplyCurrentAmps = new double[] {supplyCurrent.getValueAsDouble()};
    inputs.tempCelsius = new double[] {temperature.getValueAsDouble()};
  }

  @Override
  public void setPositionSetpoint(double position${p.posSuffix}) {
    leader.setControl(positionRequest.withPosition(position${p.posSuffix}));
  }

  @Override
  public void setVelocitySetpoint(double velocity${p.velSuffix}) {
    leader.setControl(velocityRequest.withVelocity(velocity${p.velSuffix}));
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
  public void setPosition(double position${p.posSuffix}) {
    leader.setPosition(position${p.posSuffix});
  }
}
`;
}

function sparkFile(p: SubsystemPlan, g: Gains, conv: string): string {
  const N = p.className;
  const m = p.mech;
  const count = m.motorBlock.count;
  const brushed = false;

  return `package ${BASE_PKG}.${p.pkg};

import com.revrobotics.RelativeEncoder;
import com.revrobotics.spark.SparkBase.ControlType;
import com.revrobotics.spark.SparkBase.PersistMode;
import com.revrobotics.spark.SparkBase.ResetMode;
import com.revrobotics.spark.SparkClosedLoopController;
import com.revrobotics.spark.SparkLowLevel.MotorType;
import com.revrobotics.spark.SparkMax;
import com.revrobotics.spark.config.SparkBaseConfig.IdleMode;
import com.revrobotics.spark.config.SparkMaxConfig;

/**
 * ${N} hardware: ${count}x ${m.motorBlock.motorId} on SPARK MAX (REVLib).
 *
 * This is the only file that knows about motor controllers. Everything the
 * simulator could derive is filled in; everything it cannot -- CAN ids, which
 * way is positive, where the soft limits are -- is marked TODO, because a
 * plausible-looking guess is harder to catch than an obvious blank.
 *
 * Generated by Anodized. Safe to edit.
 */
public class ${N}IOPhysical implements ${N}IO {
  // TODO: set the real CAN ids.
  private static final int LEADER_CAN_ID = 0;${count > 1
    ? `\n  private static final int[] FOLLOWER_CAN_IDS = new int[] {${Array.from({ length: count - 1 }, () => '0').join(', ')}};`
    : ''}

  // TODO: confirm direction against the real mechanism.
  private static final boolean INVERTED = false;

  private static final int CURRENT_LIMIT_AMPS = ${Math.round(m.motorBlock.currentLimit)};

${conv}

  private final SparkMax leader = new SparkMax(LEADER_CAN_ID, MotorType.k${brushed ? 'Brushed' : 'Brushless'});${count > 1
    ? `\n  private final SparkMax[] followers = new SparkMax[FOLLOWER_CAN_IDS.length];`
    : ''}
  private final RelativeEncoder encoder = leader.getEncoder();
  private final SparkClosedLoopController controller = leader.getClosedLoopController();

  public ${N}IOPhysical() {
    SparkMaxConfig config = new SparkMaxConfig();
    config.inverted(INVERTED).idleMode(IdleMode.kBrake).smartCurrentLimit(CURRENT_LIMIT_AMPS);

    /* The encoder is scaled so every reading is already in ${p.posUnit} --
       the subsystem, the gains, and the setpoints then all share one unit and
       nothing has to remember to convert. */
    config.encoder
        .positionConversionFactor(UNITS_PER_ROTOR_ROTATION)
        .velocityConversionFactor(UNITS_PER_ROTOR_ROTATION / 60.0);

    /* Gains translated from the simulated tune: the simulator works in duty
       per unit of error, and these are volts per unit, so each is scaled by
       the nominal ${num(NOMINAL_VOLTS, 1)} V bus.

       TREAT THESE AS A STARTING POINT -- they were tuned against a rigid,
       frictionless, noise-free model. */
    config.closedLoop.pid(${num(g.kP)}, ${num(g.kI)}, ${num(g.kD)});

    leader.configure(config, ResetMode.kResetSafeParameters, PersistMode.kPersistParameters);
${count > 1 ? `
    for (int i = 0; i < FOLLOWER_CAN_IDS.length; i++) {
      followers[i] = new SparkMax(FOLLOWER_CAN_IDS[i], MotorType.kBrushless);
      SparkMaxConfig followerConfig = new SparkMaxConfig();
      followerConfig.apply(config);
      // TODO: second argument is "invert relative to leader".
      followerConfig.follow(LEADER_CAN_ID, false);
      followers[i].configure(
          followerConfig, ResetMode.kResetSafeParameters, PersistMode.kPersistParameters);
    }
` : ''}
    encoder.setPosition(0.0);
  }

  @Override
  public void updateInputs(${N}IOInputs inputs) {
    // REVLib surfaces faults rather than a link state; a sticky fault frame
    // that never arrives leaves this false.
    inputs.connected = leader.getFirmwareVersion() != 0;

    inputs.position${p.posSuffix} = encoder.getPosition();
    inputs.velocity${p.velSuffix} = encoder.getVelocity();
    inputs.appliedVolts = leader.getAppliedOutput() * leader.getBusVoltage();
    inputs.statorCurrentAmps = new double[] {leader.getOutputCurrent()};
    inputs.supplyCurrentAmps = new double[] {leader.getOutputCurrent()};
    inputs.tempCelsius = new double[] {leader.getMotorTemperature()};
  }

  @Override
  public void setPositionSetpoint(double position${p.posSuffix}) {
    controller.setReference(position${p.posSuffix}, ControlType.kPosition);
  }

  @Override
  public void setVelocitySetpoint(double velocity${p.velSuffix}) {
    controller.setReference(velocity${p.velSuffix}, ControlType.kVelocity);
  }

  @Override
  public void setVoltage(double volts) {
    leader.setVoltage(volts);
  }

  @Override
  public void stop() {
    leader.stopMotor();
  }

  @Override
  public void setBrakeMode(boolean enabled) {
    SparkMaxConfig config = new SparkMaxConfig();
    config.idleMode(enabled ? IdleMode.kBrake : IdleMode.kCoast);
    leader.configure(config, ResetMode.kNoResetSafeParameters, PersistMode.kNoPersistParameters);
  }

  @Override
  public void setPosition(double position${p.posSuffix}) {
    encoder.setPosition(position${p.posSuffix});
  }
}
`;
}

function simFile(p: SubsystemPlan): string {
  const N = p.className;
  const m = p.mech;
  const g = gainsFor(m);
  const dc = DC_MOTOR[m.motorBlock.motorId] ?? 'getKrakenX60';
  const count = m.motorBlock.count;
  const toBase = UNITS[p.posUnit]?.toBase ?? 1;

  // The WPILib sims all work in SI, so the IO layer converts at its boundary
  // exactly the way the real controller's conversion factor does.
  let decl: string;
  let read: string;
  let readVel: string;
  if (p.archetype === 'elevator') {
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
    decl = `  private final FlywheelSim sim =
      new FlywheelSim(
          LinearSystemId.createFlywheelSystem(
              DCMotor.${dc}(${count}), ${num(m.inertiaSolid, 8)}, ${num(m.ratio, 4)}),
          DCMotor.${dc}(${count}));`;
    read = '0.0';
    readVel = 'sim.getAngularVelocityRadPerSec()';
  }

  const limits = p.archetype === 'elevator'
    ? `  // TODO: the simulator has no travel limits, so these are the observed
  // range padded out. Set them to the mechanism's real hard stops.
  private static final double MIN_HEIGHT_METERS = 0.0;
  private static final double MAX_HEIGHT_METERS = 2.0;
`
    : p.archetype === 'arm'
      ? `  // TODO: set to the mechanism's real hard stops.
  private static final double MIN_ANGLE_RADS = -Math.PI;
  private static final double MAX_ANGLE_RADS = Math.PI;
`
      : '';

  const imports = p.archetype === 'elevator'
    ? 'import edu.wpi.first.wpilibj.simulation.ElevatorSim;'
    : p.archetype === 'arm'
      ? 'import edu.wpi.first.wpilibj.simulation.SingleJointedArmSim;'
      : 'import edu.wpi.first.math.system.plant.LinearSystemId;\nimport edu.wpi.first.wpilibj.simulation.FlywheelSim;';

  return `package ${BASE_PKG}.${p.pkg};

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.controller.PIDController;
import edu.wpi.first.math.system.plant.DCMotor;
${imports}

/**
 * ${N} against a WPILib physics sim, seeded with the plant Anodized solved:
 * ${num(m.ratio, 3)}:1 reduction, ${num(m.solid.mass, 3)} kg, ${p.archetype} geometry.
 *
 * This is not the same integrator Anodized uses, so it will not match the
 * tool's traces exactly -- it is here so the generated subsystem has something
 * to run against before the mechanism physically exists.
 *
 * Generated by Anodized. Safe to edit.
 */
public class ${N}IOSim implements ${N}IO {
  private static final double LOOP_PERIOD_SECS = 0.02;

  /** SI per display unit, so the sim's metres/radians become ${p.posUnit}. */
  private static final double BASE_PER_UNIT = ${num(toBase, 8)};

${limits}${decl}

  private final PIDController controller =
      new PIDController(${num(g.kP)}, ${num(g.kI)}, ${num(g.kD)});

  private double appliedVolts = 0.0;
  private boolean closedLoop = false;

  @Override
  public void updateInputs(${N}IOInputs inputs) {
    if (closedLoop) {
      appliedVolts =
          MathUtil.clamp(controller.calculate(${read} / BASE_PER_UNIT) + ${num(g.kG)}, -12.0, 12.0);
    }
    sim.setInputVoltage(appliedVolts);
    sim.update(LOOP_PERIOD_SECS);

    inputs.connected = true;
    inputs.position${p.posSuffix} = ${read} / BASE_PER_UNIT;
    inputs.velocity${p.velSuffix} = ${readVel} / BASE_PER_UNIT;
    inputs.appliedVolts = appliedVolts;
    inputs.statorCurrentAmps = new double[] {sim.getCurrentDrawAmps()};
    inputs.supplyCurrentAmps = new double[] {sim.getCurrentDrawAmps()};
    inputs.tempCelsius = new double[] {0.0};
  }

  @Override
  public void setPositionSetpoint(double position${p.posSuffix}) {
    closedLoop = true;
    controller.setSetpoint(position${p.posSuffix});
  }

  @Override
  public void setVelocitySetpoint(double velocity${p.velSuffix}) {
    closedLoop = true;
    controller.setSetpoint(velocity${p.velSuffix});
  }

  @Override
  public void setVoltage(double volts) {
    closedLoop = false;
    appliedVolts = MathUtil.clamp(volts, -12.0, 12.0);
  }

  @Override
  public void stop() {
    setVoltage(0.0);
  }
}
`;
}

/* --- superstructure -------------------------------------------------------
   A state block spans several mechanisms on purpose -- "score L4" is a claim
   about the elevator AND the wrist at once. Generating one enum per subsystem
   and stopping there would throw that coupling away and leave the caller to
   remember which goals go together, which is exactly the bug states exist to
   prevent. */

function superstructureFile(
  group: ResolvedStateGroup, plans: SubsystemPlan[],
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
      return `        ${camel(p.className)}.setGoal(${p.className}.Goal.${goal});`;
    }).join('\n');
    return `      case ${n} ->  {\n${lines}\n      }`;
  }).join('\n');

  const atGoal = members
    .map((p) => `${camel(p.className)}.atGoal()`).join('\n        && ');

  const periodic = members
    .map((p) => `    ${camel(p.className)}.periodic();`).join('\n');

  return `package frc.robot.superstructure;

import org.littletonrobotics.junction.Logger;
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

  public ${N}(${params}) {
${assigns}
  }

  /** Call once per loop from Robot.robotPeriodic(). */
  public void periodic() {
    applyState();

${periodic}

    Logger.recordOutput("${N}/State", state);
    Logger.recordOutput("${N}/AtState", atState());
  }

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

  return `# Generated subsystems

Exported from Anodized. These are **state-based**, not command-based: every
subsystem owns an enum of goals, \`setGoal\` changes which one is active, and
\`periodic()\` drives toward it every loop. Nothing here imports
\`edu.wpi.first.wpilibj2.command\`.

## What is here

| Subsystem | Motors | Hardware layer | Control | Goals |
| --- | --- | --- | --- | --- |
${rows}

Each mechanism gets four files under \`frc/robot/subsystems/<name>/\`:

- \`<Name>IO.java\` — the hardware boundary: an \`@AutoLog\` inputs struct and
  the setters. Knows nothing about motor controllers.
- \`<Name>IOPhysical.java\` — real hardware, configured from the simulated
  mechanism (gearing, current limits, translated gains).
- \`<Name>IOSim.java\` — a WPILib physics sim seeded with the same plant, so the
  logic can run before the mechanism exists.
- \`<Name>.java\` — the goals and the control logic, hardware-independent.

${groups.length ? `Combined states live in \`frc/robot/superstructure/\`, one class per state
block, because a state like "score L4" is a claim about several mechanisms at
once and splitting it across subsystems loses that.` : ''}

## Wiring it up

\`\`\`java
// Robot.java
private final Elevator elevator =
    new Elevator(Robot.isReal() ? new ElevatorIOPhysical() : new ElevatorIOSim());

@Override
public void robotPeriodic() {
  elevator.periodic();   // or superstructure.periodic(), which calls each one
}
\`\`\`

## Before this runs

Search the export for \`TODO\`. The simulator models physics, so it knows
gearing, inertia, and current limits — it has no way to know:

- **CAN ids** — every one is \`0\`.
- **Inversion and sensor phase** — positive has to move the mechanism the same
  way it does in the simulator.
- **Soft limits** — the simulator has no hard stops.

## About the gains

Gains are translated from the simulated tune (duty per unit of error, scaled by
a nominal 12 V bus) and are **a starting point only**. They were tuned against a
rigid, backlash-free, noise-free model. Retune on the real mechanism.

## Dependencies

AdvantageKit (for \`@AutoLog\` and \`Logger\`), plus Phoenix 6 and/or REVLib
depending on the hardware layers above.
`;
}

export interface GeneratedExport {
  entries: ZipEntry[];
  plans: SubsystemPlan[];
  warnings: string[];
}

export function generateJava(
  sys: System, groups: MechanismGroup[], designName: string,
): GeneratedExport {
  const plans = planSubsystems(sys, groups);
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];

  const root = pascal(designName, 'Anodized');

  for (const p of plans) {
    const dir = `${root}/src/main/java/frc/robot/subsystems/${p.pkg}`;
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
      text: superstructureFile(group, plans),
    });
  }

  entries.push({ path: `${root}/README.md`, text: readmeFile(plans, sys.stateGroups) });
  return { entries, plans, warnings };
}
