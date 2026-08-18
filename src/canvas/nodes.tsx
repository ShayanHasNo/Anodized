import { Handle, Position, NodeProps } from '@xyflow/react';
import { Block, PortType } from '../sim/blocks';
import { MOTORS } from '../sim/motors';

export const TYPE_COLOR: Record<PortType, string> = {
  rotational: 'var(--rotational)',
  linear: 'var(--linear)',
  electrical: 'var(--electrical)',
  signal: 'var(--signal)',
  control: 'var(--control)',
};

const SHAPE_CLASS: Record<PortType, string> = {
  rotational: 'rotational',
  linear: 'linear',
  electrical: 'electrical',
  signal: 'hexagon',
  control: 'bar',
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
      sub={<>{b.vOc.toFixed(2)} V open circuit<br />{((b.rBatt + b.rBranch) * 1000).toFixed(0)} mΩ internal</>}>
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
      <Port id="signal" type="signal" direction="out" position={Position.Bottom} offset="50%" />
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

export const nodeTypes = {
  battery: BatteryNode,
  motor: MotorNode,
  gear: GearNode,
  solid: SolidNode,
  plotter: PlotterNode,
  pid: PidNode,
  bangbang: BangBangNode,
  lqr: LqrNode,
};
