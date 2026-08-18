import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, BackgroundVariant,
  useNodesState, useEdgesState, addEdge,
  type Connection, type Node, type Edge as RFEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Block, PortType, canConnect, portsFor, channelsFor, Edge as SimEdge } from './sim/blocks';
import { compile, inertia, CompileError } from './sim/compile';
import { simulate, SimResult } from './sim/solver';
import { nodeTypes, TYPE_COLOR } from './canvas/nodes';
import { edgeTypes } from './canvas/edges';
import { Inspector } from './Inspector';
import { Library } from './Library';
import { Chart, Series } from './Chart';

/* Trace colours follow unit family, using the same palette as the ports, so a
   colour means one thing across the canvas and the chart alike. */
const FAMILY_COLOR: Record<string, string> = {
  current: 'var(--electrical)',
  voltage: 'var(--linear)',
  torque: 'var(--rotational)',
  angle: 'var(--signal)',
  length: 'var(--signal)',
  angularRate: '#6fbf73',
  linearRate: '#6fbf73',
  time: 'var(--ink-2)',
  setpoint: 'var(--control)',
  error: '#e0834a',
  duty: 'var(--signal)',
};

/* Setpoint, error, and position are all in the same units, so they share an
   axis. Grouping happens here rather than in the channel definitions because a
   setpoint's units depend on whatever channel it is tracking. */
const AXIS_GROUP: Record<string, string> = {
  angle: 'position', length: 'position', setpoint: 'position', error: 'position',
  angularRate: 'rate', linearRate: 'rate',
  current: 'current', voltage: 'voltage', torque: 'torque', duty: 'duty',
};

const resolve = (v: string) =>
  v.startsWith('var(') ? getComputedStyle(document.documentElement)
    .getPropertyValue(v.slice(4, -1)).trim() : v;

let uid = 0;
const nextId = (kind: string) => `${kind}${++uid}`;

function makeBlock(kind: Block['kind']): Block {
  switch (kind) {
    case 'battery':
      return { kind, id: nextId('batt'), vOc: 12.6, rBatt: 0.018, rBranch: 0.002 };
    case 'motor':
      return { kind, id: nextId('motor'), motorId: 'krakenX60', count: 2, duty: 1, currentLimit: 60 };
    case 'gear':
      return { kind, id: nextId('gear'), flavor: 'gearbox', ratio: 60, efficiency: 0.95 };
    case 'solid':
      return {
        kind, id: nextId('solid'), gravityMode: 'angleDependent',
        mass: 6, inertia: inertia.rodAboutEnd(6, 0.9), cgRadius: 0.45,
        friction: 0.5, initialPosition: 0,
      };
    case 'pid':
      return {
        kind, id: nextId('pid'), source: null, target: 75,
        kP: 0.02, kI: 0, kD: 0.004, kF: 0,
      };
    case 'bangbang':
      return {
        kind, id: nextId('bb'), source: null, target: 75,
        output: 1, deadband: 2,
      };
    case 'lqr':
      return {
        kind, id: nextId('lqr'), qPos: 40, qVel: 4, r: 1,
        targetPos: 75, targetVel: 0, gravityFeedforward: true,
      };
  }
}

/* A starter arm, already wired, so the canvas is never a blank page. */
function initialGraph(): { nodes: Node[]; edges: RFEdge[] } {
  const batt = makeBlock('battery');
  const motor = makeBlock('motor') as Extract<Block, { kind: 'motor' }>;
  const gear = makeBlock('gear');
  const solid = makeBlock('solid');
  const pid = makeBlock('pid') as Extract<Block, { kind: 'pid' }>;
  motor.duty = 0;
  motor.currentLimit = 40;
  pid.source = `${solid.id}.position`;
  const mk = (b: Block, x: number, y: number): Node =>
    ({ id: b.id, type: b.kind, position: { x, y }, data: { block: b } });

  const nodes: Node[] = [
    mk(batt, 20, 40), mk(motor, 250, 100), mk(gear, 480, 100), mk(solid, 710, 100),
    mk(pid, 250, 300),
    { id: 'plot1', type: 'plotter', position: { x: 620, y: 320 }, data: { seriesCount: 2 } },
  ];
  const edges: RFEdge[] = [
    edge(batt.id, 'out', motor.id, 'power', 'electrical'),
    edge(motor.id, 'out', gear.id, 'in', 'rotational'),
    edge(gear.id, 'out', solid.id, 'in', 'rotational'),
    edge(solid.id, 'signal', pid.id, 'measure', 'signal'),
    edge(pid.id, 'command', motor.id, 'command', 'control'),
    { ...edge(solid.id, 'signal', 'plot1', 'y', 'signal'), data: { channel: `${solid.id}.position` } },
    { ...edge(pid.id, 'signal', 'plot1', 'y', 'signal'), data: { channel: `${pid.id}.setpoint` } },
  ];
  return { nodes, edges };
}

function edge(s: string, sh: string, t: string, th: string, type: PortType): RFEdge {
  return {
    id: `${s}:${sh}->${t}:${th}`,
    source: s, sourceHandle: sh, target: t, targetHandle: th,
    style: { stroke: TYPE_COLOR[type], strokeWidth: 1.6 },
    animated: false,
  };
}

export default function App() {
  // useRef evaluates its argument on every render, so build the starter graph
  // lazily -- otherwise StrictMode's double render burns block ids.
  const startRef = useRef<{ nodes: Node[]; edges: RFEdge[] } | null>(null);
  if (!startRef.current) startRef.current = initialGraph();
  const start = startRef.current;

  const [nodes, setNodes, onNodesChange] = useNodesState(start.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(start.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorBlockId, setErrorBlockId] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [duration, setDuration] = useState(1.5);
  const [compiled, setCompiled] = useState<
    | { ratio: number; efficiency: number; inertiaSolid: number; linear: boolean;
        lqr: { blockId: string; k1: number; k2: number } | null }
    | null
  >(null);

  const blocks = useMemo(
    () => nodes.filter((n) => n.type !== 'plotter').map((n) => (n.data as { block: Block }).block),
    [nodes],
  );
  const blockById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  const selectedBlock = selected ? blockById.get(selected) ?? null : null;

  /* A motor whose command port is driven has its duty field taken over. */
  const motorIsControlled = !!selectedBlock && selectedBlock.kind === 'motor'
    && edges.some((e) => e.target === selectedBlock.id && e.targetHandle === 'command');

  /* Error sources offered to a PID or bang-bang block are exactly the channels
     wired into its hex input, filtered to the ones readable at the top of a
     timestep. LQR does not use this -- it reads shaft state directly. */
  const controllerSources = useMemo(() => {
    if (!selectedBlock || (selectedBlock.kind !== 'pid' && selectedBlock.kind !== 'bangbang')) return [];
    const out: { key: string; label: string }[] = [];
    for (const e of edges) {
      if (e.target !== selectedBlock.id || e.targetHandle !== 'measure') continue;
      const src = blockById.get(e.source);
      if (!src) continue;
      for (const ch of channelsFor(src)) {
        if (ch.family === 'angle' || ch.family === 'length'
            || ch.family === 'angularRate' || ch.family === 'linearRate') {
          out.push({ key: ch.key, label: `${src.id} · ${ch.label}` });
        }
      }
    }
    return out;
  }, [selectedBlock, edges, blockById]);

  const controllerUnit = useMemo(() => {
    if (!selectedBlock || (selectedBlock.kind !== 'pid' && selectedBlock.kind !== 'bangbang')) return undefined;
    if (!selectedBlock.source) return undefined;
    for (const b of blocks) {
      const ch = channelsFor(b).find((c) => c.key === selectedBlock.source);
      if (ch) return ch.unit;
    }
    return undefined;
  }, [selectedBlock, blocks]);

  /* Port lookup drives both connection validation and edge colouring. */
  const portOf = useCallback((nodeId: string, handleId: string | null | undefined) => {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return null;
    if (n.type === 'plotter') {
      return handleId === 'x' || handleId === 'y'
        ? { id: handleId, type: 'signal' as PortType, direction: 'in' as const }
        : null;
    }
    const b = (n.data as { block: Block }).block;
    return portsFor(b).find((p) => p.id === handleId) ?? null;
  }, [nodes]);

  const isValidConnection = useCallback((c: Connection | RFEdge) => {
    const out = portOf(c.source!, c.sourceHandle);
    const inp = portOf(c.target!, c.targetHandle);
    if (!out || !inp) return false;
    const occupied = edges.some(
      (e) => e.target === c.target && e.targetHandle === c.targetHandle,
    );
    return canConnect(out, inp, occupied).ok;
  }, [portOf, edges]);

  const onConnect = useCallback((c: Connection) => {
    const out = portOf(c.source!, c.sourceHandle);
    if (!out) return;
    const src = blockById.get(c.source!);
    const first = src ? channelsFor(src)[0]?.key : undefined;
    setEdges((eds) => addEdge({
      ...c,
      id: `${c.source}:${c.sourceHandle}->${c.target}:${c.targetHandle}`,
      style: { stroke: TYPE_COLOR[out.type], strokeWidth: 1.6 },
      data: out.type === 'signal' ? { channel: first } : undefined,
    }, eds));
  }, [portOf, blockById, setEdges]);

  const addBlock = (kind: Block['kind']) => {
    const b = makeBlock(kind);
    setNodes((ns) => ns.concat({
      id: b.id, type: kind,
      position: { x: 120 + Math.random() * 180, y: 200 + Math.random() * 120 },
      data: { block: b },
    }));
    setSelected(b.id);
  };

  const updateBlock = (b: Block) =>
    setNodes((ns) => ns.map((n) => (n.id === b.id ? { ...n, data: { block: b } } : n)));

  const removeSelected = () => {
    if (!selected) return;
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  };

  /* --- run ---------------------------------------------------------------- */

  const plotterEdges = edges.filter((e) => e.target.startsWith('plot') && e.targetHandle === 'y');

  const run = useCallback(() => {
    try {
      const simEdges: SimEdge[] = edges
        .filter((e) => blockById.has(e.source) && blockById.has(e.target))
        .map((e) => ({
          from: { blockId: e.source, portId: e.sourceHandle ?? 'out' },
          to: { blockId: e.target, portId: e.targetHandle ?? 'in' },
        }));
      const c = compile(blocks, simEdges);
      // No global target any more: a controller block owns its own setpoint.
      const r = simulate(c, { duration });
      setResult(r);
      setError(null);
      setErrorBlockId(null);
      setCompiled({
        ratio: c.ratio, efficiency: c.efficiency, inertiaSolid: c.inertiaSolid,
        linear: c.linearDisplay,
        lqr: (c.controller?.kind === 'lqr' && c.lqrGains)
          ? { blockId: c.controller.id, k1: c.lqrGains.k1, k2: c.lqrGains.k2 }
          : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorBlockId(e instanceof CompileError ? e.blockId ?? null : null);
      setResult(null);
    }
  }, [edges, blockById, blocks, duration]);

  /* Live tuning: re-run automatically a beat after anything changes, rather
     than making the person click Run after every field edit. Debounced so a
     drag or a fast typed number does not trigger a solve on every keystroke;
     the button stays as an explicit, immediate re-run. */
  useEffect(() => {
    const t = setTimeout(run, 180);
    return () => clearTimeout(t);
  }, [run]);

  /* Series: one per signal edge landing on the plotter's Y input. Unit families
     are assigned to axes in the order they appear; a third is refused, because
     a chart with three scales is a chart nobody reads. */
  const series: Series[] = useMemo(() => {
    if (!result) return [];
    const families: string[] = [];
    const out: Series[] = [];
    for (const e of plotterEdges) {
      const key = (e.data as { channel?: string } | undefined)?.channel;
      if (!key || !result.data[key]) continue;
      const ch = result.channels.find((c) => c.key === key)!;
      const group = AXIS_GROUP[ch.family] ?? ch.family;
      let ax = families.indexOf(group);
      if (ax === -1) {
        if (families.length >= 2) continue;
        families.push(group);
        ax = families.length - 1;
      }
      out.push({
        key, label: ch.label, unit: ch.unit, family: ch.family,
        color: resolve(FAMILY_COLOR[ch.family] ?? '#a3adb4'),
        data: result.data[key], axis: ax as 0 | 1,
      });
    }
    return out;
  }, [result, plotterEdges]);

  const droppedSeries = plotterEdges.length - series.length;

  /* Rendering-only merges: the failing block gets a red-flag, and the LQR
     block (if any) gets its computed gains, without touching the nodes React
     Flow treats as source of truth for drag and selection. */
  const nodesForCanvas = useMemo(
    () => nodes.map((n) => {
      if (n.id === errorBlockId) return { ...n, data: { ...n.data, hasError: true } };
      if (compiled?.lqr && n.id === compiled.lqr.blockId) {
        return { ...n, data: { ...n.data, gains: { k1: compiled.lqr.k1, k2: compiled.lqr.k2 } } };
      }
      return n;
    }),
    [nodes, errorBlockId, compiled],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">Ano<span>dized</span></div>
        <div className={`chainstrip${error ? ' err' : ''}`}>
          {error ? error : compiled ? (
            <>
              <span>G <b>{compiled.ratio.toFixed(1)}:1</b></span>
              <span className="sep">/</span>
              <span>η <b>{compiled.efficiency.toFixed(3)}</b></span>
              <span className="sep">/</span>
              <span>J <b>{compiled.inertiaSolid.toFixed(4)}</b> kg·m²</span>
              <span className="sep">/</span>
              <span>dt <b>{result ? (result.dt * 1000).toFixed(3) : '—'}</b> ms</span>
            </>
          ) : <span>The chain collapses to a handful of numbers. Run to see them.</span>}
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => setShowLibrary(true)}>Library</button>
        <span className="stat" style={{ color: 'var(--ink-3)' }}>live</span>
        <button className="btn primary" onClick={run}>Run now</button>
      </header>

      {showLibrary && <Library onClose={() => setShowLibrary(false)} />}

      <div className="body">
        <aside className="rail">
          <h2 className="railhead">Add block</h2>
          {([
            ['battery', 'Battery', 'electrical'],
            ['motor', 'Motor', 'electrical'],
            ['gear', 'Gear', 'rotational'],
            ['solid', 'Solid', 'rotational'],
          ] as const).map(([kind, label, type]) => (
            <button key={kind} className="palette-item"
              style={{ ['--acc' as string]: TYPE_COLOR[type] }}
              onClick={() => addBlock(kind)}>
              {label}
            </button>
          ))}

          <h2 className="railhead">Control</h2>
          <button className="palette-item"
            style={{ ['--acc' as string]: TYPE_COLOR.control }}
            onClick={() => addBlock('pid')}>
            PID
          </button>
          <button className="palette-item"
            style={{ ['--acc' as string]: TYPE_COLOR.control }}
            onClick={() => addBlock('bangbang')}>
            Bang-bang
          </button>
          <button className="palette-item"
            style={{ ['--acc' as string]: TYPE_COLOR.control }}
            onClick={() => addBlock('lqr')}>
            LQR
          </button>

          <h2 className="railhead">Run settings</h2>
          <div className="field">
            <label>Duration (s)</label>
            <input type="number" value={duration} step={0.25} min={0.1}
              onChange={(e) => setDuration(Math.max(0.1, parseFloat(e.target.value) || 0.1))} />
          </div>
        </aside>

        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodesForCanvas} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValidConnection}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onSelectionChange={({ nodes: n }) => setSelected(n[0]?.id ?? null)}
            fitView proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'removable', style: { strokeWidth: 1.6 } }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#333b41" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="rail rail-r">
          <h2 className="railhead">
            {selectedBlock ? `${selectedBlock.kind} · ${selectedBlock.id}` : 'Inspector'}
          </h2>
          <Inspector
            block={selectedBlock} onChange={updateBlock} onDelete={removeSelected}
            controlled={motorIsControlled}
            sourceOptions={controllerSources}
            sourceUnit={controllerUnit}
          />
        </aside>
      </div>

      <section className="results">
        <div className="results-head">
          <h2 className="railhead" style={{ margin: 0 }}>Results</h2>
          {result ? (
            <>
              <span className="stat">
                settle <b>{result.timeToTarget === null ? 'never' : `${result.timeToTarget.toFixed(3)} s`}</b>
              </span>
              {result.overshoot !== null && (
                <span className={`stat ${result.overshoot > 2 ? 'warn' : 'good'}`}>
                  overshoot <b>{result.overshoot.toFixed(2)}</b>
                </span>
              )}
              {result.steadyStateError !== null && (
                <span className="stat">
                  ss error <b>{result.steadyStateError.toFixed(2)}</b>
                </span>
              )}
              <span className="stat">peak current <b>{result.peakCurrent.toFixed(0)} A</b></span>
              <span className={`stat ${result.minBusVoltage < 6.3 ? 'warn' : 'good'}`}>
                min bus <b>{result.minBusVoltage.toFixed(2)} V</b>
              </span>
              <span className="stat">τ<sub>m</sub> <b>{(result.timeConstant * 1000).toFixed(1)} ms</b></span>
            </>
          ) : (
            <span className="stat" style={{ color: 'var(--ink-3)' }}>Nothing simulated yet</span>
          )}
        </div>

        <div className="results-body">
          <div className="chartbox">
            {result && series.length > 0
              ? <Chart time={result.time} series={series} />
              : <div className="empty" style={{ padding: '40px 0', textAlign: 'center' }}>
                  {result
                    ? 'Connect a hex port to the plotter’s Y input to draw a trace.'
                    : 'Press Run simulation to see traces.'}
                </div>}
          </div>

          <div className="legend">
            <h2 className="railhead">Y series</h2>
            {plotterEdges.length === 0 && (
              <div className="empty">Drag from any block’s hex port to the plotter.</div>
            )}
            {plotterEdges.map((e) => {
              const src = blockById.get(e.source);
              if (!src) return null;
              const chans = channelsFor(src);
              const key = (e.data as { channel?: string } | undefined)?.channel ?? chans[0].key;
              const s = series.find((x) => x.key === key);
              return (
                <div key={e.id} className="channel-row">
                  <span className="swatch" style={{ background: s?.color ?? 'var(--ink-3)' }} />
                  <select
                    value={key}
                    onChange={(ev) => setEdges((eds) => eds.map((x) =>
                      x.id === e.id ? { ...x, data: { channel: ev.target.value } } : x))}
                  >
                    {chans.map((c) => (
                      <option key={c.key} value={c.key}>{src.id} · {c.label}</option>
                    ))}
                  </select>
                  <button className="iconbtn" aria-label="Remove series"
                    onClick={() => setEdges((eds) => eds.filter((x) => x.id !== e.id))}>×</button>
                </div>
              );
            })}
            {droppedSeries > 0 && (
              <div className="empty" style={{ color: 'var(--danger)' }}>
                {droppedSeries} series hidden — a chart holds two unit scales, not three.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
