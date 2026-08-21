import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import {
  Archetype, ArmPose, ElevatorPose, FlywheelPose,
  ArmWithChildPose, ElevatorWithChildPose, stageColor,
  type ChildPose, type ElevatorStage,
} from './archetypes';

export interface MotionMech {
  id: string;
  label: string;
  archetype: Archetype;
  /** Position in display units, one sample per solver step. */
  position: Float64Array;
  /** Multiply a position sample by this to get radians (arm) or metres (elevator). */
  toBase: number;
  positionUnit: string;
  velocity: Float64Array;
  velocityUnit: string;
  /** Controller setpoint in display units, when it tracks position. */
  setpoint: number | null;
  /** Setpoint when the controller tracks velocity instead. */
  velocitySetpoint: number | null;
  posMin: number;
  posMax: number;
  /** Solid id this one is joint-mounted on, or null if it stands alone. */
  parentId: string | null;
  /** True when a revolute joint carries the parent's orientation into this one. */
  inheritsParentAngle: boolean;
  /** Unpowered stages carried by this mechanism, already sampled per frame. */
  passiveStages: { id: string; position: Float64Array; min: number; max: number }[];
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

const CARD_WIDTH_KEY = 'anodized.motion.cardWidth';
const MIN_CARD_WIDTH = 150;
const MAX_CARD_WIDTH = 560;
/* Fits three or four mechanisms across a typical panel without scrolling,
   which is the common case, while still being large enough to read. */
const DEFAULT_CARD_WIDTH = 260;

const clampWidth = (w: number) =>
  Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, w));

export function MotionView({
  mechs, time, index, onIndex,
}: {
  mechs: MotionMech[];
  time: Float64Array;
  index: number;
  onIndex: Dispatch<SetStateAction<number>>;
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  /* How wide one mechanism is drawn, in px.
     The grid used to stretch every card to fill the panel, so a design with a
     single mechanism got ONE card at the full width of the window -- a 200px
     drawing scaled up to 900px, which is why it read as wildly zoomed in and
     needed scrolling to see. Capping the drawing fixes that, and making the
     cap adjustable covers both directions: smaller to fit eight mechanisms on
     screen at once, larger to inspect one closely. */
  const [cardWidth, setCardWidth] = useState<number>(() => {
    // Remembered across sessions: this is a per-person viewing preference, not
    // a property of the design, so it belongs to the browser rather than the
    // save file. Guarded because storage can be unavailable or full.
    try {
      const saved = parseInt(localStorage.getItem(CARD_WIDTH_KEY) ?? '', 10);
      if (Number.isFinite(saved)) return clampWidth(saved);
    } catch { /* fall through to the default */ }
    return DEFAULT_CARD_WIDTH;
  });

  useEffect(() => {
    try { localStorage.setItem(CARD_WIDTH_KEY, String(cardWidth)); } catch { /* ignore */ }
  }, [cardWidth]);
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);
  const acc = useRef<number>(0);

  const steps = time.length;
  const dt = steps > 1 ? time[1] - time[0] : 0.001;

  /* Playback advances against the wall clock rather than one array index per
     frame. At dt = 1 ms a 60 fps loop would otherwise run 16x slow-motion and
     look broken; this keeps 1x meaning one real second per simulated second
     no matter how fine the timestep is. */
  useEffect(() => {
    if (!playing || steps === 0) return;
    last.current = performance.now();
    acc.current = 0;
    const tick = (now: number) => {
      const elapsed = (now - last.current) / 1000;
      last.current = now;
      acc.current += elapsed * speed;
      const advance = Math.floor(acc.current / dt);
      if (advance > 0) {
        acc.current -= advance * dt;
        // Stop at the end and stay there. Looping back to zero hides what the
        // mechanism settled at, which is usually the thing being looked at.
        onIndex((i) => {
          if (i + advance >= steps - 1) { setPlaying(false); return steps - 1; }
          return i + advance;
        });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
  }, [playing, speed, dt, steps, onIndex]);

  const i = Math.min(index, Math.max(0, steps - 1));

  /* Group jointed mechanisms so a child is drawn inside its parent's card
     rather than floating in one of its own. This has to walk the WHOLE chain,
     not just one level -- a three-part mechanism (arm, wrist, gripper) needs
     the gripper embedded inside the wrist, which is itself embedded inside
     the arm. Marking only direct children silently drops anything past the
     first joint from the display entirely, which is exactly the bug this
     replaces: earlier, a chain any deeper than two links lost its last
     mechanism from the Motion tab with no error, since it was flagged as
     "embedded" by the flat pass but nothing ever actually drew it. */
  const byId = new Map(mechs.map((m) => [m.id, m]));
  const childrenOf = new Map<string, MotionMech[]>();
  for (const m of mechs) {
    if (m.parentId && byId.has(m.parentId)) {
      const list = childrenOf.get(m.parentId) ?? [];
      list.push(m);
      childrenOf.set(m.parentId, list);
    }
  }
  // Only the FIRST child at any given tip is embedded -- a second child on
  // the same mount has no sensible place to sit inside the drawing, so it (and
  // whatever chains off IT) keeps its own separate card instead.
  const embedded = new Set<string>();
  const markEmbedded = (id: string) => {
    const first = childrenOf.get(id)?.[0];
    if (first) { embedded.add(first.id); markEmbedded(first.id); }
  };
  for (const m of mechs) markEmbedded(m.id);
  const roots = mechs.filter((m) => !embedded.has(m.id));

  /** Recursively builds the nested pose chain starting at (and including) m. */
  const buildChain = (m: MotionMech): ChildPose => ({
    archetype: m.archetype,
    value: (m.position[i] ?? 0) * m.toBase,
    inheritsAngle: m.inheritsParentAngle,
    travelMin: m.posMin,
    travelMax: m.posMax,
    child: childrenOf.get(m.id)?.[0] ? buildChain(childrenOf.get(m.id)![0]) : undefined,
  });

  /**
   * An unbroken run of elevators chained together is a CASCADE -- stages that
   * ride on each other, so their heights add. Detected here rather than
   * assumed, since an elevator carrying an ARM is a different thing entirely
   * and must not be drawn as a telescoping stack.
   *
   * The run can END in something that is not an elevator, and that case is the
   * common one on a real robot: a cascade with a wrist on the top carriage.
   * That trailing mechanism comes back as `tail` and gets drawn ON the
   * carriage. Refusing to recognise a cascade unless it was elevators all the
   * way down -- which is what the previous check did -- meant exactly this
   * layout fell back to the single-mast renderer, which drew only the bottom
   * stage and hung the wrist off the side of it: the other three stages
   * silently vanished, and the two mechanisms appeared at right angles to each
   * other instead of one riding on top of the other.
   */
  const cascadeOf = (m: MotionMech): { stages: ElevatorStage[]; tail?: MotionMech } | null => {
    if (m.archetype !== 'elevator') return null;
    const stages: ElevatorStage[] = [];
    let cur: MotionMech = m;
    let tail: MotionMech | undefined;

    for (;;) {
      stages.push({
        label: cur.label,
        position: cur.position[i] ?? 0,
        min: cur.posMin,
        max: cur.posMax,
        setpoint: cur.setpoint,
        powered: true,
      });
      // Unpowered stages carried by this one are cascade stages too -- a
      // single-motor cascade is exactly this shape: one powered stage plus
      // however many rigged stages riding on it.
      for (const ps of cur.passiveStages) {
        stages.push({
          label: ps.id, position: ps.position[i] ?? 0,
          min: ps.min, max: ps.max, setpoint: null, powered: false,
        });
      }
      const next: MotionMech | undefined = childrenOf.get(cur.id)?.[0];
      if (!next) break;
      // Stop at the first non-elevator: that chain continues, but as something
      // riding on the carriage rather than as another telescoping stage.
      if (next.archetype !== 'elevator') { tail = next; break; }
      cur = next;
    }
    return stages.length ? { stages, tail } : null;
  };

  /** Flattened labels of an embedded chain, for the card title. */
  const chainLabels = (m: MotionMech): string[] => {
    const next = childrenOf.get(m.id)?.[0];
    return next ? [m.label, ...chainLabels(next)] : [m.label];
  };

  if (mechs.length === 0) {
    return (
      <div className="empty" style={{ padding: 40, textAlign: 'center' }}>
        Nothing to animate yet — run a simulation with at least one mechanism.
      </div>
    );
  }

  return (
    <div className="motion-wrap">
      <div className="motion-bar">
        <button className="btn primary"
          onClick={() => {
            // Replay from the start if we're parked at the end.
            if (!playing && i >= steps - 1) onIndex(0);
            setPlaying((p) => !p);
          }}>
          {playing ? 'Pause' : i >= steps - 1 ? 'Replay' : 'Play'}
        </button>
        <button className="btn" onClick={() => { setPlaying(false); onIndex(0); }}>
          Reset
        </button>
        <input
          type="range" min={0} max={Math.max(0, steps - 1)} value={i}
          onChange={(e) => { setPlaying(false); onIndex(parseInt(e.target.value, 10)); }}
          style={{ flex: 1, minWidth: 120 }}
          aria-label="Scrub through the simulation"
        />
        <span className="stat num" style={{ minWidth: 74, textAlign: 'right' }}>
          {(time[i] ?? 0).toFixed(3)} s
        </span>
        <div className="tabs">
          {SPEEDS.map((s) => (
            <button key={s} className={`tab${speed === s ? ' on' : ''}`}
              onClick={() => setSpeed(s)}>{s}×</button>
          ))}
        </div>

        <div className="motion-size">
          <span className="stat" style={{ color: 'var(--ink-3)' }}>Size</span>
          <input
            type="range" min={MIN_CARD_WIDTH} max={MAX_CARD_WIDTH} step={10}
            value={cardWidth}
            onChange={(e) => setCardWidth(clampWidth(parseInt(e.target.value, 10)))}
            style={{ width: 96 }}
            aria-label="Size of each mechanism drawing"
          />
          <button className="btn" onClick={() => setCardWidth(DEFAULT_CARD_WIDTH)}
            title="Back to the default size">Reset</button>
        </div>
      </div>

      <div className="motion-grid" style={{ ['--motion-card-w' as string]: `${cardWidth}px` }}>
        {roots.map((m) => {
          const firstChild = childrenOf.get(m.id)?.[0];
          const pos = m.position[i] ?? 0;
          const vel = m.velocity[i] ?? 0;
          const base = pos * m.toBase;

          const childPose: ChildPose | null = firstChild ? buildChain(firstChild) : null;
          const labels = firstChild ? chainLabels(m) : [m.label];

          /* A cascade is drawn as one nested stack, so it takes over the card
             from the generic chain renderers -- but only when there is
             actually more than one stage to nest. A lone elevator carrying a
             wrist still reads better as a single mast with the wrist beside
             it. */
          const casc = cascadeOf(m);
          const cascade = casc && casc.stages.length > 1 ? casc : null;
          const cascadeChild = cascade?.tail ? buildChain(cascade.tail) : undefined;

          return (
            <section className="motion-card" key={m.id}>
              <div className="motion-head">
                <h3 className="graphcard-title">{labels.join(' + ')}</h3>
                <span className="node-id">
                  {cascade
                    ? `${cascade.stages.length}-stage cascade${cascade.tail ? ` + ${cascade.tail.label}` : ''}`
                    : labels.length > 1 ? `${labels.length}-link chain` : m.archetype}
                </span>
              </div>
              <div className="motion-stage">
                {cascade && <ElevatorPose stages={cascade.stages} child={cascadeChild} />}
                {!cascade && childPose && m.archetype === 'arm' && (
                  <ArmWithChildPose angle={base}
                    setpoint={m.setpoint === null ? null : m.setpoint * m.toBase}
                    child={childPose} />
                )}
                {!cascade && childPose && m.archetype === 'elevator' && (
                  <ElevatorWithChildPose position={pos} setpoint={m.setpoint}
                    min={m.posMin} max={m.posMax} child={childPose} />
                )}
                {!cascade && !childPose && m.archetype === 'arm' && (
                  <ArmPose angle={base}
                    setpoint={m.setpoint === null ? null : m.setpoint * m.toBase} />
                )}
                {m.archetype === 'flywheel' && <FlywheelPose angle={base} />}
              </div>
              {/* Colour is the only thing telling the stages apart in the
                  drawing, so it needs a key -- otherwise the reader can see
                  that there are four parts but not which is which. */}
              {cascade && (
                <div className="motion-readout" style={{ flexWrap: 'wrap', rowGap: 4 }}>
                  {cascade.stages.map((st, si) => (
                    <span className="stat" key={`${st.label}-${si}`}>
                      <span className="swatch"
                        style={{
                          background: stageColor(si).fill,
                          height: 9, width: 9, flexBasis: 9, borderRadius: 2,
                        }} />
                      {st.label}{st.powered ? '' : ' (rigged)'}
                    </span>
                  ))}
                </div>
              )}
              <div className="motion-readout">
                <span className="stat">
                  pos <b className="num">{fmt(pos)}</b> {m.positionUnit}
                </span>
                <span className="stat">
                  vel <b className="num">{fmt(vel)}</b> {m.velocityUnit}
                </span>
                {m.velocitySetpoint !== null && (
                  <span className="stat">
                    target <b className="num">{fmt(m.velocitySetpoint)}</b> {m.velocityUnit}
                  </span>
                )}
              </div>
              {(() => {
                // One readout row per embedded link beyond the root -- a
                // three-part chain gets a wrist row AND a gripper row, not
                // just the first.
                const rows: MotionMech[] = [];
                let cur = firstChild;
                while (cur) { rows.push(cur); cur = childrenOf.get(cur.id)?.[0]; }
                return rows.map((c) => (
                  <div className="motion-readout" style={{ marginTop: 4 }} key={c.id}>
                    <span className="stat" style={{ color: 'var(--ink-3)' }}>{c.label}</span>
                    <span className="stat">
                      pos <b className="num">{fmt(c.position[i] ?? 0)}</b> {c.positionUnit}
                    </span>
                    <span className="stat">
                      vel <b className="num">{fmt(c.velocity[i] ?? 0)}</b> {c.velocityUnit}
                    </span>
                  </div>
                ));
              })()}
            </section>
          );
        })}
      </div>
    </div>
  );
}
