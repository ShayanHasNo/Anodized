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
  ControllerBlock, LqrBlock, JointBlock, CONTROL_KINDS, Edge,
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
    parentAngleSource: null, mountedOn: null,
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
    const childrenOfParent = new Map<string, Mechanism[]>();

    for (const j of joints) {
      const parentId = parentOfJoint.get(j.id)!;
      const childId = childOfJoint.get(j.id)!;
      const parentMech = mechBySolidId.get(parentId);
      const childMech = mechBySolidId.get(childId);
      if (!parentMech) {
        throw new CompileError(
          `Joint "${j.id}" is mounted on "${parentId}", but "${parentId}" has no motor driving it. Every mechanism needs its own motor, gearbox, and solid.`,
          parentId,
        );
      }
      if (!childMech) {
        throw new CompileError(
          `Joint "${j.id}" mounts "${childId}", but "${childId}" has no motor driving it. Every mechanism needs its own motor, gearbox, and solid.`,
          childId,
        );
      }
      childMech.mountedOn = parentId;
      if (j.jointType === 'revolute') childMech.parentAngleSource = parentId;
      const list = childrenOfParent.get(parentId) ?? [];
      list.push(childMech);
      childrenOfParent.set(parentId, list);
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

    for (const [parentId, children] of childrenOfParent) {
      const parentMech = mechBySolidId.get(parentId)!;
      const totalChildMass = children.reduce((sum, c) => sum + c.solid.mass, 0);
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

  return { battery, mechanisms };
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
