/**
 * 2027 code export -- WPILib commands v3 and the declarative StateMachine API.
 *
 * Targets the framework merged in allwpilib#8297. Three things differ from the
 * classic target, and they cascade:
 *
 * 1. `SubsystemBase` becomes `Mechanism` (package `org.wpilib.command3`). A
 *    mechanism is not polled by a scheduler; it hands out commands that take
 *    exclusive ownership of it while they run.
 *
 * 2. Commands are coroutine bodies rather than lifecycle objects. Instead of
 *    `initialize/execute/isFinished/end` spread across methods, a command is one
 *    loop that calls `coroutine.yield()` -- so "drive to a setpoint and stop
 *    when you get there" is literally a while loop.
 *
 * 3. States become first-class. `StateMachine` holds a state per command and
 *    declares transitions between them, so the switch statement the classic
 *    target generates is replaced by a transition graph the framework walks.
 *
 * WHY A SEPARATE FILE rather than flags through the classic templates: the two
 * frameworks disagree about what a subsystem fundamentally is. One is polled
 * and owns itself; the other is owned by whichever command holds it. Trying to
 * express both from one set of templates produces code that is idiomatic in
 * neither, and every future edit has to be reasoned about twice.
 *
 * WHAT IS SHARED: the constants, IO interface, hardware layer, and sim layer
 * are imported from the classic generator unchanged. None of them touch the
 * command framework -- an encoder reads the same and a TalonFX configures the
 * same in either world -- so duplicating them would just create two things to
 * fix when a conversion factor is wrong.
 *
 * A NOTE ON `Mechanism`'s constructor: this generator emits `super("Name")`. The
 * commands-v3 API was still settling when this was written, so if the base
 * class ends up with a different constructor that one line is the thing to fix.
 */

import {
  System, MechanismGroup, ResolvedStateGroup, ConditionNode, ProgramGraph,
} from '../sim/compile';
import {
  conditionExpr, conditionFields, triggerSetters, latchUpdates,
  needsDigitalInput, type ConditionContext,
} from './conditions';

/** A short human phrase for a condition, used in generated comments. */
function describeCond(node: ConditionNode): string {
  switch (node.kind) {
    case 'sensor':
      return `${node.label} (${node.signal} ${node.direction === 'above' ? '\u2265' : '\u2264'} ${num(node.threshold, 3)} ${node.unit})`;
    case 'trigger': return node.label;
    case 'and': return `${describeCond(node.a)} and ${describeCond(node.b)}`;
    case 'or': return `${describeCond(node.a)} or ${describeCond(node.b)}`;
    case 'not': return `not ${describeCond(node.a)}`;
    case 'latch': return `${node.label} has fired`;
  }
}
import type { ZipEntry } from './zip';
import {
  planSubsystems, type SubsystemPlan, type GeneratedExport,
  gainsFor, num, pascal, camel, constantName, vendorFor, goalConstant,
  constantsFile, ioFile, physicalFile, simFile, toleranceFor, BASE_PKG,
} from './java';

/* --- the mechanism ------------------------------------------------------- */

function mechanismFile(p: SubsystemPlan): string {
  const N = p.className;
  const closedLoop = p.mode !== 'voltage';
  const velocityMode = p.mode === 'velocity';
  const unit = p.mode === 'voltage' ? 'volts' : velocityMode ? p.velUnit : p.posUnit;
  const measured = velocityMode
    ? `inputs.velocity${p.velSuffix}` : `inputs.position${p.posSuffix}`;

  const ffDecl = p.archetype === 'arm'
    ? `  /* Arm gravity load varies with angle, so the feedforward needs the angle.
     It wants radians regardless of the unit the rest of this file uses. */
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

  const stateEnum = p.goals
    .map((g) => `    /** From the "${g.from}" state. */\n    ${g.name}(${goalConstant(p, g.name)})`)
    .join(',\n');

  if (!closedLoop) {
    return `package ${BASE_PKG}.${p.pkg};

import static ${BASE_PKG}.${p.pkg}.${N}Constants.*;

import edu.wpi.first.math.MathUtil;
import org.littletonrobotics.junction.Logger;
import org.wpilib.command3.Command;
import org.wpilib.command3.Mechanism;

/**
 * ${N} — an open-loop mechanism for WPILib commands v3.
 *
 * Each state names a voltage and {@link #toState} hands back a command that
 * holds it. There is no controller because there is nothing being regulated: a
 * roller either spins or it does not.
 *
 * Generated by Anodized (2027 / commands v3 target). Safe to edit.
 */
public class ${N} extends Mechanism {
  /** Every state this mechanism can be in. */
  public enum State {
${stateEnum};

    private final double volts;

    State(double volts) {
      this.volts = volts;
    }

    /** Voltage this state drives at. */
    public double getVolts() {
      return volts;
    }
  }

  private final ${N}IO io;
  private final ${N}IOInputsAutoLogged inputs = new ${N}IOInputsAutoLogged();

  /** The state currently being driven. Read-only from outside. */
  private State state = State.${p.goals[0].name};

  public ${N}(${N}IO io) {
    super("${N}");
    this.io = io;

    /* A default command matters more in v3 than it did before. A command owns
       this mechanism only while it runs, so without a default the mechanism is
       left "owned but uncommanded" between commands -- still holding whatever
       the last motor request was. Parking it in its first state makes idle
       behaviour explicit. */
    setDefaultCommand(holdState(State.${p.goals[0].name}));
  }

  /**
   * Applies a state and completes immediately.
   *
   * Open loop, so there is nothing to converge on — once the voltage is
   * requested the state IS reached. It completes on the first iteration so that
   * a StateMachine can use {@code .whenComplete()} on it exactly like a
   * closed-loop mechanism's {@code toState}; a version that never finished
   * would stall any parallel group it was placed in.
   */
  public Command toState(State target) {
    return run(coroutine -> {
          drive(target);
          coroutine.yield();
        })
        .named("${N}: To " + target);
  }

  /**
   * Applies a state and never completes.
   *
   * For the default command, and for holding a roller on while something else
   * happens. Interrupt it by scheduling anything else requiring this mechanism.
   */
  public Command holdState(State target) {
    return run(coroutine -> {
          while (true) {
            drive(target);
            coroutine.yield();
          }
        })
        .named("${N}: Hold " + target);
  }

  /** One iteration of the output loop. Shared so the two commands cannot drift. */
  private void drive(State target) {
    state = target;
    io.updateInputs(inputs);
    Logger.processInputs("${N}", inputs);
    io.setVoltage(MathUtil.clamp(target.getVolts(), -12.0, 12.0));
    Logger.recordOutput("${N}/State", state);
  }

  /** Open loop: the request is either issued or it is not. */
  public boolean atState() {
    return true;
  }

  public State getState() {
    return state;
  }

  public double getVelocity${p.velSuffix}() {
    return inputs.velocity${p.velSuffix};
  }

  public boolean isConnected() {
    return inputs.connected;
  }

  /** A command that cuts output and completes immediately. */
  public Command stop() {
    return run(coroutine -> io.stop()).named("${N}: Stop");
  }
}
`;
  }

  return `package ${BASE_PKG}.${p.pkg};

import static ${BASE_PKG}.${p.pkg}.${N}Constants.*;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.controller.PIDController;
${ffImport}
import org.littletonrobotics.junction.Logger;
import org.wpilib.command3.Command;
import org.wpilib.command3.Mechanism;

/**
 * ${N} — a mechanism for WPILib commands v3.
 *
 * States are values; behaviour is commands. {@link #toState} drives to a state
 * and COMPLETES when it arrives, which is what makes it usable as a
 * {@code StateMachine} state with a {@code .whenComplete()} transition.
 * {@link #holdState} drives the same setpoint but never finishes, for holding
 * against gravity while something else happens.
 *
 * The control loop is a plain while loop that yields — no lifecycle methods,
 * because a v3 command is a coroutine. Read {@link #toState} top to bottom and
 * that is the entire behaviour.
 *
 * Generated by Anodized (2027 / commands v3 target). Safe to edit.
 */
public class ${N} extends Mechanism {
  /** Every state this mechanism can be in. */
  public enum State {
${stateEnum};

    private final double setpoint;

    State(double setpoint) {
      this.setpoint = setpoint;
    }

    /** Setpoint for this state, in ${unit}. */
    public double getSetpoint() {
      return setpoint;
    }
  }

  private final ${N}IO io;
  private final ${N}IOInputsAutoLogged inputs = new ${N}IOInputsAutoLogged();

  private final PIDController controller = new PIDController(KP, KI, KD);
${ffDecl}

  /** The state currently being driven. Read-only from outside. */
  private State state = State.${p.goals[0].name};

  public ${N}(${N}IO io) {
    super("${N}");
    this.io = io;
    controller.setTolerance(TOLERANCE);

    /* A default command matters more in v3 than it did before. A command owns
       this mechanism only while it runs, so without a default the mechanism is
       left "owned but uncommanded" between commands -- for anything holding
       against gravity that means sagging. Holding the first state keeps the
       loop closed whenever nothing else has asked for something. */
    setDefaultCommand(holdState(State.${p.goals[0].name}));
  }

  /**
   * Drives to a state and completes once it is there.
   *
   * The completion is the point: it lets a StateMachine say
   * {@code stow.switchTo(scoring).whenComplete()} without a separate "are we
   * there yet" condition, and it lets {@code coroutine.await(...)} read as a
   * blocking call in a sequence.
   */
  public Command toState(State target) {
    return run(coroutine -> {
          state = target;
          do {
            drive(target);
            coroutine.yield();
          } while (!controller.atSetpoint());
        })
        .named("${N}: To " + target);
  }

  /**
   * Drives a state and never completes.
   *
   * For holding a position while something else runs, and for the default
   * command. Interrupt it by scheduling anything else that requires this
   * mechanism.
   */
  public Command holdState(State target) {
    return run(coroutine -> {
          state = target;
          while (true) {
            drive(target);
            coroutine.yield();
          }
        })
        .named("${N}: Hold " + target);
  }

  /** One iteration of the control loop. Shared so the math cannot drift. */
  private void drive(State target) {
    io.updateInputs(inputs);
    Logger.processInputs("${N}", inputs);

    double setpoint = target.getSetpoint();
    controller.setSetpoint(setpoint);
    double volts = controller.calculate(${measured}) + ${ffCall};
    io.setVoltage(MathUtil.clamp(volts, -12.0, 12.0));

    Logger.recordOutput("${N}/State", state);
    Logger.recordOutput("${N}/Setpoint", setpoint);
    Logger.recordOutput("${N}/AtState", controller.atSetpoint());
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

  public boolean isConnected() {
    return inputs.connected;
  }

  /** A command that cuts output and completes immediately. */
  public Command stop() {
    return run(coroutine -> io.stop()).named("${N}: Stop");
  }
}
`;
}

/* --- superstructure: the declarative StateMachine ------------------------- */

function stateMachineFile(
  group: ResolvedStateGroup, plans: SubsystemPlan[], program: ProgramGraph,
): string {
  const N = pascal(group.label, 'Superstructure');
  const members = plans.filter((p) => p.mech.controller
    && group.controllerIds.includes(p.mech.controller.id));

  const seen = new Set<string>();
  const stateNames = group.states.map((st, k) => {
    let name = constantName(st.name, `STATE_${k + 1}`);
    while (seen.has(name)) name = `${name}_${k + 1}`;
    seen.add(name);
    return name;
  });

  /* Local variable names come from the ORIGINAL label rather than from
     lower-casing the SCREAMING_SNAKE constant, which would turn "STOW" into
     "sTOW". Pascal-then-camel gives "stow" and "l2". */
  const localSeen = new Set<string>();
  const locals = group.states.map((st, k) => {
    let name = camel(pascal(st.name, `State${k + 1}`));
    while (localSeen.has(name)) name = `${name}${k + 1}`;
    localSeen.add(name);
    return name;
  });

  const fields = members
    .map((p) => `  private final ${p.className} ${camel(p.className)};`).join('\n');
  const params = members
    .map((p) => `${p.className} ${camel(p.className)}`).join(', ');
  const assigns = members
    .map((p) => `    this.${camel(p.className)} = ${camel(p.className)};`).join('\n');

  /* Each superstructure state is a PARALLEL group: every mechanism moves to its
     part of the state at once, and the group completes when the slowest one
     arrives. Sequencing them instead would make "score L4" mean "elevator, THEN
     wrist", which is both slower and not what the state says. */
  void stateNames; // kept for its de-duplication side effect
  const stateDecls = locals.map((name, k) => {
    const cmds = members.map((p) => {
      const target = p.goals[k]?.name ?? p.goals[0].name;
      return `                ${camel(p.className)}.toState(${p.className}.State.${target})`;
    }).join(',\n');
    return `    State ${locals[k]} =
        stateMachine.addState(
            Command.parallel(
${cmds})
                .named("${group.states[k].name}"));`;
  }).join('\n\n');

  /* --- transitions -------------------------------------------------------
     A wired rule becomes a real transition. This is what the programming layer
     buys: the graph knows WHY a state changes, so `.when(...)` gets the actual
     condition instead of a placeholder cycle.

     Every state can reach a ruled state, via switchFromAny. A rule wired to
     "L4" means "go to L4 when this is true", not "go to L4 from whichever
     state happens to precede it in the list" -- restricting it to one source
     would invent a sequencing constraint the person never drew.

     `while` rules use .when(); a plain rule fires the same way. The difference
     between them is what happens when the condition goes false, and in a state
     machine that is expressed by whether anything transitions BACK -- so a
     while rule also emits the return transition to the resting state. */
  const ctx: ConditionContext = { plans };
  const myRules = program.rules.filter((r) => r.groupId === group.blockId);
  const roots = myRules.map((r) => r.condition);

  const ruledLocals = new Set<string>();
  const wired = myRules.map((rule) => {
    const idx = group.states.findIndex((st) => st.name === rule.stateName);
    const target = locals[idx] ?? locals[0];
    ruledLocals.add(target);
    const expr = conditionExpr(rule.condition, ctx);
    const others = locals.filter((l) => l !== target);
    if (others.length === 0) return '';
    return `    // ${rule.hold ? 'While' : 'When'} ${describeCond(rule.condition)}\n`
      + `    stateMachine\n`
      + `        .switchFromAny(${others.join(', ')})\n`
      + `        .to(${target})\n`
      + `        .when(() -> ${expr});`
      + (rule.hold
        ? `\n    // ...and back out again once it stops being true, which is what\n`
          + `    // makes this a "while" rather than a one-way transition.\n`
          + `    ${target}.switchTo(${locals[0]}).when(() -> !(${expr}));`
        : '');
  }).filter(Boolean).join('\n\n');

  /* States nothing is wired to still need a way out, or the machine can enter
     one and never leave. They fall through to the next state on completion --
     flagged, because a fallthrough is a guess and a real condition is not. */
  const unruled = locals.filter((l) => !ruledLocals.has(l));
  const fallthrough = unruled.length && unruled.length < locals.length
    ? unruled.map((name) => {
        const next = locals[(locals.indexOf(name) + 1) % locals.length];
        return `    ${name}.switchTo(${next}).whenComplete();`;
      }).join('\n')
    : locals.map((name, k) => {
        const next = locals[(k + 1) % locals.length];
        return `    ${name}.switchTo(${next}).whenComplete();`;
      }).join('\n');

  const hasRules = wired.length > 0;
  const transitions = hasRules
    ? `${wired}\n\n`
      + (unruled.length
        ? `    // TODO: replace this — nothing in the programming graph says when\n`
          + `    // to leave ${unruled.join(', ')}, so they fall through on completion.\n`
          + `${fallthrough}`
        : '')
    : `    // TODO: replace this — no conditions were wired in the Programming\n`
      + `    // tab, so these just cycle in order to make the machine runnable.\n`
      + `${fallthrough}`;

  const fieldBlock = conditionFields(roots, ctx);
  const setters = triggerSetters(roots);
  const latches = latchUpdates(roots, ctx);
  const usesDio = needsDigitalInput(roots);

  return `package frc.robot.superstructure;

${usesDio ? 'import edu.wpi.first.wpilibj.DigitalInput;\n' : ''}import org.wpilib.command3.Command;
import org.wpilib.command3.State;
import org.wpilib.command3.StateMachine;
${members.map((p) => `import ${BASE_PKG}.${p.pkg}.${p.className};`).join('\n')}

/**
 * ${N} — the coupled state of ${members.map((p) => p.className).join(' and ')}.
 *
 * A state here is a claim about the WHOLE group at once: "${group.states[0]?.name ?? 'a state'}" means
 * every mechanism is where that state says it should be. They are declared as
 * parallel groups so the mechanisms move together and the state is reached when
 * the slowest one arrives — sequencing them would silently make the state mean
 * "one then the other", which is slower and not what was drawn.
 *
 * The transitions below are a STARTING POINT: Anodized knows what the states
 * are, but not what should trigger moving between them. It wires them into a
 * cycle so the machine is runnable and the shape is visible; replace the
 * conditions with the real ones (a beam break, a button, an operator request).
 *
 * Generated by Anodized (2027 / commands v3 target) from the "${group.label}" state block.
 */
public class ${N} {
${fields}
${fieldBlock ? `\n${fieldBlock}\n` : ''}
  public ${N}(${params}) {
${assigns}
  }
${latches ? `
  /**
   * Refreshes sticky conditions. Call once per loop from robotPeriodic().
   *
   * A latch cannot live inside the transition's own supplier: a supplier is
   * evaluated whenever the machine feels like checking, so folding a
   * state-mutating update into it would make the latch depend on how often it
   * happened to be polled.
   */
  public void updateLatches() {
${latches}
  }
` : ''}${setters ? `\n${setters}\n` : ''}

  /**
   * Builds the state machine. The returned value is itself a {@link Command} —
   * schedule it, bind it to a trigger, or await it inside another command.
   */
  public Command buildStateMachine() {
    StateMachine stateMachine = new StateMachine("${N}");

${stateDecls}

    // The initial state. Omitting this is a compile error with the WPILib
    // compiler plugin enabled, and a runtime exception without it.
    stateMachine.setInitialState(${locals[0] ?? 'initial'});

${transitions}

    return stateMachine;
  }
}
`;
}

/* --- README --------------------------------------------------------------- */

function readme2027(plans: SubsystemPlan[], groups: ResolvedStateGroup[]): string {
  const rows = plans.map((p) => {
    const v = vendorFor(p.mech.motorBlock.motorId);
    return `| \`${p.className}\` | ${p.mech.motorBlock.count}x ${p.mech.motorBlock.motorId} | ${
      v === 'talonfx' ? 'TalonFX / Phoenix 6' : v === 'sparkmax' ? 'SPARK MAX / REVLib' : '**not templated**'
    } | ${p.mode} | ${p.goals.length} |`;
  }).join('\n');
  const first = plans[0];

  return `# Generated mechanisms — WPILib 2027 (commands v3)

Exported from Anodized targeting the commands v3 framework and the declarative
\`StateMachine\` API (allwpilib#8297).

**This will not compile against 2026 WPILib.** It needs \`org.wpilib.command3\`.
If you are still on 2026, re-export with the **Classic** target.

## What is here

| Mechanism | Motors | Hardware layer | Control | States |
| --- | --- | --- | --- | --- |
${rows}

Five files per mechanism under \`frc/robot/subsystems/<name>/\`. The constants,
IO, hardware, and sim layers are **identical to the classic target** — an
encoder reads the same in either framework. Only \`<Name>.java\` differs.

## How this differs from the classic target

| | Classic | 2027 |
| --- | --- | --- |
| Base class | \`SubsystemBase\` | \`Mechanism\` |
| Loop | \`periodic()\` + switch | coroutine command with \`yield()\` |
| State | field + switch | \`StateMachine\` transition graph |
| Ownership | subsystem always self-drives | command owns mechanism while running |

## Commands each mechanism hands out

- \`toState(State)\` — drives there and **completes on arrival**. This is what
  makes \`.whenComplete()\` transitions work without a separate condition.
- \`holdState(State)\` — drives the same setpoint and **never completes**. For
  holding against gravity, and for the default command.
- \`stop()\` — cuts output.

## Default commands matter more here

In v3 a command owns a mechanism only while it runs. Between commands a
mechanism is *owned but uncommanded* — still applying the last motor request, or
sagging. Every generated mechanism therefore sets a default command that holds
its first state. Change it, but do not simply delete it.

## The state machine

${groups.length ? `\`frc/robot/superstructure/\` has one class per state block. Each superstructure
state is a \`Command.parallel(...)\` of the member mechanisms' \`toState\` commands,
so they move together and the state is reached when the slowest arrives.

**The transitions are a starting point.** Anodized knows the states but not what
should trigger moving between them, so it wires a cycle to make the machine
runnable and the shape visible. Replace them:

\`\`\`java
// generated
stow.switchTo(scoring).whenComplete();

// what you probably want
stow.switchTo(scoring).whenCompleteAnd(() -> operator.wantsToScore());
scoring.switchTo(stow).when(() -> !gripper.hasPiece());
\`\`\`
` : 'No state blocks in this design, so no superstructure was generated.\n'}
## Wiring it up

\`\`\`java
private final ${first?.className ?? 'Elevator'} ${first ? camel(first.className) : 'elevator'} =
    new ${first?.className ?? 'Elevator'}(
        Robot.isReal()
            ? new ${first?.className ?? 'Elevator'}IOPhysical()
            : new ${first?.className ?? 'Elevator'}IOSim());
\`\`\`

Mechanisms are not polled — no \`periodic()\` call is needed. Inputs are read
inside the running command, which is why the default command exists.

## Before this runs

Search for \`TODO: replace this\`. The simulator models physics — gearing,
inertia, current limits, and Coulomb friction — but cannot know CAN ids, motor
inversion, soft limits, or what should trigger a state transition.

## About the gains

\`KP\`/\`KI\`/\`KD\` are translated from the simulated tune and are a starting point.
\`KS\` is derived from the friction figure on the solid block, which the solver
really does integrate as Coulomb friction with a stiction band. \`KV\` is zero:
the model has no viscous drag, so there is nothing honest to derive it from.

## Where the loop runs

These generate a WPILib \`PIDController\` running in the command loop. If you
would rather close the loop on the motor controller — lower latency, and no
retuning later — do it **now, before you tune**, not after. Move \`KP\`/\`KI\`/\`KD\`
into the controller config in \`<Name>IOPhysical.java\`, have \`drive()\` call a
setpoint method instead of \`setVoltage\`, and tune once against that. Switching
after tuning means retuning, because 50 Hz and 1 kHz gains are not
interchangeable.

## Dependencies

WPILib 2027 (\`org.wpilib.command3\`), AdvantageKit, plus Phoenix 6 and/or REVLib.
`;
}

/* --- assembly ------------------------------------------------------------- */

export function generateCmd3(
  sys: System, groups: MechanismGroup[], designName: string,
): GeneratedExport {
  const plans = planSubsystems(sys, groups);
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];
  const root = pascal(designName, 'Anodized');

  for (const p of plans) {
    const dir = `${root}/src/main/java/frc/robot/subsystems/${p.pkg}`;
    // Shared with the classic target -- these files know nothing about the
    // command framework, so there is one implementation of each.
    entries.push({ path: `${dir}/${p.className}Constants.java`, text: constantsFile(p) });
    entries.push({ path: `${dir}/${p.className}IO.java`, text: ioFile(p) });
    entries.push({ path: `${dir}/${p.className}IOPhysical.java`, text: physicalFile(p) });
    entries.push({ path: `${dir}/${p.className}IOSim.java`, text: simFile(p) });
    // The only file that differs.
    entries.push({ path: `${dir}/${p.className}.java`, text: mechanismFile(p) });

    if (vendorFor(p.mech.motorBlock.motorId) === 'unknown') {
      warnings.push(
        `${p.className} uses ${p.mech.motorBlock.motorId}, a brushed motor — its hardware layer is a stub.`,
      );
    }
  }

  for (const group of sys.stateGroups) {
    const name = pascal(group.label, 'Superstructure');
    entries.push({
      path: `${root}/src/main/java/frc/robot/superstructure/${name}.java`,
      text: stateMachineFile(group, plans, sys.program),
    });
  }

  if (sys.stateGroups.length > 0) {
    warnings.push('State machine transitions are placeholders — replace them with real conditions.');
  }
  warnings.push('Targets WPILib 2027 (org.wpilib.command3) — will not compile on 2026.');

  entries.push({ path: `${root}/README.md`, text: readme2027(plans, sys.stateGroups) });
  return { entries, plans, warnings };
}

// Referenced so the shared helpers stay in the module graph for type-checking.
export type { SubsystemPlan };
export { gainsFor, num, toleranceFor };
