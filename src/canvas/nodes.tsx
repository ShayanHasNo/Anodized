import { Handle, Position, NodeResizer, NodeProps } from '@xyflow/react';
import { Block, PortType } from '../sim/blocks';
import { MOTORS } from '../sim/motors';

export const TYPE_COLOR: Record<PortType, string> = {
  rotational: 'var(--rotational)',
  linear: 'var(--linear)',
  electrical: 'var(--electrical)',
  signal: 'var(--signal)',
  control: 'var(--control)',
  mount: 'var(--ink-3)',
  sense: 'var(--sense)',
  boolean: 'var(--boolean)',
};

const SHAPE_CLASS: Record<PortType, string> = {
  rotational: 'rotational',
  linear: 'linear',
  electrical: 'electrical',
  signal: 'hexagon',
  control: 'bar',
  mount: 'mount',
  sense: 'pentagon',
  boolean: 'diamond',
};

export const KIND_ACCENT: Record<string, string> = {
  battery: 'var(--electrical)',
  motor: 'var(--electrical)',
  gear: 'var(--rotational)',
  solid: 'var(--rotational)',
  plotter: 'var(--signal)',
  pid: 'var(--control)',
  bangbang: 'var(--control)',
  lqr: 'var(--control)',
  voltage: 'var(--control)',
  joint: 'var(--ink-3)',
  state: 'var(--ok)',
  limitSwitch: 'var(--sense)',
  encoder: 'var(--sense)',
  if: 'var(--boolean)',
  waitUntil: 'var(--boolean)',
  while: 'var(--boolean)',
  trigger: 'var(--boolean)',
};

function Port({
  id, type, direction, position, offset,
}: {
  id: string; type: PortType; direction: 'in' | 'out';
  position: Position; offset: string;
}) {
  const style: React.CSSProperties = { ['--h' as string]: TYPE_COLOR[type] };
  if (position === Position.Left || position === Position.Right) style.top = offset;
  else style.left = offset;
  return (
    <Handle
      id={id}
      type={direction === 'in' ? 'target' : 'source'}
      position={position}
      className={`xy-handle ${SHAPE_CLASS[type]}`}
      style={style}
      title={`${id} — ${type}`}
    />
  );
}

function Shell({
  kind, accentKind, id, title, sub, selected, hasError, children,
}: {
  kind: string; accentKind?: string; id: string; title: string; sub: React.ReactNode;
  selected?: boolean; hasError?: boolean; children?: React.ReactNode;
}) {
  return (
    <div
      className={`node${selected ? ' sel' : ''}${hasError ? ' err' : ''}`}
      style={{ ['--acc' as string]: KIND_ACCENT[accentKind ?? kind] }}
    >
      <div className="node-head">
        <span className="node-kind">{kind}</span>
        <span className="node-id">{id}</span>
      </div>
      <div className="node-body">
        <div className="node-title">{title}</div>
        <div className="node-sub">{sub}</div>
      </div>
      {children}
    </div>
  );
}

type Data = { block: Block; hasError?: boolean } & Record<string, unknown>;

export function BatteryNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'battery' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="battery" id={id} selected={selected} hasError={hasError} title="Battery"
      sub={<>{b.vOc.toFixed(2)} V open circuit<br />{((b.rBatt + b.rBranch) * 1000).toFixed(0)} mΩ total ({(b.rBatt * 1000).toFixed(0)} cell + {(b.rBranch * 1000).toFixed(1)} wiring)</>}>
      <Port id="out" type="electrical" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function MotorNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'motor' }>;
  const spec = MOTORS[b.motorId];
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="motor" id={id} selected={selected} hasError={hasError}
      title={`${b.count}× ${spec?.name ?? b.motorId}`}
      sub={<>{(b.duty * 100).toFixed(0)}% duty<br />{b.currentLimit} A limit per motor</>}>
      <Port id="power" type="electrical" direction="in" position={Position.Left} offset="34%" />
      <Port id="command" type="control" direction="in" position={Position.Left} offset="76%" />
      <Port id="out" type="rotational" direction="out" position={Position.Right} offset="70%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function GearNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'gear' }>;
  const drum = b.flavor === 'drum';
  const hasDrum = drum || !!b.linearOutput;
  const hasError = (data as Data).hasError;
  const label = drum ? 'drum' : b.linearOutput ? `${b.flavor} · drum` : b.flavor;
  const title = drum
    ? `r = ${((b.radius ?? 0) * 1000).toFixed(0)} mm`
    : b.linearOutput
      ? `${b.ratio}:1 · r=${((b.radius ?? 0) * 1000).toFixed(0)}mm`
      : `${b.ratio}:1 reduction`;
  return (
    <Shell kind={label} accentKind="gear" id={id} selected={selected} hasError={hasError}
      title={title}
      sub={<>{(b.efficiency * 100).toFixed(0)}% efficient<br />{hasDrum ? 'rotation → travel' : 'rotation → rotation'}</>}>
      <Port id="in" type="rotational" direction="in" position={Position.Left} offset="60%" />
      <Port id="out" type={hasDrum ? 'linear' : 'rotational'} direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

const GRAVITY_LABEL: Record<string, string> = {
  none: 'no gravity load',
  constant: 'constant gravity',
  angleDependent: 'gravity × cos θ',
};

export function SolidNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'solid' }>;
  const linear = b.gravityMode === 'constant';
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="solid" id={id} selected={selected} hasError={hasError}
      title={`${b.mass} kg`}
      sub={<>{GRAVITY_LABEL[b.gravityMode]}<br />
        {linear ? 'J from drum radius' : `J = ${(b.inertia ?? 0).toFixed(3)} kg·m²`}</>}>
      <Port id="in" type={linear ? 'linear' : 'rotational'} direction="in" position={Position.Left} offset="60%" />
      <span className="handle-tag" style={{ top: -17, left: 76 }}>mount</span>
      <Port id="mount" type="mount" direction="in" position={Position.Top} offset="50%" />
      <span className="handle-tag" style={{ top: '58%', left: 178 }}>tip</span>
      <Port id="tip" type="mount" direction="out" position={Position.Right} offset="60%" />
      <span className="handle-tag" style={{ top: '92%', left: 178 }}>sense</span>
      <Port id="sense" type="sense" direction="out" position={Position.Right} offset="88%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function JointNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'joint' }>;
  const hasError = (data as Data).hasError;
  const label = b.jointType === 'revolute' ? 'Revolute' : 'Prismatic';
  const needs = b.jointType === 'revolute' ? 'arm or flywheel child' : 'elevator child';
  return (
    <Shell kind="joint" id={id} selected={selected} hasError={hasError}
      title={label}
      sub={<>parent → child<br />needs a {needs}</>}>
      <Port id="parent" type="mount" direction="in" position={Position.Left} offset="50%" />
      <Port id="child" type="mount" direction="out" position={Position.Right} offset="50%" />
    </Shell>
  );
}

export function PlotterNode({ id, selected, data }: NodeProps) {
  const d = data as Record<string, unknown>;
  const n = (d.seriesCount as number) ?? 0;
  const title = (d.title as string) || 'Plotter';
  return (
    <div className={`node${selected ? ' sel' : ''}`} style={{ ['--acc' as string]: KIND_ACCENT.plotter }}>
      <div className="node-head">
        <span className="node-kind">plotter</span>
        <span className="node-id">{id}</span>
      </div>
      <div className="node-body">
        <div className="node-title">{title}</div>
        <div className="node-sub">
          {n === 0 ? 'no series yet' : `${n} series`}<br />
          x — time
        </div>
      </div>
      <span className="handle-tag" style={{ top: -17, left: 46 }}>x</span>
      <span className="handle-tag" style={{ top: -17, left: 119 }}>y</span>
      <Port id="x" type="signal" direction="in" position={Position.Top} offset="30%" />
      <Port id="y" type="signal" direction="in" position={Position.Top} offset="72%" />
    </div>
  );
}

export function PidNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'pid' }>;
  const unit = (data as Record<string, unknown>).unit as string | undefined;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="pid" id={id} selected={selected} hasError={hasError}
      title={`target ${b.target}${unit ? ` ${unit}` : ''}`}
      sub={<>P {b.kP} · I {b.kI} · D {b.kD}<br />
        {b.source ? b.source.split('.')[1] : 'nothing wired'} → duty</>}>
      <Port id="measure" type="signal" direction="in" position={Position.Top} offset="50%" />
      <Port id="command" type="control" direction="out" position={Position.Right} offset="66%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function BangBangNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'bangbang' }>;
  const unit = (data as Record<string, unknown>).unit as string | undefined;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="bangbang" id={id} selected={selected} hasError={hasError}
      title={`target ${b.target}${unit ? ` ${unit}` : ''}`}
      sub={<>±{(b.output * 100).toFixed(0)}%, ±{b.deadband} deadband<br />
        {b.source ? b.source.split('.')[1] : 'nothing wired'} → duty</>}>
      <Port id="measure" type="signal" direction="in" position={Position.Top} offset="50%" />
      <Port id="command" type="control" direction="out" position={Position.Right} offset="66%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function LqrNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'lqr' }>;
  const gains = (data as Record<string, unknown>).gains as { k1: number; k2: number } | undefined;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="lqr" id={id} selected={selected} hasError={hasError}
      title={`pos ${b.targetPos} · vel ${b.targetVel}`}
      sub={<>Q [{b.qPos}, {b.qVel}]  R {b.r}<br />
        {gains ? `K = [${gains.k1.toFixed(4)}, ${gains.k2.toFixed(4)}]` : 'reads shaft state'}</>}>
      <Port id="measure" type="signal" direction="in" position={Position.Top} offset="50%" />
      <Port id="command" type="control" direction="out" position={Position.Right} offset="66%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function VoltageNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'voltage' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="voltage" id={id} selected={selected} hasError={hasError}
      title={`${b.volts.toFixed(2)} V`}
      sub={<>open loop — no feedback<br />duty = V ÷ bus, each step</>}>
      <Port id="command" type="control" direction="out" position={Position.Right} offset="66%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function GroupNode({ id, selected, data }: NodeProps) {
  const d = data as Record<string, unknown>;
  const label = (d.label as string) || 'Mechanism';
  const hasError = d.hasError as boolean | undefined;
  const count = (d.memberCount as number) ?? 0;
  return (
    <>
      <NodeResizer
        minWidth={260} minHeight={170}
        isVisible={selected}
        lineClassName="group-resize-line"
        handleClassName="group-resize-handle"
      />
      <div className={`mech-group${selected ? ' sel' : ''}${hasError ? ' err' : ''}`}>
        <div className="mech-group-tab">
          <span className="mech-group-label">{label}</span>
          <span className="node-id">{count === 0 ? 'empty' : `${count} blocks`}</span>
          {/* The box's one port: what a state block attaches to. It lives on
              the title tab rather than the box edge so it stays put when the
              box is resized, and so dragging from it can never be confused
              with dragging a resize handle. */}
          <span className="group-port">
            <span className="handle-tag" style={{ top: -16, left: -18 }}>states</span>
            <Handle
              id="mechanism" type="source" position={Position.Right}
              className="xy-handle hexagon"
              style={{ ['--h' as string]: TYPE_COLOR.signal, position: 'relative', top: 0, right: 0, transform: 'none' }}
              title="mechanism — signal"
            />
          </span>
        </div>
      </div>
    </>
  );
}

export function StateNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'state' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="state" id={id} selected={selected} hasError={hasError}
      title={b.label || 'States'}
      sub={<>{b.states.length === 0 ? 'no states yet' : `${b.states.length} state${b.states.length === 1 ? '' : 's'}`}<br />
        wire a mechanism box in</>}>
      <Port id="mechanism" type="signal" direction="in" position={Position.Left} offset="30%" />
      {/* One diamond per state, spread down the left edge. A wire landing on a
          named port is the whole point of the programming layer: you can see
          what drives what without opening an inspector. */}
      {b.states.map((st, i) => (
        <span key={`tag-${st.name}`} className="handle-tag state-tag"
          style={{ top: `${52 + i * 15}%`, left: -6, transform: 'translateX(-100%)' }}>
          {st.name}
        </span>
      ))}
      {b.states.map((st, i) => (
        <Port key={st.name} id={`when:${st.name}`} type="boolean" direction="in"
          position={Position.Left} offset={`${56 + i * 15}%`} />
      ))}
    </Shell>
  );
}

/* --- programming blocks --------------------------------------------------- */

const DIR_LABEL = { above: '≥', below: '≤' } as const;

export function LimitSwitchNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'limitSwitch' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="limit switch" accentKind="limitSwitch" id={id} selected={selected} hasError={hasError}
      title={b.label || 'Limit switch'}
      sub={<>true when pos {DIR_LABEL[b.direction]} {b.position}<br />arms and elevators only</>}>
      <span className="handle-tag" style={{ top: -17, left: 76 }}>solid</span>
      <Port id="solid" type="sense" direction="in" position={Position.Top} offset="50%" />
      <Port id="value" type="boolean" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function EncoderNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'encoder' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="encoder" id={id} selected={selected} hasError={hasError}
      title={b.label || 'Encoder'}
      sub={<>true when {b.mode} {DIR_LABEL[b.direction]} {b.threshold}<br />reads the solid it watches</>}>
      <span className="handle-tag" style={{ top: -17, left: 76 }}>solid</span>
      <Port id="solid" type="sense" direction="in" position={Position.Top} offset="50%" />
      <Port id="value" type="boolean" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function IfNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'if' }>;
  const hasError = (data as Data).hasError;
  const unary = b.op === 'not';
  return (
    <Shell kind="if" id={id} selected={selected} hasError={hasError}
      title={b.label || b.op.toUpperCase()}
      sub={<>{unary ? 'inverts its input' : `true when both sides ${b.op === 'and' ? 'are' : 'or either is'} true`}</>}>
      <span className="handle-tag" style={{ top: '48%', left: -14 }}>A</span>
      <Port id="a" type="boolean" direction="in" position={Position.Left} offset="55%" />
      {!unary && <>
        <span className="handle-tag" style={{ top: '68%', left: -14 }}>B</span>
        <Port id="b" type="boolean" direction="in" position={Position.Left} offset="75%" />
      </>}
      <Port id="value" type="boolean" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function WaitUntilNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'waitUntil' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="wait until" accentKind="waitUntil" id={id} selected={selected} hasError={hasError}
      title={b.label || 'Wait until'}
      sub={<>latches true and stays true<br />once its input first fires</>}>
      <Port id="a" type="boolean" direction="in" position={Position.Left} offset="60%" />
      <Port id="value" type="boolean" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function WhileNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'while' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="while" id={id} selected={selected} hasError={hasError}
      title={b.label || 'While'}
      sub={<>holds its state only while<br />the condition stays true</>}>
      <Port id="a" type="boolean" direction="in" position={Position.Left} offset="60%" />
      <Port id="value" type="boolean" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export function TriggerNode({ data, id, selected }: NodeProps) {
  const b = (data as Data).block as Extract<Block, { kind: 'trigger' }>;
  const hasError = (data as Data).hasError;
  return (
    <Shell kind="trigger" id={id} selected={selected} hasError={hasError}
      title={b.label || 'Trigger'}
      sub={<>flip it by hand in Motion<br />starts {b.initial ? 'on' : 'off'}</>}>
      <Port id="value" type="boolean" direction="out" position={Position.Right} offset="60%" />
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
    </Shell>
  );
}

export const nodeTypes = {
  battery: BatteryNode,
  motor: MotorNode,
  gear: GearNode,
  solid: SolidNode,
  plotter: PlotterNode,
  pid: PidNode,
  bangbang: BangBangNode,
  lqr: LqrNode,
  joint: JointNode,
  state: StateNode,
  voltage: VoltageNode,
  group: GroupNode,
  limitSwitch: LimitSwitchNode,
  encoder: EncoderNode,
  if: IfNode,
  waitUntil: WaitUntilNode,
  while: WhileNode,
  trigger: TriggerNode,
};
