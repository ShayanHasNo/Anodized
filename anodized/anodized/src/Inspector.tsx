import { Block } from './sim/blocks';
import { MOTORS } from './sim/motors';
import { inertia } from './sim/compile';
import { KIND_ACCENT } from './canvas/nodes';

function Num({
  label, value, onChange, step = 1, min, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; hint?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number" value={value} step={step} min={min}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Inspector({
  block, onChange, onDelete, controlled, sourceOptions, sourceUnit,
}: {
  block: Block | null;
  onChange: (b: Block) => void;
  onDelete: () => void;
  /** True when a controller is driving this motor's command port. */
  controlled?: boolean;
  /** Channels wired into a PID's hex input, offered as error sources. */
  sourceOptions?: { key: string; label: string }[];
  sourceUnit?: string;
}) {
  if (!block) {
    return (
      <div className="empty">
        Select a block to edit it, or add one from the palette.
        <br /><br />
        Drag from a port to connect. Shapes have to match — a round port
        will not accept a square one.
        <br /><br />
        Click a connection to select it, then click the × that appears at its
        midpoint to remove it — or press Delete with it selected.
      </div>
    );
  }

  // keyof Block on a discriminated union yields only the shared keys, so the
  // field name is widened here and narrowed by the JSX branch it sits in.
  const set = (k: string, v: unknown) => onChange({ ...block, [k]: v } as Block);
  const accent = KIND_ACCENT[block.kind] ?? 'var(--rotational)';

  return (
    <div style={{ ['--acc' as string]: accent }}>
      {block.kind === 'battery' && (
        <>
          <Num label="Open-circuit voltage" value={block.vOc} step={0.1}
            onChange={(v) => set('vOc', v)} hint="12.6 V fresh, about 12.0 V mid-match" />
          <Num label="Internal resistance (mΩ)" value={block.rBatt * 1000} step={1}
            onChange={(v) => set('rBatt', v / 1000)} hint="15–20 mΩ for an MK ES17-12" />
          <Num label="Wire and breaker (mΩ)" value={block.rBranch * 1000} step={0.5}
            onChange={(v) => set('rBranch', v / 1000)} />
        </>
      )}

      {block.kind === 'motor' && (
        <>
          <div className="field">
            <label>Model</label>
            <select value={block.motorId} onChange={(e) => set('motorId', e.target.value)}>
              {Object.values(MOTORS).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <Num label="Count" value={block.count} min={1}
            onChange={(v) => set('count', Math.max(1, Math.round(v)))}
            hint="Motors on one shaft. Two is 2× torque at the same speed." />
          <div className="field">
            <label>Duty cycle</label>
            <input type="number" value={block.duty} step={0.05} disabled={controlled}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v)) set('duty', Math.max(-1, Math.min(1, v)));
              }} />
            <div className="hint">
              {controlled
                ? 'Driven by the attached controller — this field is ignored.'
                : '−1 to 1. Attach a PID block to drive this automatically.'}
            </div>
          </div>
          <Num label="Current limit per motor (A)" value={block.currentLimit} step={5} min={1}
            onChange={(v) => set('currentLimit', v)} />
        </>
      )}

      {block.kind === 'gear' && (
        <>
          <div className="field">
            <label>Flavor</label>
            <select value={block.flavor} onChange={(e) => set('flavor', e.target.value as never)}>
              <option value="gearbox">Gearbox</option>
              <option value="belt">Belt or chain</option>
              <option value="drum">Drum or pinion (conversion only)</option>
            </select>
            <div className="hint">
              {block.flavor === 'drum'
                ? 'Pure rotation → travel conversion, no reduction of its own.'
                : 'Rotation in, rotation out — unless the option below is on.'}
            </div>
          </div>

          {block.flavor === 'drum' ? (
            <Num label="Radius (mm)" value={(block.radius ?? 0.025) * 1000} step={1} min={1}
              onChange={(v) => set('radius', v / 1000)}
              hint="Pitch radius the cable or belt wraps at" />
          ) : (
            <>
              <Num label="Reduction ratio" value={block.ratio} step={0.5} min={0.01}
                onChange={(v) => set('ratio', v)} hint="Output turns this many times slower" />
              <div className="field">
                <label>
                  <input type="checkbox" checked={!!block.linearOutput}
                    style={{ width: 'auto', marginRight: 6 }}
                    onChange={(e) => set('linearOutput', e.target.checked)} />
                  Add a drum — convert output to travel
                </label>
                <div className="hint">
                  One block does the reduction and the rotation-to-travel
                  conversion, instead of chaining a separate drum block after
                  it. Its output port becomes square.
                </div>
              </div>
              {block.linearOutput && (
                <Num label="Drum radius (mm)" value={(block.radius ?? 0.025) * 1000} step={1} min={1}
                  onChange={(v) => set('radius', v / 1000)}
                  hint="Pitch radius the cable or belt wraps at" />
              )}
            </>
          )}

          <Num label="Efficiency" value={block.efficiency} step={0.01} min={0.1}
            onChange={(v) => set('efficiency', Math.min(1, v))}
            hint="About 0.95 per spur stage, 0.98 per belt stage" />
        </>
      )}

      {block.kind === 'solid' && (
        <>
          <div className="field">
            <label>Gravity mode</label>
            <select value={block.gravityMode} onChange={(e) => set('gravityMode', e.target.value as never)}>
              <option value="none">None — flywheel, turret</option>
              <option value="constant">Constant — elevator, climber</option>
              <option value="angleDependent">Angle-dependent — arm, wrist</option>
            </select>
            <div className="hint">
              {block.gravityMode === 'constant'
                ? 'Needs a drum upstream, and its input port becomes square.'
                : block.gravityMode === 'angleDependent'
                  ? 'Gravity torque peaks at horizontal, vanishes at vertical.'
                  : 'Nothing for the motor to hold against.'}
            </div>
          </div>
          <Num label="Mass (kg)" value={block.mass} step={0.1} min={0.01}
            onChange={(v) => set('mass', v)} />
          {block.gravityMode !== 'constant' && (
            <Num label="Inertia (kg·m²)" value={block.inertia ?? 0.01} step={0.001} min={0}
              onChange={(v) => set('inertia', v)}
              hint={`Disc: ½mr². Arm about pivot: ⅓mL² — a ${block.mass} kg, 0.9 m arm is ${inertia.rodAboutEnd(block.mass, 0.9).toFixed(3)}.`} />
          )}
          {block.gravityMode === 'angleDependent' && (
            <Num label="Centre of gravity (m)" value={block.cgRadius ?? 0.4} step={0.01} min={0}
              onChange={(v) => set('cgRadius', v)} hint="Pivot to centre of mass" />
          )}
          <Num label="Friction (N·m)" value={block.friction} step={0.1} min={0}
            onChange={(v) => set('friction', v)} hint="Coulomb friction at the output shaft" />
          <Num
            label={block.gravityMode === 'constant' ? 'Start position (m)' : 'Start angle (deg)'}
            value={block.initialPosition} step={block.gravityMode === 'constant' ? 0.05 : 5}
            onChange={(v) => set('initialPosition', v)}
            hint={block.gravityMode === 'angleDependent' ? '0 is horizontal, 90 is straight up' : undefined}
          />
        </>
      )}

      {block.kind === 'pid' && (
        <>
          <div className="field">
            <label>Error source</label>
            <select
              value={block.source ?? ''}
              onChange={(e) => set('source', e.target.value || null)}
              disabled={!sourceOptions?.length}
            >
              {!sourceOptions?.length && <option value="">nothing wired in</option>}
              {sourceOptions?.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <div className="hint">
              {sourceOptions?.length
                ? 'Position and velocity only — current and torque are solved later in the same timestep.'
                : 'Drag a hex port into this block’s top input to pick a measurement.'}
            </div>
          </div>
          <Num label={`Target${sourceUnit ? ` (${sourceUnit})` : ''}`} value={block.target} step={5}
            onChange={(v) => set('target', v)}
            hint="Same units as the error source" />
          <div className="field row2">
            <div>
              <label>kP</label>
              <input type="number" value={block.kP} step={0.005}
                onChange={(e) => set('kP', parseFloat(e.target.value) || 0)} />
            </div>
            <div>
              <label>kI</label>
              <input type="number" value={block.kI} step={0.01}
                onChange={(e) => set('kI', parseFloat(e.target.value) || 0)} />
            </div>
          </div>
          <div className="field row2">
            <div>
              <label>kD</label>
              <input type="number" value={block.kD} step={0.001}
                onChange={(e) => set('kD', parseFloat(e.target.value) || 0)} />
            </div>
            <div>
              <label>kF</label>
              <input type="number" value={block.kF} step={0.01}
                onChange={(e) => set('kF', parseFloat(e.target.value) || 0)} />
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 11 }}>
            Gains are in duty per unit of error. kF is constant feedforward —
            on an arm it is what holds position against gravity so the integral
            term does not have to.
          </div>
        </>
      )}

      {block.kind === 'bangbang' && (
        <>
          <div className="field">
            <label>Error source</label>
            <select
              value={block.source ?? ''}
              onChange={(e) => set('source', e.target.value || null)}
              disabled={!sourceOptions?.length}
            >
              {!sourceOptions?.length && <option value="">nothing wired in</option>}
              {sourceOptions?.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <div className="hint">
              {sourceOptions?.length
                ? 'Position and velocity only, same as PID.'
                : 'Drag a hex port into this block’s top input to pick a measurement.'}
            </div>
          </div>
          <Num label={`Target${sourceUnit ? ` (${sourceUnit})` : ''}`} value={block.target} step={5}
            onChange={(v) => set('target', v)} />
          <div className="field row2">
            <div>
              <label>Output</label>
              <input type="number" value={block.output} step={0.05} min={0} max={1}
                onChange={(e) => set('output', Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)))} />
            </div>
            <div>
              <label>Deadband</label>
              <input type="number" value={block.deadband} step={0.5} min={0}
                onChange={(e) => set('deadband', Math.max(0, parseFloat(e.target.value) || 0))} />
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 11 }}>
            Full output in whichever direction closes the error, nothing inside
            the deadband. No in-between — this is what makes it chatter compared
            to PID, and why the deadband exists at all.
          </div>
        </>
      )}

      {block.kind === 'lqr' && (
        <>
          <div className="field">
            <label>State cost — position</label>
            <input type="number" value={block.qPos} step={1} min={0}
              onChange={(e) => set('qPos', Math.max(0, parseFloat(e.target.value) || 0))} />
            <div className="hint">0 drops position from the regulator entirely — pure velocity control, the way a flywheel wants it.</div>
          </div>
          <div className="field">
            <label>State cost — velocity</label>
            <input type="number" value={block.qVel} step={1} min={0.01}
              onChange={(e) => set('qVel', Math.max(0.01, parseFloat(e.target.value) || 0.01))} />
          </div>
          <div className="field">
            <label>Control cost</label>
            <input type="number" value={block.r} step={0.1} min={0.01}
              onChange={(e) => set('r', Math.max(0.01, parseFloat(e.target.value) || 0.01))} />
            <div className="hint">Higher means gentler — less current for the same error.</div>
          </div>
          <div className="field row2">
            <div>
              <label>Target position</label>
              <input type="number" value={block.targetPos} step={5}
                onChange={(e) => set('targetPos', parseFloat(e.target.value) || 0)} />
            </div>
            <div>
              <label>Target velocity</label>
              <input type="number" value={block.targetVel} step={5}
                onChange={(e) => set('targetVel', parseFloat(e.target.value) || 0)} />
            </div>
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={block.gravityFeedforward}
                style={{ width: 'auto', marginRight: 6 }}
                onChange={(e) => set('gravityFeedforward', e.target.checked)} />
              Cancel gravity automatically
            </label>
            <div className="hint">
              Computed from the plant's own mass and geometry each step — no
              hand-tuned constant, unlike PID's kF.
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 11 }}>
            The plant model (motor, ratio, effective inertia) is read directly
            from the attached chain. Gains are the closed-form solution of the
            continuous Riccati equation — shown on the block once it compiles.
          </div>
        </>
      )}

      <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={onDelete}>
        Remove block
      </button>
    </div>
  );
}
