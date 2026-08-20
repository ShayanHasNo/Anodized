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
  position: number;
  min: number;
  max: number;
  setpoint: number | null;
}

/**
 * Elevator, drawn from the SIDE: a thin vertical mast rather than a wide box,
 * which is how an elevator actually looks on a robot and makes the travel the
 * dominant visual rather than the carriage.
 *
 * Several stages chained by prismatic joints render as a cascade -- nested
 * tubes, each riding on the one below and getting slightly narrower going up,
 * the way a real telescoping elevator does. Because each stage rides the one
 * below it, stage heights are CUMULATIVE: the top carriage sits at the sum of
 * every stage's extension, which is exactly what a cascade buys you and what
 * makes it worth drawing differently from a single stage.
 */
export function ElevatorPose({
  stages,
}: { stages: ElevatorStage[] }) {
  const ground = 178, ceiling = 22;
  const budget = ground - ceiling;

  // Scale so the fully-extended cascade exactly fills the frame. Sum of the
  // per-stage maxima, not the max of them, since they stack.
  const totalMax = stages.reduce((s, st) => s + Math.max(0, st.max - st.min), 0);
  const scale = totalMax < 1e-9 ? 0 : (budget * 0.92) / totalMax;

  // Each stage's own extension, and how far the stages below have lifted it.
  const ext = stages.map((st) => Math.max(0, st.position - st.min) * scale);
  const liftBelow: number[] = [];
  let running = 0;
  for (const e of ext) { liftBelow.push(running); running += e; }

  // Setpoint marker: the cascade's total commanded height, when every stage
  // has one. A partial set would be misleading, so it's all or nothing.
  const allHaveSetpoint = stages.every((st) => st.setpoint !== null);
  const setpointY = allHaveSetpoint
    ? ground - stages.reduce((s, st) => s + Math.max(0, (st.setpoint as number) - st.min) * scale, 0)
    : null;

  const railH = budget / Math.max(1, stages.length) * 1.15;

  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img"
      aria-label={stages.length > 1 ? `Cascade elevator, ${stages.length} stages` : 'Elevator position'}>
      {/* base plate -- gives the side view something to stand on */}
      <rect x={64} y={ground} width={72} height={5} rx={2} fill={C.frame} opacity={0.55} />
      {setpointY !== null && <Ghost d={`M56 ${setpointY} L144 ${setpointY}`} />}

      {stages.map((_, i) => {
        const halfW = Math.max(4, 11 - i * 2.2);
        const bottom = ground - liftBelow[i];
        const top = Math.max(ceiling - 6, bottom - railH);
        return (
          <g key={i}>
            <rect x={100 - halfW} y={top} width={halfW * 2} height={bottom - top}
              rx={3} fill={C.live} opacity={0.20 + i * 0.06} />
            <rect x={100 - halfW} y={top} width={halfW * 2} height={bottom - top}
              rx={3} fill="none" stroke={C.liveDark} strokeWidth={0.5} opacity={0.8} />
          </g>
        );
      })}

      {/* carriage rides the top of the last stage */}
      {(() => {
        const topOfStack = ground - running;
        return (
          <>
            <rect x={84} y={topOfStack - 9} width={32} height={16} rx={4} fill={C.live} />
            <rect x={84} y={topOfStack - 9} width={32} height={16} rx={4} fill="none"
              stroke={C.liveDark} strokeWidth={0.5} />
          </>
        );
      })()}
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
  /** True when the parent's rotation carries the child's orientation too. */
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
    return (
      <>
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
      </>
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
