import { useState } from 'react';
import { ResolvedStateGroup } from './sim/compile';
import { ScheduleEvent } from './sim/solver';

/**
 * There are two levels here, and the split is the point.
 *
 * An ACTION is one thing the robot does -- "score coral", "intake". It is a
 * bundle of state changes and waits that belongs together and is reusable:
 * defined once, then referenced from as many programs as needed. Change the
 * action and every program that uses it changes with it.
 *
 * A PROGRAM is a sequence of actions and waits -- a match routine, an auto
 * path, a test. Programs do not contain the low-level detail; they arrange the
 * actions that do.
 *
 * Without the split, "score coral" had to be re-typed as five steps in every
 * program that scored, and retuning the score sequence meant editing all of
 * them and hoping none were missed.
 */

/** One line inside an ACTION: fire a state, or wait. */
export type ActionStep =
  | { kind: 'state'; groupId: string; stateName: string }
  | { kind: 'wait'; seconds: number };

export interface Action {
  id: string;
  name: string;
  steps: ActionStep[];
}

/**
 * One line in a PROGRAM: run an action, wait, or fire a single state directly.
 *
 * The bare 'state' variant is kept for two reasons: files saved before actions
 * existed are programs made entirely of state and wait steps, and they must
 * keep loading; and a one-off state change in a program is a real need that
 * should not require inventing a single-step action to express.
 */
export type Step =
  | { kind: 'action'; actionId: string }
  | { kind: 'state'; groupId: string; stateName: string }
  | { kind: 'wait'; seconds: number };

export interface Program {
  id: string;
  name: string;
  steps: Step[];
}

/**
 * Actions never contain other actions.
 *
 * That is a deliberate ceiling, not an oversight: one level of nesting covers
 * the real use ("a program runs actions") while making cycles structurally
 * impossible. If an action could reference an action, two actions referencing
 * each other would hang the compiler, and guarding against that costs a cycle
 * check on every edit for a capability nobody has asked for.
 */
function expand(steps: Step[], actions: Action[]): ActionStep[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const out: ActionStep[] = [];
  for (const step of steps) {
    if (step.kind === 'action') {
      // A reference to a deleted action contributes nothing rather than
      // throwing -- same tolerance as a step pointing at a deleted state.
      const action = byId.get(step.actionId);
      if (action) out.push(...action.steps);
    } else {
      out.push(step);
    }
  }
  return out;
}

/**
 * Flattens a program into the timed target changes the solver understands.
 *
 * A state step fires at the current cursor and does NOT advance it, so several
 * mechanisms can be commanded at the same instant by listing them back to back.
 * A wait is the only thing that moves time forward -- that keeps "run these
 * together" and "run these in sequence" both expressible, without a separate
 * parallel/serial concept. Actions are expanded inline first, so an action's
 * internal waits advance the program's clock exactly as if its steps had been
 * typed into the program directly.
 */
export function compileProgram(
  program: Program, groups: ResolvedStateGroup[], actions: Action[] = [],
): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  let cursor = 0;
  for (const step of expand(program.steps, actions)) {
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
export function programDuration(program: Program, actions: Action[] = []): number {
  return expand(program.steps, actions).reduce(
    (t, s) => (s.kind === 'wait' ? t + Math.max(0, s.seconds) : t), 0,
  );
}

/** Length of one action on its own, shown on its card. */
export function actionDuration(action: Action): number {
  return action.steps.reduce(
    (t, s) => (s.kind === 'wait' ? t + Math.max(0, s.seconds) : t), 0,
  );
}

/** Shared editor for the state/wait rows an action is built from. */
function StepRows({
  steps, groups, onChange,
}: {
  steps: ActionStep[];
  groups: ResolvedStateGroup[];
  onChange: (steps: ActionStep[]) => void;
}) {
  const replace = (i: number, step: ActionStep) =>
    onChange(steps.map((x, k) => (k === i ? step : x)));

  return (
    <>
      {steps.map((step, si) => (
        <div className="channel-row" key={si}>
          <span className="step-num num">{si + 1}</span>
          {step.kind === 'wait' ? (
            <>
              <span className="stat" style={{ minWidth: 40 }}>wait</span>
              <input type="number" step={0.1} min={0} value={step.seconds}
                style={{ width: 90 }}
                onChange={(e) => replace(si, {
                  kind: 'wait', seconds: Math.max(0, parseFloat(e.target.value) || 0),
                })} />
              <span className="stat" style={{ color: 'var(--ink-3)' }}>seconds</span>
            </>
          ) : (
            <>
              <span className="stat" style={{ minWidth: 40 }}>set</span>
              <select value={`${step.groupId}||${step.stateName}`}
                onChange={(e) => {
                  const [groupId, stateName] = e.target.value.split('||');
                  replace(si, { kind: 'state', groupId, stateName });
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
            onClick={() => onChange(steps.filter((_, k) => k !== si))}>×</button>
        </div>
      ))}

      <div className="motion-readout" style={{ marginTop: 8 }}>
        <button className="btn" disabled={groups.length === 0}
          onClick={() => {
            const g = groups[0];
            const st = g?.states[0];
            if (!g || !st) return;
            onChange([...steps, { kind: 'state', groupId: g.blockId, stateName: st.name }]);
          }}>
          Add state step
        </button>
        <button className="btn"
          onClick={() => onChange([...steps, { kind: 'wait', seconds: 1 }])}>
          Add wait
        </button>
      </div>
    </>
  );
}

export function ActionsView({
  programs, actions, groups, activeId, onChange, onChangeActions, onSelect,
}: {
  programs: Program[];
  actions: Action[];
  groups: ResolvedStateGroup[];
  activeId: string | null;
  onChange: (programs: Program[]) => void;
  onChangeActions: (actions: Action[]) => void;
  onSelect: (id: string | null) => void;
}) {
  const [pane, setPane] = useState<'actions' | 'programs'>('actions');

  const update = (id: string, fn: (p: Program) => Program) =>
    onChange(programs.map((p) => (p.id === id ? fn(p) : p)));
  const updateAction = (id: string, fn: (a: Action) => Action) =>
    onChangeActions(actions.map((a) => (a.id === id ? fn(a) : a)));

  const addProgram = () => {
    const id = `prog${Date.now().toString(36)}`;
    onChange([...programs, { id, name: `Program ${programs.length + 1}`, steps: [] }]);
    onSelect(id);
  };

  const addAction = () => {
    const id = `act${Date.now().toString(36)}`;
    onChangeActions([...actions, { id, name: `Action ${actions.length + 1}`, steps: [] }]);
  };

  /* Deleting an action that programs still reference would leave those steps
     pointing at nothing. Rather than block the delete or silently strip the
     steps, the count is surfaced on the button so the choice is informed. */
  const usesOf = (actionId: string) =>
    programs.reduce((n, p) => n + p.steps.filter(
      (s) => s.kind === 'action' && s.actionId === actionId).length, 0);

  const actionById = new Map(actions.map((a) => [a.id, a]));

  return (
    <div className="graphs-wrap">
      <div className="motion-bar" style={{ marginBottom: 14 }}>
        <div className="tabs" style={{ marginRight: 4 }}>
          <button className={`tab${pane === 'actions' ? ' on' : ''}`}
            onClick={() => setPane('actions')}>
            Actions{actions.length ? ` (${actions.length})` : ''}
          </button>
          <button className={`tab${pane === 'programs' ? ' on' : ''}`}
            onClick={() => setPane('programs')}>
            Programs{programs.length ? ` (${programs.length})` : ''}
          </button>
        </div>
        <button className="btn primary"
          onClick={pane === 'actions' ? addAction : addProgram}>
          {pane === 'actions' ? 'New action' : 'New program'}
        </button>
        <span className="stat" style={{ color: 'var(--ink-3)' }}>
          {groups.length === 0
            ? 'No state blocks in the graph yet — add one and give it states first.'
            : `${groups.length} state block${groups.length === 1 ? '' : 's'} available`}
        </span>
      </div>

      {pane === 'actions' ? (
        <>
          {actions.length === 0 && (
            <div className="empty" style={{ padding: 40, textAlign: 'center' }}>
              No actions yet. An action is one thing the robot does — “score
              coral”, “intake” — built from state changes and waits, and reused
              by any program that needs it.
            </div>
          )}

          {actions.map((action) => (
            <section className="graphcard" key={action.id}>
              <div className="graphcard-head">
                <input className="design-name" value={action.name} style={{ width: 200 }}
                  onChange={(e) => updateAction(action.id, (a) => ({ ...a, name: e.target.value }))} />
                <span className="node-id">{actionDuration(action).toFixed(2)}s</span>
                <span className="node-id">
                  {(() => {
                    const n = usesOf(action.id);
                    return n === 0 ? 'unused' : `used ${n}×`;
                  })()}
                </span>
                <div className="spacer" />
                <button className="iconbtn" aria-label="Delete action"
                  onClick={() => onChangeActions(actions.filter((a) => a.id !== action.id))}>×</button>
              </div>

              <StepRows steps={action.steps} groups={groups}
                onChange={(steps) => updateAction(action.id, (a) => ({ ...a, steps }))} />

              {groups.length > 0 && action.steps.length > 0 && (
                <div className="hint" style={{ marginTop: 8 }}>
                  States fire instantly and stack; only waits advance time. List two
                  states back to back to command both mechanisms at the same moment.
                </div>
              )}
            </section>
          ))}
        </>
      ) : (
        <>
          {programs.length === 0 && (
            <div className="empty" style={{ padding: 40, textAlign: 'center' }}>
              No programs yet. A program sequences actions and waits into a full
              routine — a match, an auto path, a test.
            </div>
          )}

          {programs.map((prog) => (
            <section className={`graphcard${activeId === prog.id ? ' active-prog' : ''}`} key={prog.id}>
              <div className="graphcard-head">
                <input className="design-name" value={prog.name} style={{ width: 200 }}
                  onChange={(e) => update(prog.id, (p) => ({ ...p, name: e.target.value }))} />
                <span className="node-id">{programDuration(prog, actions).toFixed(2)}s</span>
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
                  ) : step.kind === 'action' ? (
                    <>
                      <span className="stat" style={{ minWidth: 40 }}>do</span>
                      <select value={step.actionId}
                        onChange={(e) => update(prog.id, (p) => ({
                          ...p,
                          steps: p.steps.map((x, k) => (k === si
                            ? { kind: 'action', actionId: e.target.value } : x)),
                        }))}>
                        {actions.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                        {/* A reference whose action was deleted still needs to
                            render as something, or the select silently shows
                            an unrelated action. */}
                        {!actionById.has(step.actionId) && (
                          <option value={step.actionId}>(deleted action)</option>
                        )}
                      </select>
                      <span className="stat" style={{ color: 'var(--ink-3)' }}>
                        {actionById.has(step.actionId)
                          ? `${actionDuration(actionById.get(step.actionId)!).toFixed(2)}s`
                          : 'missing — does nothing'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="stat" style={{ minWidth: 40 }}>set</span>
                      <select value={`${step.groupId}||${step.stateName}`}
                        onChange={(e) => {
                          const [groupId, stateName] = e.target.value.split('||');
                          update(prog.id, (p) => ({
                            ...p,
                            steps: p.steps.map((x, k) => (k === si
                              ? { kind: 'state', groupId, stateName } : x)),
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
                <button className="btn" disabled={actions.length === 0}
                  title={actions.length === 0 ? 'Define an action first' : undefined}
                  onClick={() => update(prog.id, (p) => ({
                    ...p, steps: [...p.steps, { kind: 'action', actionId: actions[0].id }],
                  }))}>
                  Add action
                </button>
                <button className="btn"
                  onClick={() => update(prog.id, (p) => ({
                    ...p, steps: [...p.steps, { kind: 'wait', seconds: 1 }],
                  }))}>
                  Add wait
                </button>
                <button className="btn" disabled={groups.length === 0}
                  onClick={() => {
                    const g = groups[0];
                    const st = g?.states[0];
                    if (!g || !st) return;
                    update(prog.id, (p) => ({
                      ...p, steps: [...p.steps, { kind: 'state', groupId: g.blockId, stateName: st.name }],
                    }));
                  }}>
                  Add single state
                </button>
              </div>

              {prog.steps.length > 0 && (
                <div className="hint" style={{ marginTop: 8 }}>
                  Actions run their own steps inline, so an action’s internal waits
                  advance this program’s clock too.
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
