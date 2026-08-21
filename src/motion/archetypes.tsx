import { Block } from '../sim/blocks';

/**
 * Pose renderers. Each is a pure function of a single value -- shaft angle in
 * radians, or carriage travel in metres -- to SVG. No React state, no
 * animation logic, no knowledge of playback. That separation is what lets the
 * same renderer serve the Motion tab, a canvas mini-preview, and a static
 * thumbnail later without any of them knowing about each other.
 *
 * These show POSE, not packaging. The drawing is a schematic of where the
 * mechanism is, not a model of how big it is or what it might collide with.
 */

export type Archetype = 'arm' | 'elevator' | 'flywheel';

export function archetypeFor(block: Extract<Block, { kind: 'solid' }>): Archetype {
  switch (block.gravityMode) {
    case 'angleDependent': return 'arm';
    case 'constant': return 'elevator';
    default: return 'flywheel';
  }
}

const BOX = 200;

const C = {
  live: '#EF9F27',
  liveDark: '#854F0B',
  frame: '#888780',
  ghost: '#B4B2A9',
};

/**
 * One colour per cascade stage.
 *
 * A cascade drawn in a single colour is unreadable once the stages overlap:
 * every stage is the same shape as the one under it, so at rest they are one
 * indistinguishable blob and mid-travel it is impossible to tell which edge
 * belongs to which stage. Opacity alone does not fix it -- stacked
 * translucent rectangles of the same hue read as one gradient, not as
 * separate parts.
 *
 * Distinct hues do fix it, and they buy the thing that actually matters: the
 * eye can follow ONE stage through the motion and see how far it went, which
 * is the whole question a cascade animation is there to answer. These are
 * picked to stay distinguishable side by side and to hold up when nested, and
 * they are exported so the Motion tab's legend can label them with the same
 * colours it draws them in.
 */
export const STAGE_COLORS: { fill: string; edge: string }[] = [
  { fill: '#EF9F27', edge: '#7A4E09' }, // amber -- the base stage
  { fill: '#5EA8D9', edge: '#20516F' }, // blue
  { fill: '#79C07C', edge: '#2F5E33' }, // green
  { fill: '#C98BC7', edge: '#5F3A5D' }, // mauve
  { fill: '#E0714B', edge: '#75301A' }, // rust
  { fill: '#BFB44E', edge: '#5C551A' }, // olive
];

export const stageColor = (i: number) => STAGE_COLORS[i % STAGE_COLORS.length];

function Ghost({ d }: { d: string }) {
  return (
    <path d={d} fill="none" stroke={C.ghost} strokeWidth={1.5}
      strokeDasharray="5 4" strokeLinecap="round" opacity={0.9} />
  );
}

/** Arm: a rod pivoting about a fixed point. 0 rad is horizontal, +ve is up. */
export function ArmPose({ angle, setpoint }: { angle: number; setpoint: number | null }) {
  // Pivot and length are sized so a full revolution stays inside the box:
  // the rod tip plus its end cap spans y = 112 ± (62 + 8) = 42..182.
  const px = 100, py = 112, len = 62;
  const end = (a: number) => [px + len * Math.cos(a), py - len * Math.sin(a)];
  const [ex, ey] = end(angle);
  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img" aria-label="Arm position">
      <line x1={26} y1={py} x2={174} y2={py} stroke={C.frame} strokeWidth={0.5} opacity={0.45} />
      {setpoint !== null && (() => { const [sx, sy] = end(setpoint);
        return <Ghost d={`M${px} ${py} L${sx} ${sy}`} />; })()}
      <line x1={px} y1={py} x2={ex} y2={ey}
        stroke={C.live} strokeWidth={6} strokeLinecap="round" />
      <circle cx={ex} cy={ey} r={8} fill={C.live} />
      <circle cx={px} cy={py} r={7} fill={C.frame} />
    </svg>
  );
}

/** One stage of an elevator, in its own display units. */
export interface ElevatorStage {
  /** Name shown in the Motion tab's colour legend. */
  label: string;
  position: number;
  min: number;
  max: number;
  setpoint: number | null;
  /** False for a stage carried by the rigging rather than driven directly. */
  powered: boolean;
}

/**
 * Elevator, drawn from the SIDE as a set of NESTED RECTANGLES -- one long
 * rectangle per stage, each riding inside the one below it and each in its own
 * colour.
 *
 * This is the shape a real telescoping cascade has, and drawing it literally
 * is what makes it readable. The stages are all the same LENGTH, which is the
 * property that matters: fully retracted they sit on top of each other and the
 * mechanism is one stage tall, and as it extends they slide apart and stagger,
 * so the silhouette grows to the sum of the extensions while each individual
 * part stays the size it actually is. The previous drawing shortened each
 * stage's rectangle as the stack grew, which made the parts appear to change
 * length -- the one thing a rigid stage never does.
 *
 * Widths taper going up (each stage is narrower than the one carrying it, as
 * it must be to nest inside it) and each stage gets a distinct hue, so a
 * single stage can be followed by eye through the whole travel.
 *
 * Heights are CUMULATIVE: stage n rides on everything below it, so the top
 * carriage sits at the sum of every stage's extension. That is exactly what a
 * cascade buys you, and why it is worth drawing differently from a single mast.
 *
 * A non-elevator mechanism carried on the top carriage (a wrist, an arm) is
 * drawn there via `child`, in the carriage's frame -- a carriage does not
 * rotate, so the child never inherits an angle from it.
 */
export function ElevatorPose({
  stages, child,
}: { stages: ElevatorStage[]; child?: ChildPose }) {
  /* A mechanism riding the carriage swings around it, and at full extension
     the carriage is at the very top of the frame -- so a wrist pointing up
     there would be drawn off the top of the box. Lowering the ceiling when
     something is mounted reserves exactly that swing room. It costs a little
     travel resolution and keeps every pose inside the frame at every point in
     the run, which matters more: a pose that leaves the box is not a small
     cosmetic problem, it is a frame where the mechanism appears to vanish. */
  const ground = 182;
  const ceiling = child ? 52 : 16;
  const budget = ground - ceiling;

  /* Split the frame between travel and stage length. Every stage is drawn the
     same length, and at full extension the stack has to still fit -- so the
     travel gets 62% of the box and one stage length gets the remaining 38%,
     which is what makes a fully-extended cascade exactly fill the frame
     instead of running off the top. */
  const totalMax = stages.reduce((sum, st) => sum + Math.max(0, st.max - st.min), 0);
  const travelBudget = budget * 0.62;
  const stageH = budget - travelBudget;
  const scale = totalMax < 1e-9 ? 0 : travelBudget / totalMax;

  // Each stage's own extension, and how far the stages below have lifted it.
  const ext = stages.map((st) => Math.max(0, st.position - st.min) * scale);
  const liftBelow: number[] = [];
  let running = 0;
  for (const e of ext) { liftBelow.push(running); running += e; }

  /* The carriage rides the TOP EDGE of the last stage, which is that stage's
     own bottom (the ground less everything lifting it) less its length. It is
     NOT the running total: that sum is where the last stage's bottom ends up,
     one whole stage length lower, which would bury the carriage inside the
     stack instead of sitting it on top. */
  const carriageY = ground - liftBelow[stages.length - 1] - stageH;

  /* Setpoint marker: the cascade's total commanded height. Only drawn when
     every stage has one -- a partial sum would be a number that corresponds to
     no commanded position at all, which is worse than no marker. Passive
     stages have no setpoint of their own, so a cascade with rigged stages
     shows the marker on the driven stage's own mast instead (below). */
  const allHaveSetpoint = stages.every((st) => st.setpoint !== null);
  const setpointY = allHaveSetpoint
    ? ground - stages.reduce(
      (sum, st) => sum + Math.max(0, (st.setpoint as number) - st.min) * scale, 0)
    : null;

  const halfWidthOf = (i: number) => Math.max(9, 30 - i * 4.5);

  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img"
      aria-label={stages.length > 1
        ? `Cascade elevator, ${stages.length} nested stages`
        : 'Elevator position'}>
      {/* base plate -- gives the side view something to stand on */}
      <rect x={100 - halfWidthOf(0) - 10} y={ground} width={(halfWidthOf(0) + 10) * 2}
        height={5} rx={2} fill={C.frame} opacity={0.55} />
      {setpointY !== null && <Ghost d={`M46 ${setpointY} L154 ${setpointY}`} />}

      {/* Painted bottom stage first so each nested stage lands ON TOP of the
          one carrying it, which is the stacking a real cascade has. */}
      {stages.map((st, i) => {
        const halfW = halfWidthOf(i);
        const bottom = ground - liftBelow[i];
        const top = bottom - stageH;
        const c = stageColor(i);
        return (
          <g key={i}>
            <rect x={100 - halfW} y={top} width={halfW * 2} height={stageH}
              rx={4} fill={c.fill} opacity={0.9} />
            <rect x={100 - halfW} y={top} width={halfW * 2} height={stageH}
              rx={4} fill="none" stroke={c.edge} strokeWidth={1.2} />
            {/* A rigged stage is marked rather than recoloured, so the colour
                keeps meaning "which stage" and nothing else. */}
            {!st.powered && (
              <line x1={100 - halfW + 4} y1={top + 7} x2={100 + halfW - 4} y2={top + 7}
                stroke={c.edge} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
            )}
          </g>
        );
      })}

      {/* Carriage rides the top of the last stage. */}
      <rect x={100 - halfWidthOf(stages.length - 1) - 5} y={carriageY - 6}
        width={(halfWidthOf(stages.length - 1) + 5) * 2} height={13} rx={3}
        fill={C.frame} opacity={0.9} />

      {/* Anything mounted on the carriage rides up with it. */}
      {child && (
        <g transform={`translate(100 ${carriageY - 6})`}>
          <circle cx={0} cy={0} r={5} fill={C.frame} />
          <ChildBody child={child} len={30} />
        </g>
      )}
    </svg>
  );
}

/** Flywheel: a disc with a spoke, so rotation is visible at any speed. */
export function FlywheelPose({ angle }: { angle: number }) {
  const cx = 100, cy = 100, r = 58;
  const deg = (angle * 180) / Math.PI;
  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img" aria-label="Flywheel rotation">
      <circle cx={cx} cy={cy} r={r} fill={C.live} opacity={0.28} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.liveDark} strokeWidth={0.5} />
      <g transform={`rotate(${-deg} ${cx} ${cy})`}>
        <line x1={cx} y1={cy} x2={cx} y2={cy - r + 6}
          stroke={C.liveDark} strokeWidth={5} strokeLinecap="round" />
        <circle cx={cx} cy={cy - r + 14} r={6} fill={C.live} />
      </g>
      <circle cx={cx} cy={cy} r={9} fill={C.frame} />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Jointed pairs.

   A child is drawn attached at its parent's tip, in the parent's rotated
   frame -- so a wrist on an arm swings with the arm, exactly as the physics
   couples them. The child is drawn smaller and dimmer than a standalone
   mechanism so the parent still reads as the primary body.
   --------------------------------------------------------------------------- */

export interface ChildPose {
  archetype: Archetype;
  /** Radians for a revolute child, metres of travel for a prismatic one. */
  value: number;
  /**
   * True when the parent's rotation carries the child's orientation too --
   * i.e. the parent is a rotating body, so the child's whole mounting frame
   * turns with it.
   *
   * For a prismatic child this also fixes the DIRECTION it extends in. A rail
   * bolted to an arm slides along the arm, because that is the direction the
   * rail is pointing; it does not slide "up" in room coordinates. See the
   * elevator branch of ChildBody.
   */
  inheritsAngle: boolean;
  travelMin: number;
  travelMax: number;
  /**
   * The NEXT link in the chain, if any. Recursive on purpose -- a three- or
   * four-part mechanism (arm, wrist, gripper) is drawn by nesting this all
   * the way down, not by hardcoding a fixed number of levels. Each level
   * shrinks the drawing (see SHRINK below) so a chain of any length stays
   * inside the frame rather than one link silently running off the edge.
   */
  child?: ChildPose;
}

/** Each nested link is drawn at this fraction of its parent's size. */
const SHRINK = 0.55;

/** Draws a child body at the origin, already translated/rotated by the caller. */
function ChildBody({ child, len }: { child: ChildPose; len: number }) {
  const nextLen = len * SHRINK;
  const cap = Math.max(2.5, 5.5 * (len / 30));

  if (child.archetype === 'elevator') {
    const span = child.travelMax - child.travelMin;
    const frac = span < 1e-9 ? 0 : (child.value - child.travelMin) / span;
    const railLen = len * 1.6;
    // Side view: a thin mast whose carriage rides up it, matching the
    // standalone elevator rather than reading as a wide box.
    const halfW = Math.max(2.5, len * 0.16);
    const carHalf = Math.max(5, len * 0.34);
    const carY = -railLen * frac;

    /* WHICH WAY THE RAIL POINTS.
       The mast is authored along local -Y ("up"), which is right for an
       elevator standing on the floor. Mounted on a body that ROTATES, that is
       wrong: a rail bolted to an arm extends along the ARM, so it has to run
       down the parent's own axis (local +X, pointing away from the mount)
       rather than at right angles to it.

       Rotating the child's frame is not enough on its own and was the actual
       bug -- the frame already turned with the arm, and faithfully carried the
       perpendicular mast around with it, so the rail stayed stubbornly square
       to the arm at every angle. The extension direction itself has to change,
       not just the frame it lives in. rotate(90) maps local -Y onto +X, which
       is the outward continuation of the parent. */
    const alongParent = child.inheritsAngle;

    return (
      <g transform={alongParent ? 'rotate(90)' : undefined}>
        <rect x={-halfW} y={-railLen} width={halfW * 2} height={railLen} rx={2}
          fill={C.live} opacity={0.22} />
        <rect x={-halfW} y={-railLen} width={halfW * 2} height={railLen} rx={2}
          fill="none" stroke={C.liveDark} strokeWidth={0.5} opacity={0.7} />
        <rect x={-carHalf} y={carY - 5} width={carHalf * 2} height={10} rx={3}
          fill={C.live} opacity={0.9} />
        {child.child && (
          <g transform={`translate(0 ${carY})`}>
            <circle cx={0} cy={0} r={cap * 0.8} fill={C.frame} />
            <ChildBody child={child.child} len={nextLen} />
          </g>
        )}
      </g>
    );
  }

  if (child.archetype === 'flywheel') {
    const r = len * 0.73;
    return (
      <>
        <circle cx={0} cy={0} r={r} fill={C.live} opacity={0.28} />
        <circle cx={0} cy={0} r={r} fill="none" stroke={C.liveDark} strokeWidth={0.5} />
        <g transform={`rotate(${(-child.value * 180) / Math.PI})`}>
          <line x1={0} y1={0} x2={0} y2={-r + 4} stroke={C.liveDark} strokeWidth={3.5}
            strokeLinecap="round" />
          {child.child && (
            <g transform={`translate(0 ${-r + 4})`}>
              <circle cx={0} cy={0} r={cap * 0.8} fill={C.frame} />
              <ChildBody child={child.child} len={nextLen} />
            </g>
          )}
        </g>
      </>
    );
  }

  // arm-like child: a shorter rod, the tip of which is the next mount point.
  const a = child.value;
  const tipX = len * Math.cos(a), tipY = -len * Math.sin(a);
  const nextDeg = (child.child?.inheritsAngle ? (-child.value * 180) / Math.PI : 0);
  return (
    <>
      <line x1={0} y1={0} x2={tipX} y2={tipY}
        stroke={C.live} strokeWidth={Math.max(2, 4.5 * (len / 30))} strokeLinecap="round" opacity={0.9} />
      <circle cx={tipX} cy={tipY} r={cap} fill={C.live} />
      {child.child && (
        <g transform={`translate(${tipX} ${tipY})${nextDeg ? ` rotate(${nextDeg})` : ''}`}>
          <ChildBody child={child.child} len={nextLen} />
        </g>
      )}
    </>
  );
}

/**
 * An arm carrying a child at its tip. The child sits inside the arm's rotated
 * frame, which is what makes the visual match the physics: rotate the arm and
 * the child goes with it, orientation included.
 */
export function ArmWithChildPose({
  angle, setpoint, child,
}: { angle: number; setpoint: number | null; child: ChildPose }) {
  // Pivot sits at the box centre and the rod is shortened, so that even with
  // the child fully extended in the worst direction the pair spans only
  // 20.5..179.5 -- comfortably inside the 200px frame at any rotation.
  const px = 100, py = 100, len = 44;
  const end = (a: number) => [px + len * Math.cos(a), py - len * Math.sin(a)];
  const [ex, ey] = end(angle);
  const deg = (angle * 180) / Math.PI;
  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img"
      aria-label="Arm carrying a jointed child">
      <line x1={22} y1={py} x2={178} y2={py} stroke={C.frame} strokeWidth={0.5} opacity={0.45} />
      {setpoint !== null && (() => { const [sx, sy] = end(setpoint);
        return <Ghost d={`M${px} ${py} L${sx} ${sy}`} />; })()}
      <line x1={px} y1={py} x2={ex} y2={ey}
        stroke={C.live} strokeWidth={6} strokeLinecap="round" />
      <circle cx={px} cy={py} r={7} fill={C.frame} />
      {/* Child frame: translated to the tip, and rotated with the parent only
          when the joint actually carries orientation (revolute). */}
      <g transform={`translate(${ex} ${ey})${child.inheritsAngle ? ` rotate(${-deg})` : ''}`}>
        <circle cx={0} cy={0} r={7} fill={C.frame} />
        <ChildBody child={child} len={24} />
      </g>
    </svg>
  );
}

/** An elevator carrying a child on its carriage, drawn from the side. */
export function ElevatorWithChildPose({
  position, setpoint, min, max, child,
}: {
  position: number; setpoint: number | null; min: number; max: number; child: ChildPose;
}) {
  const ground = 176, ceiling = 30;
  const span = max - min;
  const y = (v: number) => (span < 1e-9 ? (ground + ceiling) / 2
    : ground - ((v - min) / span) * (ground - ceiling));
  const cy = y(position);
  // The mast sits left of centre so the child has room to swing to the right
  // without leaving the frame.
  const mastX = 62, halfW = 7;
  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img"
      aria-label="Elevator carrying a jointed child">
      <rect x={mastX - 22} y={ground} width={44} height={5} rx={2} fill={C.frame} opacity={0.55} />
      <rect x={mastX - halfW} y={ceiling} width={halfW * 2} height={ground - ceiling}
        rx={3} fill={C.live} opacity={0.20} />
      <rect x={mastX - halfW} y={ceiling} width={halfW * 2} height={ground - ceiling}
        rx={3} fill="none" stroke={C.liveDark} strokeWidth={0.5} opacity={0.7} />
      {setpoint !== null && <Ghost d={`M${mastX - 24} ${y(setpoint)} L${mastX + 24} ${y(setpoint)}`} />}
      <rect x={mastX - 15} y={cy - 8} width={30} height={16} rx={4} fill={C.live} />
      {/* A carriage does not rotate, so the child never inherits an angle here
          -- matching the solver, which contributes no offset from a linear
          parent for exactly the same reason. */}
      <g transform={`translate(${mastX + 18} ${cy})`}>
        <circle cx={0} cy={0} r={6} fill={C.frame} />
        <ChildBody child={child} len={24} />
      </g>
    </svg>
  );
}
