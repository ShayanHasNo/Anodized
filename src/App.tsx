import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, BackgroundVariant,
  useNodesState, useEdgesState, addEdge,
  type Connection, type Node, type NodeChange, type Edge as RFEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Block, PortType, canConnect, portsFor, channelsFor, Edge as SimEdge } from './sim/blocks';
import { compile, inertia, CompileError, type MechanismGroup } from './sim/compile';
import { simulate, createRun, type Run, type SimResult } from './sim/solver';
import { nodeTypes, TYPE_COLOR } from './canvas/nodes';
import { edgeTypes } from './canvas/edges';
import { Inspector } from './Inspector';
import { Library } from './Library';
import { serialize, deserialize, highestIdSuffix, downloadJson, filenameFor } from './persist';
import { dimensionOf, conversionFactor, unitLabel } from './sim/units';
import { MotionView, type MotionMech } from './motion/MotionView';
import { archetypeFor } from './motion/archetypes';
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
/** Raise the id counter above everything in a loaded file. */
const bumpUid = (n: number) => { uid = Math.max(uid, n); };

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
    // The box goes first so it renders behind the blocks it holds. It wraps
    // the motor, gear, solid and controller -- but deliberately not the
    // battery, which is shared across every mechanism.
    { id: 'mech0', type: 'group', position: { x: 210, y: 55 },
      width: 700, height: 340,
      data: { label: 'Arm', moveContents: true }, zIndex: -1 },
    mk(batt, 20, 40), mk(motor, 250, 100), mk(gear, 480, 100), mk(solid, 710, 100),
    mk(pid, 250, 300),
    { id: 'plot1', type: 'plotter', position: { x: 620, y: 440 },
      data: { title: 'Position vs setpoint', seriesCount: 2 } },
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
  const [view, setView] = useState<'canvas' | 'graphs' | 'motion'>('canvas');
  const [frame, setFrame] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [duration, setDuration] = useState(1.5);
  const [designName, setDesignName] = useState('Untitled design');
  const [runMode, setRunMode] = useState<'fixed' | 'live'>('fixed');
  const [liveRunning, setLiveRunning] = useState(false);
  const liveRun = useRef<Run | null>(null);
  const liveRaf = useRef<number | null>(null);
  interface CompiledMechanismInfo {
    motorId: string; solidId: string;
    ratio: number; efficiency: number; inertiaSolid: number; linear: boolean;
    lqr: { blockId: string; k1: number; k2: number } | null;
  }
  const [compiled, setCompiled] = useState<{ mechanisms: CompiledMechanismInfo[] } | null>(null);

  const blocks = useMemo(
    () => nodes
      .filter((n) => n.type !== 'plotter' && n.type !== 'group')
      .map((n) => (n.data as { block: Block }).block),
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

  /* Membership is geometric: a block belongs to whichever box its centre sits
     inside. Deriving it from position rather than storing a parent link means
     dragging a block in or out just works, with no stale references to clean
     up when a box is deleted. */
  const groupNodes = useMemo(() => nodes.filter((n) => n.type === 'group'), [nodes]);

  const groups = useMemo((): MechanismGroup[] => groupNodes.map((g) => {
    const gx = g.position.x, gy = g.position.y;
    const gw = (g.width ?? (g.style?.width as number) ?? 420);
    const gh = (g.height ?? (g.style?.height as number) ?? 240);
    const memberIds = nodes
      .filter((n) => n.type !== 'group' && n.type !== 'plotter')
      .filter((n) => {
        const cx = n.position.x + (n.width ?? 172) / 2;
        const cy = n.position.y + (n.height ?? 80) / 2;
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
      })
      .map((n) => n.id);
    return { id: g.id, label: ((g.data as Record<string, unknown>).label as string) || 'Mechanism', memberIds };
  }), [groupNodes, nodes]);

  /** Everything visually inside a box, plotters included -- used for dragging. */
  const visualMembers = useCallback((g: Node): string[] => {
    const gx = g.position.x, gy = g.position.y;
    const gw = (g.width ?? (g.style?.width as number) ?? 620);
    const gh = (g.height ?? (g.style?.height as number) ?? 210);
    return nodes
      .filter((n) => n.type !== 'group')
      .filter((n) => {
        const cx = n.position.x + (n.width ?? 172) / 2;
        const cy = n.position.y + (n.height ?? 80) / 2;
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
      })
      .map((n) => n.id);
  }, [nodes]);

  const plotterNodes = useMemo(() => nodes.filter((n) => n.type === 'plotter'), [nodes]);
  const plotterIds = useMemo(() => new Set(plotterNodes.map((n) => n.id)), [plotterNodes]);
  const plotterEdges = useMemo(
    () => edges.filter((e) => plotterIds.has(e.target) && e.targetHandle === 'y'),
    [edges, plotterIds],
  );

  const run = useCallback(() => {
    try {
      const simEdges: SimEdge[] = edges
        .filter((e) => blockById.has(e.source) && blockById.has(e.target))
        .map((e) => ({
          from: { blockId: e.source, portId: e.sourceHandle ?? 'out' },
          to: { blockId: e.target, portId: e.targetHandle ?? 'in' },
        }));
      const sys = compile(blocks, simEdges, groups);
      // No global target any more: a controller block owns its own setpoint.
      const r = simulate(sys, { duration });
      setResult(r);
      setFrame((f) => (f >= r.steps ? 0 : f));
      setError(null);
      setErrorBlockId(null);
      setCompiled({
        mechanisms: sys.mechanisms.map((m) => ({
          motorId: m.motorBlock.id, solidId: m.solid.id,
          ratio: m.ratio, efficiency: m.efficiency, inertiaSolid: m.inertiaSolid,
          linear: m.linearDisplay,
          lqr: (m.controller?.kind === 'lqr' && m.lqrGains)
            ? { blockId: m.controller.id, k1: m.lqrGains.k1, k2: m.lqrGains.k2 }
            : null,
        })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorBlockId(e instanceof CompileError ? e.blockId ?? null : null);
      setResult(null);
    }
  }, [edges, blockById, blocks, duration, groups]);

  /* Live tuning: re-run automatically a beat after anything changes, rather
     than making the person click Run after every field edit. Debounced so a
     drag or a fast typed number does not trigger a solve on every keystroke;
     the button stays as an explicit, immediate re-run. */
  useEffect(() => {
    if (runMode === 'live') return;
    const t = setTimeout(run, 180);
    return () => clearTimeout(t);
  }, [run, runMode]);

  /* Live mode advances one shared Run against the wall clock instead of
     solving a fixed window up front. Same solver, same stepping -- the only
     difference is that nothing decides in advance when to stop. */
  useEffect(() => {
    if (runMode !== 'live' || !liveRunning) return;
    let cancelled = false;
    try {
      const simEdges: SimEdge[] = edges
        .filter((e) => blockById.has(e.source) && blockById.has(e.target))
        .map((e) => ({
          from: { blockId: e.source, portId: e.sourceHandle ?? 'out' },
          to: { blockId: e.target, portId: e.targetHandle ?? 'in' },
        }));
      const sys = compile(blocks, simEdges, groups);
      const r = createRun(sys, { duration: 2 });
      liveRun.current = r;
      setError(null);
      setErrorBlockId(null);
      setCompiled({
        mechanisms: sys.mechanisms.map((m) => ({
          motorId: m.motorBlock.id, solidId: m.solid.id,
          ratio: m.ratio, efficiency: m.efficiency, inertiaSolid: m.inertiaSolid,
          linear: m.linearDisplay,
          lqr: (m.controller?.kind === 'lqr' && m.lqrGains)
            ? { blockId: m.controller.id, k1: m.lqrGains.k1, k2: m.lqrGains.k2 }
            : null,
        })),
      });

      let last = performance.now();
      let carry = 0;
      const tick = (now: number) => {
        if (cancelled) return;
        carry += (now - last) / 1000;
        last = now;
        // Cap the catch-up so a backgrounded tab does not return and try to
        // simulate the entire time it was away in one frame.
        const advance = Math.min(Math.floor(carry / r.dt), Math.ceil(0.25 / r.dt));
        if (advance > 0) {
          carry -= advance * r.dt;
          r.advance(advance);
          const snap = r.snapshot();
          setResult(snap);
          setFrame(snap.steps - 1);
        }
        liveRaf.current = requestAnimationFrame(tick);
      };
      liveRaf.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorBlockId(e instanceof CompileError ? e.blockId ?? null : null);
      setLiveRunning(false);
    }
    return () => {
      cancelled = true;
      if (liveRaf.current !== null) cancelAnimationFrame(liveRaf.current);
    };
  }, [runMode, liveRunning, blocks, edges, blockById, groups]);

  /* Series are built per plotter, so each one gets its own independent pair of
     axes. Unit families are assigned to axes in the order they appear within
     that plotter; a third is refused, because a chart with three scales is a
     chart nobody reads. */
  const buildSeries = useCallback((plotterId: string): Series[] => {
    if (!result) return [];
    const families: string[] = [];
    const out: Series[] = [];
    for (const e of plotterEdges) {
      if (e.target !== plotterId) continue;
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

    /* Two channels measuring the same physical dimension in different units --
       one mechanism reporting RPM, another deg/s -- would otherwise be drawn
       against a shared axis as if the numbers were comparable. Convert every
       such series onto the first one's unit so the axis means one thing. */
    const canonical = new Map<string, string>();
    for (const s of out) {
      const dim = dimensionOf(s.unit);
      if (dim && !canonical.has(dim)) canonical.set(dim, s.unit);
    }
    return out.map((s) => {
      const dim = dimensionOf(s.unit);
      if (!dim) return s;
      const target = canonical.get(dim)!;
      if (target === s.unit) return s;
      const f = conversionFactor(s.unit, target);
      const scaled = new Float64Array(s.data.length);
      for (let i = 0; i < s.data.length; i++) scaled[i] = s.data[i] * f;
      return { ...s, data: scaled, unit: target, label: `${s.label} (${unitLabel(s.unit)})` };
    });
  }, [result, plotterEdges]);

  const seriesByPlotter = useMemo(
    () => new Map(plotterNodes.map((p) => [p.id, buildSeries(p.id)])),
    [plotterNodes, buildSeries],
  );

  /* The bottom panel follows the selected plotter, or the first one otherwise,
     so clicking a plotter on the canvas focuses its chart below. */
  const focusedPlotterId = useMemo(() => {
    if (selected && plotterIds.has(selected)) return selected;
    return plotterNodes[0]?.id ?? null;
  }, [selected, plotterIds, plotterNodes]);

  const series = focusedPlotterId ? seriesByPlotter.get(focusedPlotterId) ?? [] : [];
  const focusedEdges = plotterEdges.filter((e) => e.target === focusedPlotterId);
  const droppedSeries = focusedEdges.length - series.length;

  /* One animatable entry per simulated mechanism. Position comes straight from
     the recorded trajectory, so the animation is the simulation -- not a
     re-derivation that could drift from it. */
  const motionMechs = useMemo((): MotionMech[] => {
    if (!result) return [];
    return result.mechanisms.map((m) => {
      const solid = blockById.get(m.solidId) as Extract<Block, { kind: 'solid' }> | undefined;
      const pos = result.data[`${m.solidId}.position`];
      const vel = result.data[`${m.solidId}.velocity`];
      if (!solid || !pos || !vel) return null;

      const chans = channelsFor(solid);
      const posUnit = chans.find((c) => c.key.endsWith('.position'))!.unit;
      const velUnit = chans.find((c) => c.key.endsWith('.velocity'))!.unit;
      const archetype = archetypeFor(solid);

      // Renderers work in SI -- radians for rotation, metres for travel.
      const toBase = archetype === 'elevator' ? 1 : conversionFactor(posUnit, 'rad');

      // A controller's setpoint only makes sense as a pose marker when it
      // tracks position; a velocity setpoint is shown as a readout instead.
      const ctrl = m.controllerId ? blockById.get(m.controllerId) : undefined;
      let setpoint: number | null = null;
      let velocitySetpoint: number | null = null;
      if (ctrl && (ctrl.kind === 'pid' || ctrl.kind === 'bangbang')) {
        if (ctrl.source?.endsWith('.velocity')) velocitySetpoint = ctrl.target;
        else setpoint = ctrl.target;
      } else if (ctrl && ctrl.kind === 'lqr') {
        setpoint = ctrl.targetPos;
      }

      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < pos.length; k++) {
        if (pos[k] < lo) lo = pos[k];
        if (pos[k] > hi) hi = pos[k];
      }
      if (setpoint !== null) { lo = Math.min(lo, setpoint); hi = Math.max(hi, setpoint); }

      return {
        id: m.solidId, label: m.solidId, archetype,
        position: pos, toBase, positionUnit: posUnit,
        velocity: vel, velocityUnit: velUnit,
        setpoint, velocitySetpoint, posMin: lo, posMax: hi,
      } as MotionMech;
    }).filter((x): x is MotionMech => x !== null);
  }, [result, blockById]);

  /* Rendering-only merges: the failing block gets a red-flag, the LQR block
     gets its computed gains, and each plotter gets its live series count --
     without touching the nodes React Flow treats as source of truth for drag
     and selection. */
  const nodesForCanvas = useMemo(
    () => nodes.map((n) => {
      if (n.id === errorBlockId) return { ...n, data: { ...n.data, hasError: true } };
      if (n.type === 'plotter') {
        const count = plotterEdges.filter((e) => e.target === n.id).length;
        return { ...n, data: { ...n.data, seriesCount: count } };
      }
      if (n.type === 'group') {
        const g = groups.find((x) => x.id === n.id);
        return { ...n, data: { ...n.data, memberCount: g?.memberIds.length ?? 0 } };
      }
      const lqrHere = compiled?.mechanisms.find((m) => m.lqr?.blockId === n.id)?.lqr;
      if (lqrHere) {
        return { ...n, data: { ...n.data, gains: { k1: lqrHere.k1, k2: lqrHere.k2 } } };
      }
      return n;
    }),
    [nodes, errorBlockId, compiled, plotterEdges, groups],
  );

  /* --- plotters, save, load ------------------------------------------------ */

  const addPlotter = () => {
    const id = nextId('plot');
    setNodes((ns) => ns.concat({
      id, type: 'plotter',
      position: { x: 200 + Math.random() * 260, y: 300 + Math.random() * 120 },
      data: { title: 'Plotter', seriesCount: 0 },
    }));
    setSelected(id);
  };

  /* Dragging a box carries its contents. Membership is geometric, so it has to
     be snapshotted when the drag STARTS -- recomputing each frame would let
     blocks fall out of the box the moment it moved off them, and they would
     stop following partway through the drag. */
  const dragMembers = useRef<Map<string, string[]>>(new Map());

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const extra: NodeChange[] = [];
    for (const c of changes) {
      if (c.type !== 'position') continue;
      const g = nodes.find((n) => n.id === c.id && n.type === 'group');
      if (!g) continue;

      if (c.dragging === false) { dragMembers.current.delete(c.id); continue; }
      if ((g.data as Record<string, unknown>).moveContents === false) continue;
      if (!c.position) continue;

      let members = dragMembers.current.get(c.id);
      if (!members) { members = visualMembers(g); dragMembers.current.set(c.id, members); }

      const dx = c.position.x - g.position.x;
      const dy = c.position.y - g.position.y;
      if (dx === 0 && dy === 0) continue;

      for (const id of members) {
        // Never fight an explicit change already in this batch.
        if (changes.some((cc) => cc.type === 'position' && cc.id === id)) continue;
        const n = nodes.find((nn) => nn.id === id);
        if (!n) continue;
        extra.push({
          type: 'position', id,
          position: { x: n.position.x + dx, y: n.position.y + dy },
          dragging: c.dragging,
        });
      }
    }
    onNodesChange(extra.length ? [...changes, ...extra] : changes);
  }, [nodes, visualMembers, onNodesChange]);

  const addGroup = () => {
    const id = nextId('mech');
    setNodes((ns) => [
      // Boxes go first in the array so they render behind the blocks they hold.
      { id, type: 'group',
        position: { x: 200 + Math.random() * 120, y: 60 + Math.random() * 80 },
        width: 620, height: 210,
        data: { label: 'Mechanism', moveContents: true },
        selectable: true, draggable: true, zIndex: -1 },
      ...ns,
    ]);
    setSelected(id);
  };

  const renameGroup = (id: string, label: string) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)));

  const renamePlotter = (id: string, title: string) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title } } : n)));

  const onSave = () => {
    downloadJson(filenameFor(designName), serialize(nodes, edges, duration, designName));
  };

  const onLoadFile = async (file: File) => {
    try {
      const parsed = deserialize(await file.text());
      setNodes(parsed.nodes);
      setEdges(parsed.edges);
      setDuration(parsed.duration);
      setDesignName(parsed.name);
      // Clear the id counter past everything in the file, or the next block
      // added would collide with one that was just loaded.
      bumpUid(highestIdSuffix(parsed.nodes));
      setSelected(null);
      setResult(null);
      setError(null);
      setErrorBlockId(null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">Ano<span>dized</span></div>
        <input
          className="design-name"
          value={designName}
          onChange={(e) => setDesignName(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="Untitled design"
          aria-label="Design name"
          title="Names the file when you save"
        />
        <div className={`chainstrip${error ? ' err' : ''}`}>
          {error ? error : compiled ? (
            compiled.mechanisms.length === 1 ? (
              <>
                <span>G <b>{compiled.mechanisms[0].ratio.toFixed(1)}:1</b></span>
                <span className="sep">/</span>
                <span>η <b>{compiled.mechanisms[0].efficiency.toFixed(3)}</b></span>
                <span className="sep">/</span>
                <span>J <b>{compiled.mechanisms[0].inertiaSolid.toFixed(4)}</b> kg·m²</span>
                <span className="sep">/</span>
                <span>dt <b>{result ? (result.dt * 1000).toFixed(3) : '—'}</b> ms</span>
              </>
            ) : (
              <>
                <span><b>{compiled.mechanisms.length}</b> mechanisms sharing one bus</span>
                <span className="sep">/</span>
                <span>dt <b>{result ? (result.dt * 1000).toFixed(3) : '—'}</b> ms</span>
                <span className="sep">/</span>
                <span>{compiled.mechanisms.map((m) => m.solidId).join(', ')}</span>
              </>
            )
          ) : <span>The chain collapses to a handful of numbers. Run to see them.</span>}
        </div>
        <div className="spacer" />
        <div className="tabs">
          <button className={`tab${view === 'canvas' ? ' on' : ''}`}
            onClick={() => setView('canvas')}>Design</button>
          <button className={`tab${view === 'graphs' ? ' on' : ''}`}
            onClick={() => setView('graphs')}>
            Graphs{plotterNodes.length > 1 ? ` (${plotterNodes.length})` : ''}
          </button>
          <button className={`tab${view === 'motion' ? ' on' : ''}`}
            onClick={() => setView('motion')}>Motion</button>
        </div>
        <button className="btn" onClick={onSave}>Save</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>Load</button>
        <input
          ref={fileRef} type="file" accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoadFile(f);
            e.target.value = '';
          }}
        />
        <button className="btn" onClick={() => setShowLibrary(true)}>Library</button>
        {runMode === 'fixed' ? (
          <>
            <span className="stat" style={{ color: 'var(--ink-3)' }}>auto</span>
            <button className="btn primary" onClick={run}>Run now</button>
          </>
        ) : (
          <>
            <span className="stat num" style={{ color: 'var(--ink-3)' }}>
              {result ? `${(result.time[result.steps - 1] ?? 0).toFixed(1)}s` : '0.0s'}
            </span>
            <button className="btn primary" onClick={() => setLiveRunning((v) => !v)}>
              {liveRunning ? 'Stop' : 'Start'}
            </button>
          </>
        )}
      </header>

      {loadError && (
        <div className="loadbar">
          {loadError}
          <button className="iconbtn" onClick={() => setLoadError(null)}>×</button>
        </div>
      )}

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

          <h2 className="railhead">Layout</h2>
          <button className="palette-item"
            style={{ ['--acc' as string]: 'var(--ink-3)' }}
            onClick={addGroup}>
            Mechanism box
          </button>

          <h2 className="railhead">Output</h2>
          <button className="palette-item"
            style={{ ['--acc' as string]: TYPE_COLOR.signal }}
            onClick={addPlotter}>
            Plotter
          </button>

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
            <label>Mode</label>
            <select value={runMode}
              onChange={(e) => {
                setLiveRunning(false);
                setRunMode(e.target.value as 'fixed' | 'live');
              }}>
              <option value="fixed">Fixed duration</option>
              <option value="live">Real time</option>
            </select>
            <div className="hint">
              {runMode === 'fixed'
                ? 'Solves the whole window instantly, then re-solves as you edit.'
                : 'Advances against the wall clock with no end. Edits restart the run.'}
            </div>
          </div>
          <div className="field" style={{ display: runMode === 'fixed' ? undefined : 'none' }}>
            <label>Duration (s)</label>
            <input type="number" value={duration} step={0.25} min={0.1}
              onChange={(e) => setDuration(Math.max(0.1, parseFloat(e.target.value) || 0.1))} />
          </div>
        </aside>

        {view === 'canvas' ? (
          <div className="canvas-wrap">
            <ReactFlow
              nodes={nodesForCanvas} edges={edges}
              onNodesChange={handleNodesChange} onEdgesChange={onEdgesChange}
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
        ) : view === 'motion' ? (
          <div className="graphs-wrap">
            <MotionView mechs={motionMechs} time={result?.time ?? new Float64Array()}
              index={frame} onIndex={setFrame} />
          </div>
        ) : (
          <div className="graphs-wrap">
            {plotterNodes.length === 0 && (
              <div className="empty" style={{ padding: 40, textAlign: 'center' }}>
                No plotters yet. Add one from the Output section on the Design tab.
              </div>
            )}
            {!result && plotterNodes.length > 0 && (
              <div className="empty" style={{ padding: 40, textAlign: 'center' }}>
                Nothing simulated yet — fix the design or press Run now.
              </div>
            )}
            {result && plotterNodes.map((p) => {
              const s = seriesByPlotter.get(p.id) ?? [];
              const title = ((p.data as Record<string, unknown>).title as string) || p.id;
              return (
                <section className="graphcard" key={p.id}>
                  <div className="graphcard-head">
                    <h3 className="graphcard-title">{title}</h3>
                    <span className="node-id">{p.id}</span>
                    <div className="spacer" />
                    {s.map((x) => (
                      <span className="legend-item" key={x.key} style={{ padding: 0 }}>
                        <span className="swatch" style={{ background: x.color }} />
                        {x.label}
                      </span>
                    ))}
                  </div>
                  {s.length > 0
                    ? <Chart time={result.time} series={s} height={200} />
                    : <div className="empty" style={{ padding: '28px 0', textAlign: 'center' }}>
                        No series — wire a hex port into this plotter’s Y input.
                      </div>}
                </section>
              );
            })}
          </div>
        )}

        <aside className="rail rail-r">
          <h2 className="railhead">
            {selectedBlock ? `${selectedBlock.kind} · ${selectedBlock.id}` : 'Inspector'}
          </h2>
          {selected && groupNodes.some((g) => g.id === selected) ? (
            <div className="field">
              <label>Mechanism name</label>
              <input
                type="text"
                value={((groupNodes.find((g) => g.id === selected)?.data as Record<string, unknown>)?.label as string) ?? ''}
                onChange={(ev) => renameGroup(selected, ev.target.value)}
              />
              <div className="hint">
                Blocks whose centre sits inside the box belong to it. A box has
                to hold exactly one complete chain — a motor, its gears, and the
                solid it drives. Drag its edges to resize.
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                Holding <b>{groups.find((g) => g.id === selected)?.memberIds.length ?? 0}</b> blocks.
              </div>
              <label style={{ marginTop: 10, display: 'block' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', marginRight: 6 }}
                  checked={((groupNodes.find((g) => g.id === selected)?.data as Record<string, unknown>)?.moveContents) !== false}
                  onChange={(ev) => setNodes((ns) => ns.map((n) =>
                    (n.id === selected ? { ...n, data: { ...n.data, moveContents: ev.target.checked } } : n)))}
                />
                Move blocks with the box
              </label>
              <div className="hint">
                On by default. Turn it off to reposition or resize the box
                without disturbing what is inside it.
              </div>
              <button className="btn" style={{ width: '100%', marginTop: 10 }}
                onClick={removeSelected}>
                Remove box
              </button>
            </div>
          ) : selected && plotterIds.has(selected) ? (
            <div className="field">
              <label>Plotter name</label>
              <input
                type="text"
                value={((plotterNodes.find((p) => p.id === selected)?.data as Record<string, unknown>)?.title as string) ?? ''}
                onChange={(ev) => renamePlotter(selected, ev.target.value)}
              />
              <div className="hint">
                Shown as the chart heading on the Graphs tab. Wire hex ports
                into this plotter’s Y input to add series.
              </div>
              <button className="btn" style={{ width: '100%', marginTop: 10 }}
                onClick={removeSelected}>
                Remove plotter
              </button>
            </div>
          ) : (
            <Inspector
              block={selectedBlock} onChange={updateBlock} onDelete={removeSelected}
              controlled={motorIsControlled}
              sourceOptions={controllerSources}
              sourceUnit={controllerUnit}
            />
          )}
        </aside>
      </div>

      <section className="results">
        <div className="results-head">
          <h2 className="railhead" style={{ margin: 0 }}>Results</h2>
          {result ? (
            <>
              <span className="stat">total peak <b>{result.peakCurrent.toFixed(0)} A</b></span>
              <span className={`stat ${result.minBusVoltage < 6.3 ? 'warn' : 'good'}`}>
                min bus <b>{result.minBusVoltage.toFixed(2)} V</b>
              </span>
              <span className="stat">dt <b>{(result.dt * 1000).toFixed(3)} ms</b></span>
            </>
          ) : (
            <span className="stat" style={{ color: 'var(--ink-3)' }}>Nothing simulated yet</span>
          )}
        </div>

        {result && result.mechanisms.length > 0 && (
          <div className="results-head" style={{ borderTop: 'none', flexWrap: 'wrap', rowGap: 4 }}>
            {result.mechanisms.map((m) => (
              <span key={m.solidId} className="mechstat">
                <b className="mechstat-name">{m.solidId}</b>
                {m.timeToTarget !== undefined && (
                  <span className="stat">
                    settle <b>{m.timeToTarget === null ? '—' : `${m.timeToTarget.toFixed(3)}s`}</b>
                  </span>
                )}
                {m.overshoot !== null && (
                  <span className={`stat ${m.overshoot > 2 ? 'warn' : 'good'}`}>
                    OS <b>{m.overshoot.toFixed(2)}</b>
                  </span>
                )}
                {m.steadyStateError !== null && (
                  <span className="stat">ss <b>{m.steadyStateError.toFixed(2)}</b></span>
                )}
                <span className="stat">peak <b>{m.peakCurrent.toFixed(0)}A</b></span>
                <span className="stat">τ<sub>m</sub> <b>{(m.timeConstant * 1000).toFixed(1)}ms</b></span>
              </span>
            ))}
          </div>
        )}

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
            <h2 className="railhead">
              {focusedPlotterId
                ? `Y series · ${((plotterNodes.find((p) => p.id === focusedPlotterId)?.data as Record<string, unknown>)?.title as string) || focusedPlotterId}`
                : 'Y series'}
            </h2>
            {plotterNodes.length === 0 && (
              <div className="empty">No plotters. Add one from the Output palette.</div>
            )}
            {plotterNodes.length > 0 && focusedEdges.length === 0 && (
              <div className="empty">Drag from any block’s hex port to this plotter.</div>
            )}
            {focusedEdges.map((e) => {
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
