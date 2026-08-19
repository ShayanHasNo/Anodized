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

/**
 * Elevator: a carriage on a vertical rail. Travel is auto-fitted to the range
 * the run actually covers, so a 20 cm hop and a 2 m lift both fill the frame.
 */
export function ElevatorPose({
  position, setpoint, min, max,
}: { position: number; setpoint: number | null; min: number; max: number }) {
  const top = 28, bot = 172;
  const span = max - min;
  const y = (v: number) => (span < 1e-9 ? (top + bot) / 2 : bot - ((v - min) / span) * (bot - top));
  const cy = y(position);
  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} width="100%" role="img" aria-label="Elevator position">
      <rect x={96} y={top} width={8} height={bot - top} rx={3} fill={C.frame} opacity={0.35} />
      {setpoint !== null && <Ghost d={`M60 ${y(setpoint)} L140 ${y(setpoint)}`} />}
      <rect x={68} y={cy - 15} width={64} height={30} rx={5} fill={C.live} />
      <rect x={68} y={cy - 15} width={64} height={30} rx={5} fill="none"
        stroke={C.liveDark} strokeWidth={0.5} />
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
