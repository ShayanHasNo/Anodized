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
  ControllerBlock, LqrBlock, JointBlock, StateBlock, MechanismState,
  CONTROL_KINDS, Edge, SensorBlock, LogicBlock,
  PROGRAMMING_KINDS, SENSOR_KINDS,
} from './blocks';
import { MotorConstants, getMotor } from './motors';
import { scaleFromBase } from './units';

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

export interface Mechanism {
  motorBlock: MotorBlock;
  motor: MotorConstants;
  gears: GearBlock[];
  solid: SolidBlock;

  ratio: number;        // G, cumulative reduction (drums excluded)
  efficiency: number;   // eta, cumulative
  radius: number | null; // drum radius, m -- null for pure rotational chains

  // Mutable: a joint coupling pass adjusts these after every mechanism is
  // independently resolved, to reflect a mounted child's mass onto its parent.
  inertiaSolid: number; // kg-m^2 at the output shaft
  jEffOutput: number;   // inertiaSolid + rotor inertia reflected through G^2
  friction: number;     // N-m at the output shaft
  theta0: number;       // initial output-shaft angle, rad

  /** true when the terminal solid travels rather than rotates. */
  linearDisplay: boolean;
  /** Multiply shaft radians by this to get the position channel's display unit. */
  posScale: number;
  /** Multiply shaft rad/s by this to get the velocity channel's display unit. */
  velScale: number;
  positionUnit: string;
  velocityUnit: string;

  /**
   * Gravity torque at the output shaft as a function of shaft angle. Mutable:
   * a joint coupling pass can replace this with a version that also carries a
   * mounted child's weight at the tip.
   */
  gravityTorque: (theta: number) => number;

  /**
   * The parent solid's id, if this mechanism is a revolute joint's child. The
   * solver adds that parent's LIVE shaft angle before evaluating gravityTorque
   * every step -- a wrist's weight depends on the arm's angle right now, not
   * at compile time, so this can't be folded into the closure above.
   */
  parentAngleSource: string | null;
  /**
   * The parent solid's id for ANY joint type, revolute or prismatic -- purely
   * structural, used to draw the mechanism attached to its parent rather than
   * floating separately. Distinct from parentAngleSource because a prismatic
   * child is still visually mounted even though its gravity isn't coupled.
   */
  mountedOn: string | null;
  /**
   * The POWERED mechanism this one hangs off, which is not always the same as
   * mountedOn: a wrist bolted to the top stage of a cascade is mounted on that
   * stage, but the stage is an unpowered relay, so the mechanism that actually
   * carries the wrist is the one down at the bottom with the motor in it.
   *
   * Both are needed. mountedOn is the structural truth and drives the drawing;
   * this one is what anything reasoning about MECHANISMS has to walk, because
   * a passive stage has no mechanism to walk to. A state block attached to an
   * elevator finds the wrist through this field -- through mountedOn it would
   * find solidE4, which is not a mechanism, and silently stop there.
   */
  mountedOnOwner: string | null;
  /**
   * Solids mounted on this one that have no motor of their own -- a cascade
   * elevator's upper stages, driven by the same rigging as the first rather
   * than independently powered. Their mass is reflected into this mechanism's
   * inertia and gravity, and the solver records their channels as carried by
   * this shaft rather than solving them separately.
   */
  passiveChildren: SolidBlock[];

  /** Controller driving the motor's command port, if one is wired up. */
  controller: ControllerBlock | null;
  /** Channel key the controller measures its error from (PID / bang-bang only). */
  errorSource: string | null;
  /**
   * Precomputed LQR gains, if the controller is an LQR block. The plant is
   * linear and time-invariant, so the gains are solved once here rather than
   * every timestep. Mutable for the same reason as inertiaSolid: a mounted
   * child changes jEffOutput, which changes the gain solve.
   */
  lqrGains: { k1: number; k2: number; a: number; b: number } | null;
}

/**
 * A graph can hold several independent mechanisms -- an arm and a drivetrain,
 * say -- that share nothing mechanically but DO share one electrical bus. The
 * battery lives here, once; every mechanism's current draw sags the same
 * V_bus, which is exactly why they cannot be simulated as separate isolated
 * problems even though their motion is independent.
 */
export interface System {
  battery: BatteryBlock;
  mechanisms: Mechanism[];
  /** State blocks, resolved against the controllers they can actually reach. */
  stateGroups: ResolvedStateGroup[];
  /** The programming layer: conditions and the transitions they drive. */
  program: ProgramGraph;
}

/* --- the programming layer ------------------------------------------------
 *
 * Conditions compile to a TREE rather than a flat list because the graph the
 * person wires is a tree: an `if` block reading two sensors is one node with
 * two children. Flattening it to "a list of conditions, all ANDed" would throw
 * away the or/not the person drew, and there would be no way to recover it for
 * either the solver or the code generator.
 */

export type ConditionNode =
  | {
      kind: 'sensor';
      blockId: string;
      label: string;
      /** Solid whose state is compared. */
      solidId: string;
      /** Which channel of that solid: position or velocity. */
      signal: 'position' | 'velocity';
      threshold: number;
      direction: 'above' | 'below';
      /** Display unit of the threshold, for labels and generated comments. */
      unit: string;
      /** True for a limit switch, which is a physical object in exported code. */
      physical: boolean;
    }
  | { kind: 'trigger'; blockId: string; label: string; initial: boolean }
  | { kind: 'and' | 'or'; blockId: string; label: string; a: ConditionNode; b: ConditionNode }
  | { kind: 'not'; blockId: string; label: string; a: ConditionNode }
  | { kind: 'latch'; blockId: string; label: string; a: ConditionNode };

/**
 * One rule: while/when this condition holds, put this state group in this state.
 *
 * `hold` is what separates a `while` block from a plain transition. A
 * transition fires once and the state stays; a hold is continuously true, so
 * when the condition goes false the rule stops applying and a lower-priority
 * rule (or the resting state) takes over again.
 */
export interface TransitionRule {
  /** The logic block that terminates this chain, for error reporting. */
  blockId: string;
  condition: ConditionNode;
  groupId: string;
  stateName: string;
  hold: boolean;
}

export interface ProgramGraph {
  rules: TransitionRule[];
  /** Every trigger in the graph, so the UI can offer switches for them. */
  triggers: { blockId: string; label: string; initial: boolean }[];
  /** Every condition node, flattened, so each can be logged as a channel. */
  conditions: ConditionNode[];
}

/** A state block plus the controllers it commands. */
export interface ResolvedStateGroup {
  blockId: string;
  label: string;
  /** Controller block ids this group can set, in mechanism order. */
  controllerIds: string[];
  /** Human labels for those controllers, for the inspector and Actions tab. */
  controllerLabels: Record<string, string>;
  states: MechanismState[];
}

export class CompileError extends Error {
  /** The block responsible, when one can be pinpointed, for canvas highlighting. */
  blockId?: string;
  constructor(message: string, blockId?: string) {
    super(message);
    this.blockId = blockId;
  }
}

/** Walk downstream from a motor to its terminal solid, collecting gears. */
function walkChain(
  motorId: string, byId: Map<string, Block>, next: Map<string, string>,
): { gears: GearBlock[]; solid: SolidBlock } {
  const gears: GearBlock[] = [];
  let solid: SolidBlock | undefined;
  let cursor = next.get(motorId);
  const seen = new Set<string>([motorId]);

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

  if (!solid) throw new CompileError('The chain does not end in a solid block.', motorId);
  return { gears, solid };
}

/** Resolve one motor's downstream chain into everything the solver needs. */
function resolveMechanism(
  motorBlock: MotorBlock, battery: BatteryBlock,
  byId: Map<string, Block>, next: Map<string, string>, edges: Edge[],
): Mechanism {
  const { gears, solid } = walkChain(motorBlock.id, byId, next);

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
  let lqrGains: Mechanism['lqrGains'] = null;

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
      // Distinguish "wrong kind of channel" from "right kind, wrong
      // mechanism" -- the second is much easier to hit once a graph holds
      // several mechanisms, and the generic message actively misleads.
      const isStateChannel = /\.(position|velocity|speed)$/.test(errorSource);
      throw new CompileError(
        isStateChannel
          ? `Controller "${controller.id}" drives "${motorBlock.id}" but measures "${errorSource}", which belongs to a different mechanism. A controller has to read the shaft it actually drives.`
          : `"${errorSource}" cannot be used as a controller error source. Controllers read shaft state, so pick a position or velocity channel.`,
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
    const lqrPosScale = (solid.gravityMode === 'constant' ? radius! : 1)
      * scaleFromBase(solid.positionUnit ?? (solid.gravityMode === 'constant' ? 'm' : 'deg'));
    const a = (n * motor.Kt * ratio * ratio * efficiency) / (motor.Kv * motor.R * jEffOutput);
    const b = ((n * motor.Kt * ratio * efficiency * battery.vOc) / (motor.R * jEffOutput)) * lqrPosScale;
    const { k1, k2 } = solveLqrGains(a, b, lqr.qPos, lqr.qVel, lqr.r);
    lqrGains = { k1, k2, a, b };
  }

  const linearDisplay = solid.gravityMode === 'constant';
  const positionUnit = solid.positionUnit ?? (linearDisplay ? 'm' : 'deg');
  const velocityUnit = solid.velocityUnit ?? (linearDisplay ? 'm/s' : 'deg/s');
  // A drum turns shaft radians into metres first, then the unit scale takes
  // metres to whatever the user wants to read. Rotational chains skip the
  // radius step entirely.
  const posScale = (linearDisplay ? radius! : 1) * scaleFromBase(positionUnit);
  const velScale = (linearDisplay ? radius! : 1) * scaleFromBase(velocityUnit);
  // initialPosition is given in the solid's own display unit.
  const theta0 = solid.initialPosition / posScale;

  return {
    motorBlock, motor, gears, solid,
    ratio, efficiency, radius, inertiaSolid, jEffOutput,
    friction: solid.friction, theta0, linearDisplay, gravityTorque,
    posScale, velScale, positionUnit, velocityUnit,
    parentAngleSource: null, mountedOn: null, mountedOnOwner: null, passiveChildren: [],
    controller, errorSource, lqrGains,
  };
}

/**
 * Compile the whole graph: one battery, any number of independent mechanisms.
 * Each motor block found is the head of its own chain -- two motor blocks are
 * two mechanisms, not one merged one. Two motor BLOCKS driving the same solid
 * (a differential, a dual-motor merge) is a real feature this does not support
 * yet, and is rejected with a specific error rather than silently picking one.
 */
/** A labelled box on the canvas that should hold exactly one mechanism chain. */
export interface MechanismGroup {
  id: string;
  label: string;
  memberIds: string[];
}

export function compile(
  blocks: Block[], edges: Edge[], groups: MechanismGroup[] = [],
): System {
  const byId = new Map(blocks.map((b) => [b.id, b]));

  const battery = blocks.find((b): b is BatteryBlock => b.kind === 'battery');
  const motorBlocks = blocks.filter((b): b is MotorBlock => b.kind === 'motor');
  if (!battery) throw new CompileError('No battery block. Add one to power the motors.');
  if (motorBlocks.length === 0) {
    throw new CompileError('No motor block. Every mechanism needs a source of torque.');
  }

  // Every motor must be wired to THIS battery specifically -- v1 supports one
  // shared bus, not several batteries feeding different mechanisms.
  const poweredIds = new Set(
    edges
      .filter((e) => e.from.blockId === battery.id && e.from.portId === 'out' && e.to.portId === 'power')
      .map((e) => e.to.blockId),
  );
  for (const m of motorBlocks) {
    if (!poweredIds.has(m.id)) {
      throw new CompileError(`Motor "${m.id}" isn't connected to the battery.`, m.id);
    }
  }

  // Walk the mechanical chain from each motor. Signal and control edges are
  // not part of the mechanical chain.
  const next = new Map<string, string>();
  for (const e of edges) {
    const src = byId.get(e.from.blockId);
    if (src && src.kind !== 'battery'
        && e.from.portId !== 'signal' && e.from.portId !== 'command') {
      next.set(e.from.blockId, e.to.blockId);
    }
  }

  // A controller's command output has no fan-out limit at the canvas level
  // (only the motor's command INPUT is one-to-one), so one controller can be
  // wired to several motors. That silently makes two mechanisms share one
  // block's target and gains -- they look interconnected, because they are.
  // Catch it here, before per-mechanism resolution produces a confusing error
  // about the wrong block.
  const drivenBy = new Map<string, string[]>();
  for (const e of edges) {
    if (e.to.portId !== 'command') continue;
    const src = byId.get(e.from.blockId);
    if (!src || !CONTROL_KINDS.has(src.kind)) continue;
    const list = drivenBy.get(src.id) ?? [];
    list.push(e.to.blockId);
    drivenBy.set(src.id, list);
  }
  for (const [ctrlId, motors] of drivenBy) {
    if (motors.length > 1) {
      throw new CompileError(
        `Controller "${ctrlId}" is wired to ${motors.length} motors (${motors.join(', ')}). Each mechanism needs its own controller — otherwise they share one target and one set of gains.`,
        ctrlId,
      );
    }
  }

  // A controller that drives nothing is almost always a half-finished wire,
  // and it fails in the most confusing way possible: the controller sits there
  // looking connected, its motor quietly falls back to the manual duty field,
  // and changing the target appears to do nothing at all.
  for (const b of blocks) {
    if (!CONTROL_KINDS.has(b.kind)) continue;
    if (!drivenBy.has(b.id)) {
      throw new CompileError(
        `Controller "${b.id}" isn't wired to a motor. Connect its bar-shaped command output to a motor's command input, or the motor just runs at its own duty setting.`,
        b.id,
      );
    }
  }

  const claimed = new Map<string, string>(); // blockId -> which motor already uses it
  const mechanisms: Mechanism[] = [];

  for (const motorBlock of motorBlocks) {
    const mech = resolveMechanism(motorBlock, battery, byId, next, edges);
    for (const b of [...mech.gears, mech.solid]) {
      const owner = claimed.get(b.id);
      if (owner) {
        throw new CompileError(
          `"${b.id}" is driven by both "${owner}" and "${motorBlock.id}". Two motors sharing one mechanism (a differential, a dual-motor merge) isn't supported yet -- give each its own chain.`,
          b.id,
        );
      }
      claimed.set(b.id, motorBlock.id);
    }
    mechanisms.push(mech);
  }

  /* --- mechanism boxes --------------------------------------------------
     A box is a claim about structure: "this is one mechanism". Validating it
     catches the mistake the box was drawn to prevent -- a chain that looks
     grouped on the canvas but is actually wired through a block sitting
     outside, or two mechanisms crammed into one label. */
  if (groups.length > 0) {
    const memberOf = new Map<string, string>();
    const labelOf = new Map(groups.map((g) => [g.id, g.label]));
    for (const g of groups) {
      for (const id of g.memberIds) memberOf.set(id, g.id);
    }

    // The battery feeds every mechanism, so putting it inside one box would
    // imply it belongs to that mechanism alone.
    if (memberOf.has(battery.id)) {
      const g = memberOf.get(battery.id)!;
      throw new CompileError(
        `The battery is inside "${labelOf.get(g)}". It powers every mechanism, so keep it outside the boxes.`,
        battery.id,
      );
    }

    for (const g of groups) {
      const motorsInside = motorBlocks.filter((m) => g.memberIds.includes(m.id));
      if (motorsInside.length === 0) {
        throw new CompileError(
          `Mechanism "${g.label}" has no motor in it. A mechanism box needs one complete chain: a motor, its gears, and the solid it drives.`,
          g.id,
        );
      }
      if (motorsInside.length > 1) {
        throw new CompileError(
          `Mechanism "${g.label}" holds ${motorsInside.length} motors (${motorsInside.map((m) => m.id).join(', ')}). One box is one mechanism — give each its own.`,
          g.id,
        );
      }
    }

    for (const mech of mechanisms) {
      const chain = [mech.motorBlock.id, ...mech.gears.map((x) => x.id), mech.solid.id];
      const home = memberOf.get(mech.motorBlock.id);
      if (home === undefined) continue; // ungrouped chains are fine
      const strays = chain.filter((id) => memberOf.get(id) !== home);
      if (strays.length > 0) {
        throw new CompileError(
          `Mechanism "${labelOf.get(home)}" is incomplete — ${strays.join(', ')} ${strays.length === 1 ? 'is' : 'are'} outside the box but part of the same chain. Drag ${strays.length === 1 ? 'it' : 'them'} in, or resize the box.`,
          strays[0],
        );
      }
      // A controller driving this chain belongs with it, if it is boxed at all.
      const ctrl = mech.controller;
      if (ctrl && memberOf.has(ctrl.id) && memberOf.get(ctrl.id) !== home) {
        throw new CompileError(
          `Controller "${ctrl.id}" drives "${mech.motorBlock.id}" but sits in a different mechanism box.`,
          ctrl.id,
        );
      }
    }
  }

  /* --- joints -------------------------------------------------------------
     Confirms a joint is fully wired, connects two distinct solids, does not
     close a loop, and that the child's own type is physically legal for the
     joint kind -- then couples the physics: gravity and reflected mass. See
     the coupling pass below for exactly what is and isn't modeled. */
  const joints = blocks.filter((b): b is JointBlock => b.kind === 'joint');
  if (joints.length > 0) {
    const solidsById = new Map(blocks.filter((b) => b.kind === 'solid').map((b) => [b.id, b as SolidBlock]));
    const parentOfJoint = new Map<string, string>(); // joint id -> parent solid id
    const childOfJoint = new Map<string, string>();  // joint id -> child solid id
    const parentOfChild = new Map<string, string>(); // child solid id -> joint id that mounts it

    for (const e of edges) {
      if (e.to.portId === 'parent' && solidsById.has(e.from.blockId) && e.from.portId === 'tip') {
        const existingParent = parentOfJoint.get(e.to.blockId);
        if (existingParent && existingParent !== e.from.blockId) {
          throw new CompileError(
            `Joint "${e.to.blockId}" has two parents wired to it ("${existingParent}" and "${e.from.blockId}"). A joint can only have one.`,
            e.to.blockId,
          );
        }
        parentOfJoint.set(e.to.blockId, e.from.blockId);
      }
      if (e.from.portId === 'child' && solidsById.has(e.to.blockId) && e.to.portId === 'mount') {
        childOfJoint.set(e.from.blockId, e.to.blockId);
        // canConnect() already stops this on the canvas, but a hand-edited or
        // loaded file can bypass it -- worth catching rather than silently
        // letting the second joint win.
        const existing = parentOfChild.get(e.to.blockId);
        if (existing && existing !== e.from.blockId) {
          throw new CompileError(
            `"${e.to.blockId}" is mounted by both "${existing}" and "${e.from.blockId}". A solid can only have one parent joint.`,
            e.to.blockId,
          );
        }
        parentOfChild.set(e.to.blockId, e.from.blockId);
      }
    }

    for (const j of joints) {
      const parentId = parentOfJoint.get(j.id);
      const childId = childOfJoint.get(j.id);
      if (!parentId || !childId) {
        throw new CompileError(
          `Joint "${j.id}" isn't fully wired. Connect a solid's tip to this joint's parent input, and this joint's child output to another solid's mount input.`,
          j.id,
        );
      }
      if (parentId === childId) {
        throw new CompileError(`Joint "${j.id}" connects "${parentId}" to itself.`, j.id);
      }

      const child = solidsById.get(childId)!;
      if (j.jointType === 'revolute' && child.gravityMode === 'constant') {
        throw new CompileError(
          `Revolute joint "${j.id}" needs a rotating child (an arm or a flywheel), but "${childId}" is a linear mechanism (an elevator). Use a prismatic joint instead.`,
          j.id,
        );
      }
      if (j.jointType === 'prismatic' && child.gravityMode !== 'constant') {
        throw new CompileError(
          `Prismatic joint "${j.id}" needs a sliding child (an elevator), but "${childId}" is a rotating mechanism. Use a revolute joint instead.`,
          j.id,
        );
      }
    }

    // A chain of joints must not loop back on itself: walk from every solid
    // that is somebody's child, following parent links, and watch for a
    // repeat. Same loop-detection shape used for the mechanical chain walk.
    for (const startId of parentOfChild.keys()) {
      const seen = new Set<string>([startId]);
      let cur: string | undefined = startId;
      while (true) {
        const jointId: string | undefined = parentOfChild.get(cur!);
        if (!jointId) break;
        const next = parentOfJoint.get(jointId);
        if (!next) break;
        if (seen.has(next)) {
          throw new CompileError(`Joint "${jointId}" closes a loop back to "${next}".`, jointId);
        }
        seen.add(next);
        cur = next;
      }
    }

    /* --- coupling ------------------------------------------------------
       Two effects, both static except where noted:
         1. GRAVITY: a revolute child's weight depends on the world, not on
            its own local angle -- so its gravity torque needs the parent's
            angle added in. That parent angle is LIVE state, so it can't be
            folded into a closure here; the solver adds it every step.
         2. MASS: the child's total mass loads the parent, at the parent's
            tip. This IS static (the child's mass never changes), so it is
            folded into the parent's inertia and gravity torque once, right
            here, rather than every timestep.
       Left out on purpose: reaction torque from the child's own acceleration
       (still a rigid-attachment approximation), a prismatic child's gravity
       depending on parent orientation (needs the slide's world direction,
       deferred), and recursive reflection past one level (a grandchild's
       mass does not propagate through its parent to the grandparent). */
    const mechBySolidId = new Map(mechanisms.map((m) => [m.solid.id, m]));
    const solidById = new Map(
      blocks.filter((b): b is SolidBlock => b.kind === 'solid').map((b) => [b.id, b]),
    );
    const childrenOfParent = new Map<string, Mechanism[]>();
    const passiveOfParent = new Map<string, SolidBlock[]>();

    // Every joint's parent, for every child, powered or not -- needed to walk
    // UP through a chain of passive relays to find the real motor.
    const parentOfSolid = new Map<string, string>();
    for (const j of joints) parentOfSolid.set(childOfJoint.get(j.id)!, parentOfJoint.get(j.id)!);

    /**
     * Resolves a solid to the powered Mechanism that actually carries its
     * load. Direct when the solid itself has a motor; otherwise walks up
     * through however many unpowered relay stages sit in between -- a
     * three-stage cascade has stage 3 mounted on stage 2, which is itself an
     * unpowered relay mounted on stage 1's motor, and stage 3's weight still
     * has to end up on stage 1's inertia, not get stuck on stage 2.
     */
    const resolveOwner = (solidId: string, jointId: string): Mechanism => {
      let cur = solidId;
      const seen = new Set<string>([solidId]);
      while (!mechBySolidId.has(cur)) {
        const next = parentOfSolid.get(cur);
        if (!next || seen.has(next)) {
          throw new CompileError(
            `Joint "${jointId}" sits in a chain with no motor anywhere in it. A cascade needs at least one powered stage to carry the rest.`,
            cur,
          );
        }
        seen.add(next);
        cur = next;
      }
      return mechBySolidId.get(cur)!;
    };

    for (const j of joints) {
      const parentId = parentOfJoint.get(j.id)!;
      const childId = childOfJoint.get(j.id)!;
      const childMech = mechBySolidId.get(childId);
      const ownerMech = resolveOwner(parentId, j.id);

      if (!childMech) {
        /* An unpowered child is legitimate, not an error. A cascade elevator
           has ONE motor driving rigging that lifts every stage -- the upper
           stages are carried, not independently powered. Same for any dead
           weight bolted to a mechanism. It contributes its mass and nothing
           else, reflected onto whichever mechanism actually has the motor --
           which may be several relay stages up, not just the immediate
           parent. */
        const passive = solidById.get(childId);
        if (!passive) {
          throw new CompileError(
            `Joint "${j.id}" mounts "${childId}", which isn't a solid block.`,
            childId,
          );
        }
        const list = passiveOfParent.get(ownerMech.solid.id) ?? [];
        list.push(passive);
        passiveOfParent.set(ownerMech.solid.id, list);
        ownerMech.passiveChildren.push(passive);
        continue;
      }

      // mountedOn stays the IMMEDIATE parent -- the Motion tab draws each
      // visual link in the chain, not just the root, so it needs the real
      // neighbour even though the physics reflects mass further up.
      childMech.mountedOn = parentId;
      childMech.mountedOnOwner = ownerMech.solid.id;
      if (j.jointType === 'revolute') childMech.parentAngleSource = parentId;
      const list = childrenOfParent.get(ownerMech.solid.id) ?? [];
      list.push(childMech);
      childrenOfParent.set(ownerMech.solid.id, list);
    }

    const deriveLqrGains = (mech: Mechanism) => {
      if (mech.controller?.kind !== 'lqr') return;
      const lqr = mech.controller;
      const n = mech.motorBlock.count;
      const a = (n * mech.motor.Kt * mech.ratio * mech.ratio * mech.efficiency)
        / (mech.motor.Kv * mech.motor.R * mech.jEffOutput);
      const b = ((n * mech.motor.Kt * mech.ratio * mech.efficiency * battery.vOc)
        / (mech.motor.R * mech.jEffOutput)) * mech.posScale;
      const { k1, k2 } = solveLqrGains(a, b, lqr.qPos, lqr.qVel, lqr.r);
      mech.lqrGains = { k1, k2, a, b };
    };

    // Every parent that carries anything at all -- powered children, passive
    // children, or both -- needs its inertia and gravity adjusted.
    const parentsWithLoad = new Set([...childrenOfParent.keys(), ...passiveOfParent.keys()]);
    for (const parentId of parentsWithLoad) {
      const parentMech = mechBySolidId.get(parentId)!;
      const powered = childrenOfParent.get(parentId) ?? [];
      const passive = passiveOfParent.get(parentId) ?? [];
      const totalChildMass =
        powered.reduce((sum, c) => sum + c.solid.mass, 0)
        + passive.reduce((sum, sb) => sum + sb.mass, 0);
      const oldGravityTorque = parentMech.gravityTorque;

      if (parentMech.linearDisplay) {
        const r = parentMech.radius!;
        parentMech.inertiaSolid += totalChildMass * r * r;
        const addedGravity = totalChildMass * G_ACCEL * r;
        parentMech.gravityTorque = (theta) => oldGravityTorque(theta) + addedGravity;
      } else {
        const tipR = parentMech.solid.tipRadius;
        if (!tipR || tipR <= 0) {
          throw new CompileError(
            `"${parentId}" needs a tip radius before something can be mounted on it — set it in the inspector.`,
            parentId,
          );
        }
        parentMech.inertiaSolid += totalChildMass * tipR * tipR;
        const addedPeak = totalChildMass * G_ACCEL * tipR;
        parentMech.gravityTorque = (theta) => oldGravityTorque(theta) + addedPeak * Math.cos(theta);
      }

      parentMech.jEffOutput = parentMech.inertiaSolid
        + parentMech.motorBlock.count * parentMech.motor.spec.rotorInertia * parentMech.ratio * parentMech.ratio;
      deriveLqrGains(parentMech);
    }
  }

  /* --- state blocks --------------------------------------------------------
     A state block is wired to a MECHANISM BOX, and commands every controller
     inside that box PLUS every controller on anything jointed below it -- so
     one "scoring" state sets an elevator and the wrist riding on it together,
     which is the whole point of having states rather than typing targets into
     each controller by hand.

     The box is the unit of attachment because the box is what this compiler
     already validates as "one mechanism": exactly one motor, its gears, and
     the solid it drives. A solid is only a part of that. Files saved before
     this change wired a solid's hex port in instead, so that still resolves --
     it just is not what the canvas offers any more. */
  const stateBlocks = blocks.filter((b): b is StateBlock => b.kind === 'state');
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const stateGroups: ResolvedStateGroup[] = stateBlocks.map((sb) => {
    const sources = edges
      .filter((e) => e.to.blockId === sb.id && e.to.portId === 'mechanism')
      .map((e) => e.from.blockId);

    if (sources.length === 0) {
      throw new CompileError(
        `State block "${sb.label || sb.id}" isn't attached to anything. Wire a mechanism box's hex port into its input.`,
        sb.id,
      );
    }
    /* A signal port has no cardinality limit -- that is right for a plotter,
       which can take any number of taps, but wrong here: two boxes wired in
       would silently mean the states command whichever one happened to be
       found first, and the other box's controllers would just be missing from
       the inspector with no explanation. */
    if (sources.length > 1) {
      throw new CompileError(
        `State block "${sb.label || sb.id}" is wired to ${sources.length} mechanisms (${sources.join(', ')}). One state block commands one mechanism and whatever is jointed below it — give the second its own.`,
        sb.id,
      );
    }
    const sourceId = sources[0];

    /* Two shapes resolve to the same thing: a box (the current way) supplies
       every mechanism whose motor sits inside it, and a solid (the legacy way)
       supplies just its own. Everything after this point is identical. */
    let roots: Mechanism[];
    const box = groupById.get(sourceId);
    if (box) {
      const inside = new Set(box.memberIds);
      roots = mechanisms.filter((m) => inside.has(m.motorBlock.id));
      if (roots.length === 0) {
        throw new CompileError(
          `State block "${sb.label || sb.id}" is attached to "${box.label}", which has no mechanism in it. A box needs a motor, its gears, and the solid it drives before states can command it.`,
          sb.id,
        );
      }
    } else {
      const rootMech = mechanisms.find((m) => m.solid.id === sourceId);
      if (!rootMech) {
        throw new CompileError(
          `State block "${sb.label || sb.id}" is attached to "${sourceId}", which is neither a mechanism box nor a solid with a motor driving it.`,
          sb.id,
        );
      }
      roots = [rootMech];
    }

    /* Collect the roots plus everything mounted below them, breadth-first.
       Descent follows mountedOnOwner, not mountedOn: a wrist on the top stage
       of a cascade is structurally mounted on that stage, but the stage is an
       unpowered relay with no mechanism of its own, so walking mountedOn would
       stop dead there and quietly drop the wrist's controller from the group.
       mountedOnOwner points at the powered mechanism that actually carries it,
       which is the one in this list. */
    const reached: Mechanism[] = [];
    const queue = [...roots];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur.solid.id)) continue;
      seen.add(cur.solid.id);
      reached.push(cur);
      for (const m of mechanisms) {
        if ((m.mountedOnOwner ?? m.mountedOn) === cur.solid.id) queue.push(m);
      }
    }

    const controllerIds: string[] = [];
    const controllerLabels: Record<string, string> = {};
    for (const m of reached) {
      if (!m.controller) continue;
      controllerIds.push(m.controller.id);
      controllerLabels[m.controller.id] = `${m.solid.id} · ${m.controller.kind}`;
    }
    if (controllerIds.length === 0) {
      throw new CompileError(
        `State block "${sb.label || sb.id}" reaches no controllers — nothing it is attached to has a PID, bang-bang, LQR, or voltage block driving it.`,
        sb.id,
      );
    }
    return { blockId: sb.id, label: sb.label || sb.id, controllerIds, controllerLabels, states: sb.states };
  });

  const program = resolveProgram(blocks, edges, mechanisms, stateGroups);

  return { battery, mechanisms, stateGroups, program };
}

/* --- resolving the programming graph -------------------------------------- */

/**
 * Walks the wired logic back from each state target to build condition trees.
 *
 * Direction matters: this resolves BACKWARD from the thing being commanded,
 * not forward from the sensors. A sensor wired to nothing is not an error --
 * it is a condition someone is still building, or one they plot without acting
 * on -- so starting from sensors would mean guessing which dangling chains
 * were meant to do something. Starting from the state target means every rule
 * found is one the person finished wiring.
 */
function resolveProgram(
  blocks: Block[], edges: Edge[], mechanisms: Mechanism[],
  stateGroups: ResolvedStateGroup[],
): ProgramGraph {
  const byId = new Map<string, Block>(blocks.map((b) => [b.id, b]));
  void mechanisms;

  /** Edge into a given block input, if any. */
  const incoming = (blockId: string, portId: string) =>
    edges.find((e) => e.to.blockId === blockId && e.to.portId === portId);

  const conditions: ConditionNode[] = [];
  const triggers: ProgramGraph['triggers'] = [];

  /* Cycle guard. A person can wire an if block's output back into its own
     input through a chain; without this the resolver would recurse until the
     stack died, with no indication of which block caused it. */
  const building = new Set<string>();

  function buildCondition(blockId: string): ConditionNode {
    const block = byId.get(blockId);
    if (!block) throw new CompileError(`A wire points at a block that no longer exists.`, blockId);

    if (building.has(blockId)) {
      throw new CompileError(
        `"${labelOf(block)}" is wired in a loop — a condition cannot depend on itself.`,
        blockId,
      );
    }
    building.add(blockId);
    try {
      const node = buildInner(block);
      conditions.push(node);
      return node;
    } finally {
      building.delete(blockId);
    }
  }

  function labelOf(b: Block): string {
    return 'label' in b && b.label ? b.label : b.id;
  }

  /** The solid a sensor watches, via its pentagon port. */
  function watchedSolid(sensor: SensorBlock): SolidBlock {
    const wire = incoming(sensor.id, 'solid');
    if (!wire) {
      throw new CompileError(
        `"${labelOf(sensor)}" is not watching anything — wire a solid's pentagon port into it.`,
        sensor.id,
      );
    }
    const solid = byId.get(wire.from.blockId);
    if (!solid || solid.kind !== 'solid') {
      throw new CompileError(
        `"${labelOf(sensor)}" must watch a solid.`, sensor.id,
      );
    }
    return solid;
  }

  function buildInner(block: Block): ConditionNode {
    switch (block.kind) {
      case 'limitSwitch': {
        const solid = watchedSolid(block);
        /* A limit switch is a physical object bolted where the mechanism
           travels past. A flywheel's position is an ever-growing revolution
           count with nowhere to bolt one, so this is rejected at compile time
           rather than accepted and silently never firing. */
        if (solid.gravityMode === 'none') {
          throw new CompileError(
            `"${labelOf(block)}" is on a spinning solid. A limit switch needs a travel `
            + `limit to sit at, so it only works on arms and elevators.`,
            block.id,
          );
        }
        return {
          kind: 'sensor', blockId: block.id, label: labelOf(block),
          solidId: solid.id, signal: 'position',
          threshold: block.position, direction: block.direction,
          unit: solid.positionUnit ?? (solid.gravityMode === 'constant' ? 'm' : 'deg'),
          physical: true,
        };
      }
      case 'encoder': {
        const solid = watchedSolid(block);
        const linear = solid.gravityMode === 'constant';
        return {
          kind: 'sensor', blockId: block.id, label: labelOf(block),
          solidId: solid.id, signal: block.mode,
          threshold: block.threshold, direction: block.direction,
          unit: block.mode === 'velocity'
            ? (solid.velocityUnit ?? (linear ? 'm/s' : 'deg/s'))
            : (solid.positionUnit ?? (linear ? 'm' : 'deg')),
          physical: false,
        };
      }
      case 'trigger':
        triggers.push({ blockId: block.id, label: labelOf(block), initial: block.initial });
        return {
          kind: 'trigger', blockId: block.id,
          label: labelOf(block), initial: block.initial,
        };
      case 'if': {
        const a = incoming(block.id, 'a');
        if (!a) {
          throw new CompileError(
            `"${labelOf(block)}" has no input wired into A.`, block.id,
          );
        }
        if (block.op === 'not') {
          return {
            kind: 'not', blockId: block.id, label: labelOf(block),
            a: buildCondition(a.from.blockId),
          };
        }
        const b = incoming(block.id, 'b');
        if (!b) {
          throw new CompileError(
            `"${labelOf(block)}" is an ${block.op.toUpperCase()} and needs both inputs wired.`,
            block.id,
          );
        }
        return {
          kind: block.op, blockId: block.id, label: labelOf(block),
          a: buildCondition(a.from.blockId), b: buildCondition(b.from.blockId),
        };
      }
      case 'waitUntil': {
        const a = incoming(block.id, 'a');
        if (!a) {
          throw new CompileError(
            `"${labelOf(block)}" has nothing to wait for — wire a condition into it.`,
            block.id,
          );
        }
        return {
          kind: 'latch', blockId: block.id, label: labelOf(block),
          a: buildCondition(a.from.blockId),
        };
      }
      case 'while': {
        const a = incoming(block.id, 'a');
        if (!a) {
          throw new CompileError(
            `"${labelOf(block)}" has no condition wired into it.`, block.id,
          );
        }
        return buildCondition(a.from.blockId);
      }
      default:
        throw new CompileError(
          `"${labelOf(block)}" is not a condition — only sensors, triggers, and logic `
          + `blocks can drive a state.`,
          block.id,
        );
    }
  }

  /* A rule exists where a boolean wire lands on a state block's mechanism
     port. The state block carries which state to select. */
  const rules: TransitionRule[] = [];
  for (const edge of edges) {
    const target = byId.get(edge.to.blockId);
    if (!target || target.kind !== 'state') continue;
    if (!edge.to.portId.startsWith('when:')) continue;

    const stateName = edge.to.portId.slice('when:'.length);
    const group = stateGroups.find((g) => g.blockId === target.id);
    if (!group) continue;
    if (!group.states.some((st) => st.name === stateName)) continue;

    const source = byId.get(edge.from.blockId);
    if (!source) continue;

    rules.push({
      blockId: source.id,
      condition: buildCondition(source.id),
      groupId: target.id,
      stateName,
      hold: source.kind === 'while',
    });
  }

  /* Triggers are collected while walking, so an unwired trigger would be
     invisible to the Motion tab. Sweep for the rest -- a person drops a
     trigger and expects its switch to appear before it is wired to anything. */
  for (const b of blocks) {
    if (b.kind === 'trigger' && !triggers.some((t) => t.blockId === b.id)) {
      triggers.push({ blockId: b.id, label: labelOf(b), initial: b.initial });
    }
  }

  /* Sweep for conditions that do not drive anything yet.
     Resolving backward from state targets finds every rule, but it misses a
     sensor someone wired up purely to PLOT -- watching when a condition would
     have fired is how you decide where to set its threshold before committing
     to it. Those still need evaluating and logging, so they are collected
     here. A chain that is still half-wired throws, and that is not an error
     at this point: it is a condition mid-construction, so it is skipped
     rather than failing the whole compile. */
  /* Anything already visited while resolving a rule -- not just the rule's
     direct root -- is skipped here. A trigger feeding an `if` that feeds a
     rule is already accounted for; re-walking it would double its channel and
     double its entry in the trigger list, even though the final dedup above
     would paper over the list, the wasted work and the confusing intermediate
     state are worth avoiding at the source. */
  /* Two different reasons a block can already be accounted for: it produced a
     ConditionNode during rule resolution (most blocks), or it IS a rule's own
     source but produced no node of its own -- `while` passes straight through
     to its input's node and creates none for itself, so its id would
     otherwise never appear in `conditions` and this sweep would walk it all
     over again. */
  const alreadyWalked = new Set([
    ...conditions.map((c) => c.blockId),
    ...rules.map((r) => r.blockId),
  ]);
  for (const b of blocks) {
    if (!PROGRAMMING_KINDS.has(b.kind) || alreadyWalked.has(b.id)) continue;
    try {
      buildCondition(b.id);
    } catch {
      // Half-wired; it will resolve once the person finishes it.
    }
  }

  /* One entry per block id, for BOTH lists. A leaf condition -- a trigger, a
     sensor -- is reached fresh every time a DIFFERENT rule's chain passes
     through it, since each rule calls buildCondition on its own source
     independently. Two rules sharing one trigger (an "and" rule and its
     complementary "not" rule, say) is an entirely ordinary graph, not an edge
     case, so this cannot be a "shouldn't happen" cleanup step. */
  const seenNodes = new Set<string>();
  const unique = conditions.filter(
    (c) => (seenNodes.has(c.blockId) ? false : (seenNodes.add(c.blockId), true)),
  );
  const seenTriggers = new Set<string>();
  const uniqueTriggers = triggers.filter(
    (t) => (seenTriggers.has(t.blockId) ? false : (seenTriggers.add(t.blockId), true)),
  );

  return { rules, triggers: uniqueTriggers, conditions: unique };

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
