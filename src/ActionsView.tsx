import { ResolvedStateGroup } from './sim/compile';
import { ScheduleEvent } from './sim/solver';

/** One line in a program: either fire a state, or wait. */
export type Step =
  | { kind: 'state'; groupId: string; stateName: string }
  | { kind: 'wait'; seconds: number };

export interface Program {
  id: string;
  name: string;
  steps: Step[];
}

/**
 * Flattens a program into the timed target changes the solver understands.
 *
 * A state step fires at the current cursor and does NOT advance it, so several
 * mechanisms can be commanded at the same instant by listing them back to back.
 * A wait is the only thing that moves time forward -- that keeps "run these
 * together" and "run these in sequence" both expressible, without a separate
 * parallel/serial concept.
 */
export function compileProgram(
  program: Program, groups: ResolvedStateGroup[],
): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  let cursor = 0;
  for (const step of program.steps) {
    if (step.kind === 'wait') { cursor += Math.max(0, step.seconds); continue; }
    const group = groups.find((g) => g.blockId === step.groupId);
    const state = group?.states.find((s) => s.name === step.stateName);
    // A step pointing at a deleted state block or renamed state is skipped
    // rather than throwing -- the program stays editable while the graph is
    // mid-change, which is the normal condition while someone is building.
    if (!group || !state) continue;
    events.push({ time: cursor, targets: { ...state.targets } });
  }
  return events;
}

/** Total wall-clock length of a program, for sizing the run duration. */
export function programDuration(program: Program): number {
  return program.steps.reduce(
    (t, s) => (s.kind === 'wait' ? t + Math.max(0, s.seconds) : t), 0,
  );
}

export function ActionsView({
  programs, groups, activeId, onChange, onSelect,
}: {
  programs: Program[];
  groups: ResolvedStateGroup[];
  activeId: string | null;
  onChange: (programs: Program[]) => void;
  onSelect: (id: string | null) => void;
}) {
  const update = (id: string, fn: (p: Program) => Program) =>
    onChange(programs.map((p) => (p.id === id ? fn(p) : p)));

  const addProgram = () => {
    const id = `prog${Date.now().toString(36)}`;
    onChange([...programs, { id, name: `Program ${programs.length + 1}`, steps: [] }]);
    onSelect(id);
  };

  return (
    <div className="graphs-wrap">
      <div className="motion-bar" style={{ marginBottom: 14 }}>
        <button className="btn primary" onClick={addProgram}>New program</button>
        <span className="stat" style={{ color: 'var(--ink-3)' }}>
          {groups.length === 0
            ? 'No state blocks in the graph yet — add one and give it states first.'
            : `${groups.length} state block${groups.length === 1 ? '' : 's'} available`}
        </span>
      </div>

      {programs.length === 0 && (
        <div className="empty" style={{ padding: 40, textAlign: 'center' }}>
          No programs yet. A program is a list of states to fire and waits
          between them — the sequence a robot would actually run.
        </div>
      )}

      {programs.map((prog) => (
        <section className={`graphcard${activeId === prog.id ? ' active-prog' : ''}`} key={prog.id}>
          <div className="graphcard-head">
            <input className="design-name" value={prog.name} style={{ width: 200 }}
              onChange={(e) => update(prog.id, (p) => ({ ...p, name: e.target.value }))} />
            <span className="node-id">{programDuration(prog).toFixed(2)}s</span>
            <div className="spacer" />
            <button className="btn" onClick={() => onSelect(activeId === prog.id ? null : prog.id)}>
              {activeId === prog.id ? 'Selected' : 'Select'}
            </button>
            <button className="iconbtn" aria-label="Delete program"
              onClick={() => {
                onChange(programs.filter((p) => p.id !== prog.id));
                if (activeId === prog.id) onSelect(null);
              }}>×</button>
          </div>

          {prog.steps.map((step, si) => (
            <div className="channel-row" key={si}>
              <span className="step-num num">{si + 1}</span>
              {step.kind === 'wait' ? (
                <>
                  <span className="stat" style={{ minWidth: 40 }}>wait</span>
                  <input type="number" step={0.1} min={0} value={step.seconds}
                    style={{ width: 90 }}
                    onChange={(e) => update(prog.id, (p) => ({
                      ...p,
                      steps: p.steps.map((x, k) => (k === si
                        ? { kind: 'wait', seconds: Math.max(0, parseFloat(e.target.value) || 0) }
                        : x)),
                    }))} />
                  <span className="stat" style={{ color: 'var(--ink-3)' }}>seconds</span>
                </>
              ) : (
                <>
                  <span className="stat" style={{ minWidth: 40 }}>set</span>
                  <select value={`${step.groupId}||${step.stateName}`}
                    onChange={(e) => {
                      const [groupId, stateName] = e.target.value.split('||');
                      update(prog.id, (p) => ({
                        ...p,
                        steps: p.steps.map((x, k) => (k === si ? { kind: 'state', groupId, stateName } : x)),
                      }));
                    }}>
                    {groups.flatMap((g) => g.states.map((st) => (
                      <option key={`${g.blockId}||${st.name}`} value={`${g.blockId}||${st.name}`}>
                        {g.label} → {st.name}
                      </option>
                    )))}
                  </select>
                </>
              )}
              <button className="iconbtn" aria-label="Remove step"
                onClick={() => update(prog.id, (p) => ({
                  ...p, steps: p.steps.filter((_, k) => k !== si),
                }))}>×</button>
            </div>
          ))}

          <div className="motion-readout" style={{ marginTop: 8 }}>
            <button className="btn" disabled={groups.length === 0}
              onClick={() => {
                const g = groups[0];
                const st = g?.states[0];
                if (!g || !st) return;
                update(prog.id, (p) => ({
                  ...p, steps: [...p.steps, { kind: 'state', groupId: g.blockId, stateName: st.name }],
                }));
              }}>
              Add state step
            </button>
            <button className="btn"
              onClick={() => update(prog.id, (p) => ({
                ...p, steps: [...p.steps, { kind: 'wait', seconds: 1 }],
              }))}>
              Add wait
            </button>
          </div>

          {groups.length > 0 && prog.steps.length > 0 && (
            <div className="hint" style={{ marginTop: 8 }}>
              States fire instantly and stack; only waits advance time. List two
              states back to back to command both mechanisms at the same moment.
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
