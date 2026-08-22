import { Block } from './sim/blocks';
import { MOTORS } from './sim/motors';
import { inertia } from './sim/compile';
import { UNITS_BY_DIMENSION, DEFAULT_UNIT, conversionFactor } from './sim/units';
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
  block, onChange, onDelete, controlled, sourceOptions, sourceUnit, stateControllers,
}: {
  block: Block | null;
  onChange: (b: Block) => void;
  onDelete: () => void;
  /** True when a controller is driving this motor's command port. */
  controlled?: boolean;
  /** Channels wired into a PID's hex input, offered as error sources. */
  sourceOptions?: { key: string; label: string }[];
  sourceUnit?: string;
  /** Controllers a selected state block can command, discovered at compile. */
  stateControllers?: { id: string; label: string; unit: string }[];
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
          <Num label="Cell (internal) resistance (mΩ)" value={block.rBatt * 1000} step={1}
            onChange={(v) => set('rBatt', v / 1000)} hint="15–20 mΩ for an MK ES17-12" />
          <Num label="Wire and breaker (mΩ)" value={block.rBranch * 1000} step={0.5}
            onChange={(v) => set('rBranch', v / 1000)} />
          {/* Read-only: the node card on the canvas shows this same total, so
              it needs to be visible here too rather than making someone add
              the two fields above by hand to check they match. */}
          <div className="hint" style={{ marginTop: -6, marginBottom: 11 }}>
            Total circuit resistance: {((block.rBatt + block.rBranch) * 1000).toFixed(1)} mΩ
            (what the canvas card and the simulator both use for sag).
          </div>
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
          {block.gravityMode !== 'constant' && (
            <Num label="Tip radius (m)" value={block.tipRadius ?? (block.cgRadius ?? 0.4) * 2} step={0.01} min={0}
              onChange={(v) => set('tipRadius', v)}
              hint="Pivot to the mount point — only matters if something is jointed onto this solid's tip" />
          )}
          <Num label="Friction (N·m)" value={block.friction} step={0.1} min={0}
            onChange={(v) => set('friction', v)} hint="Coulomb friction at the output shaft" />

          {(() => {
            const linear = block.gravityMode === 'constant';
            const posDim = linear ? 'length' : 'angle';
            const velDim = linear ? 'linearRate' : 'angularRate';
            const posUnit = block.positionUnit ?? DEFAULT_UNIT[posDim];
            const velUnit = block.velocityUnit ?? DEFAULT_UNIT[velDim];
            return (
              <div className="field row2">
                <div>
                  <label>Position unit</label>
                  <select value={posUnit} onChange={(e) => {
                    // Convert the stored start position so the mechanism does
                    // not silently move when the unit changes underneath it.
                    const f = conversionFactor(posUnit, e.target.value);
                    onChange({
                      ...block, positionUnit: e.target.value,
                      initialPosition: block.initialPosition * f,
                    } as Block);
                  }}>
                    {UNITS_BY_DIMENSION[posDim].map((u) => (
                      <option key={u.id} value={u.id}>{u.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Velocity unit</label>
                  <select value={velUnit}
                    onChange={(e) => set('velocityUnit', e.target.value)}>
                    {UNITS_BY_DIMENSION[velDim].map((u) => (
                      <option key={u.id} value={u.id}>{u.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })()}
          <div className="hint" style={{ marginBottom: 11 }}>
            Units are display-only — the solver always works in SI, so changing
            one relabels the channels and rescales the numbers without touching
            the physics. A controller tracking this mechanism reads its setpoint
            in whichever unit the channel it follows is set to.
          </div>

          <Num
            label={`Start position (${block.positionUnit ?? (block.gravityMode === 'constant' ? 'm' : 'deg')})`}
            value={block.initialPosition}
            step={block.gravityMode === 'constant' ? 0.05 : 5}
            onChange={(v) => set('initialPosition', v)}
            hint={block.gravityMode === 'angleDependent' ? '0 is horizontal, 90° is straight up' : undefined}
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

      {block.kind === 'voltage' && (
        <>
          <Num label="Commanded voltage (V)" value={block.volts} step={0.5}
            onChange={(v) => set('volts', v)}
            hint="Signed — negative drives the other way. A state block can set this the same as any other controller target." />
          <div className="hint" style={{ marginBottom: 11 }}>
            Open loop: nothing is measured, so there is no error, no gains, and
            no setpoint to settle on. Each step the commanded volts are divided
            by the live bus voltage to get a duty, so the mechanism holds the
            same voltage as the battery sags instead of quietly getting weaker
            — which is the difference between this and typing a duty into the
            motor block. Ask for more than the bus can give and it saturates at
            full duty; the block’s two voltage channels diverge exactly when
            that happens.
          </div>
        </>
      )}

      {(block.kind === 'limitSwitch' || block.kind === 'encoder'
        || block.kind === 'if' || block.kind === 'waitUntil'
        || block.kind === 'while' || block.kind === 'trigger') && (
        <div className="field">
          <label>Label</label>
          <input type="text" value={block.label}
            onChange={(e) => onChange({ ...block, label: e.target.value } as Block)} />
          <div className="hint">
            Shown on the block and used to name the condition in exported code.
          </div>
        </div>
      )}

      {block.kind === 'limitSwitch' && (
        <>
          <Num label="Trips at position" value={block.position} step={0.05}
            onChange={(v) => set('position', v)}
            hint="In the watched solid's display units." />
          <div className="field">
            <label>Reads true when</label>
            <select value={block.direction}
              onChange={(e) => set('direction', e.target.value as never)}>
              <option value="below">Position is at or below it</option>
              <option value="above">Position is at or above it</option>
            </select>
            <div className="hint">
              A bottom limit switch reads true below its threshold; a top one
              reads true above.
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 11 }}>
            Wire a solid&rsquo;s pentagon port into the top of this block. Only
            arms and elevators can carry one &mdash; a spinning solid has no
            travel limit for a switch to sit at, so the compiler rejects it
            rather than accepting a switch that could never fire.
          </div>
        </>
      )}

      {block.kind === 'encoder' && (
        <>
          <div className="field">
            <label>Watches</label>
            <select value={block.mode} onChange={(e) => set('mode', e.target.value as never)}>
              <option value="position">Position</option>
              <option value="velocity">Velocity</option>
            </select>
          </div>
          <Num label="Threshold" value={block.threshold} step={0.05}
            onChange={(v) => set('threshold', v)}
            hint="In the watched solid's display units for that mode." />
          <div className="field">
            <label>Reads true when</label>
            <select value={block.direction}
              onChange={(e) => set('direction', e.target.value as never)}>
              <option value="above">At or above the threshold</option>
              <option value="below">At or below the threshold</option>
            </select>
          </div>
          <div className="hint" style={{ marginBottom: 11 }}>
            This is a condition, not a second encoder on the robot. It reads
            the state the mechanism already reports, so exported code compares
            against existing inputs rather than configuring new hardware.
          </div>
        </>
      )}

      {block.kind === 'if' && (
        <div className="field">
          <label>Operation</label>
          <select value={block.op} onChange={(e) => set('op', e.target.value as never)}>
            <option value="and">AND — both inputs true</option>
            <option value="or">OR — either input true</option>
            <option value="not">NOT — inverts one input</option>
          </select>
          <div className="hint">
            Switching to NOT drops the B port, so any wire into B is removed.
          </div>
        </div>
      )}

      {block.kind === 'waitUntil' && (
        <div className="hint" style={{ marginBottom: 11 }}>
          Latches. Once its input has been true, it stays true for the rest of
          the run even if the input goes false again &mdash; &ldquo;the elevator
          reached the top at some point&rdquo; rather than &ldquo;the elevator
          is at the top now&rdquo;. Sequencing needs the first one, or a
          mechanism that passes its trigger point and keeps going would un-fire
          the step waiting on it.
        </div>
      )}

      {block.kind === 'while' && (
        <div className="hint" style={{ marginBottom: 11 }}>
          Holds its state only while the condition is true. A plain condition
          wired straight to a state fires once and the state sticks; a while
          block releases when the condition goes false, letting the resting
          state take over again.
        </div>
      )}

      {block.kind === 'trigger' && (
        <div className="field">
          <label>Starts</label>
          <select value={block.initial ? 'on' : 'off'}
            onChange={(e) => set('initial', (e.target.value === 'on') as never)}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
          <div className="hint">
            Flip it during a run from the Motion tab. This sets where it starts;
            flipping the switch does not edit the design. In exported code it
            becomes a settable boolean shaped like a real sensor, so swapping in
            hardware later is a one-line change.
          </div>
        </div>
      )}

      {block.kind === 'joint' && (
        <>
          <div className="field">
            <label>Joint type</label>
            <select value={block.jointType} onChange={(e) => set('jointType', e.target.value as never)}>
              <option value="revolute">Revolute (pivots)</option>
              <option value="prismatic">Prismatic (slides)</option>
            </select>
            <div className="hint">
              {block.jointType === 'revolute'
                ? 'Connect a solid\u2019s tip to this joint\u2019s parent input, and this joint\u2019s child output to an arm or flywheel solid\u2019s mount input.'
                : 'Connect a solid\u2019s tip to this joint\u2019s parent input, and this joint\u2019s child output to an elevator solid\u2019s mount input.'}
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 11 }}>
            The child keeps its own motor, gearbox, and solid — a joint only
            declares what it is attached to and what kind of attachment that
            is. This version validates the wiring; it does not yet couple the
            physics (gravity and reflected mass) between parent and child.
          </div>
        </>
      )}

      {block.kind === 'state' && (() => {
        const ctrls = stateControllers ?? [];
        const setStates = (states: typeof block.states) =>
          onChange({ ...block, states } as Block);
        return (
          <>
            <div className="field">
              <label>Label</label>
              <input type="text" value={block.label}
                onChange={(e) => onChange({ ...block, label: e.target.value } as Block)} />
            </div>

            {ctrls.length === 0 ? (
              <div className="hint" style={{ marginBottom: 11 }}>
                No controllers found yet. Wire this block&rsquo;s input to a
                mechanism box&rsquo;s hex port — the small hexagon on the
                box&rsquo;s name tab — then run once so the graph compiles.
                Every controller in that box, and on anything jointed onto it,
                shows up here.
              </div>
            ) : (
              <div className="hint" style={{ marginBottom: 11 }}>
                Commands {ctrls.length} controller{ctrls.length === 1 ? '' : 's'}:{' '}
                {ctrls.map((c) => c.label).join(', ')}.
              </div>
            )}

            {block.states.map((st, si) => (
              <div key={si} className="state-card">
                <div className="channel-row">
                  <input type="text" value={st.name} placeholder="State name"
                    onChange={(e) => setStates(block.states.map((x, k) =>
                      (k === si ? { ...x, name: e.target.value } : x)))} />
                  <button className="iconbtn" aria-label="Remove state"
                    onClick={() => setStates(block.states.filter((_, k) => k !== si))}>×</button>
                </div>
                {ctrls.map((c) => (
                  <div className="field" key={c.id} style={{ marginBottom: 6 }}>
                    <label>{c.label}{c.unit ? ` (${c.unit})` : ''}</label>
                    <input type="number" step={5}
                      value={st.targets[c.id] ?? 0}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setStates(block.states.map((x, k) => (k === si
                          ? { ...x, targets: { ...x.targets, [c.id]: Number.isNaN(v) ? 0 : v } }
                          : x)));
                      }} />
                  </div>
                ))}
              </div>
            ))}

            <button className="btn" style={{ width: '100%', marginBottom: 8 }}
              disabled={ctrls.length === 0}
              onClick={() => setStates([...block.states, {
                name: `State ${block.states.length + 1}`,
                targets: Object.fromEntries(ctrls.map((c) => [c.id, 0])),
              }])}>
              Add state
            </button>
          </>
        );
      })()}

      <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={onDelete}>
        Remove block
      </button>
    </div>
  );
}
