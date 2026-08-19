import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { Archetype, ArmPose, ElevatorPose, FlywheelPose } from './archetypes';

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
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

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
      </div>

      <div className="motion-grid">
        {mechs.map((m) => {
          const pos = m.position[i] ?? 0;
          const vel = m.velocity[i] ?? 0;
          const base = pos * m.toBase;
          return (
            <section className="motion-card" key={m.id}>
              <div className="motion-head">
                <h3 className="graphcard-title">{m.label}</h3>
                <span className="node-id">{m.archetype}</span>
              </div>
              <div className="motion-stage">
                {m.archetype === 'arm' && (
                  <ArmPose angle={base}
                    setpoint={m.setpoint === null ? null : m.setpoint * m.toBase} />
                )}
                {m.archetype === 'elevator' && (
                  <ElevatorPose position={pos} setpoint={m.setpoint}
                    min={m.posMin} max={m.posMax} />
                )}
                {m.archetype === 'flywheel' && <FlywheelPose angle={base} />}
              </div>
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
