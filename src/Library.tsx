import { PortType } from './sim/blocks';
import { KIND_ACCENT } from './canvas/nodes';

const PORT_DOCS: { type: PortType; shape: string; name: string; desc: string }[] = [
  { type: 'rotational', shape: 'circle', name: 'Rotational', desc: 'Torque and angular velocity. The motor, gearbox, and most solids speak this.' },
  { type: 'linear', shape: 'square', name: 'Linear', desc: 'Force and linear velocity. Only appears after a drum converts rotation into travel.' },
  { type: 'electrical', shape: 'triangle', name: 'Electrical', desc: 'Voltage and current. Runs from the battery to every motor.' },
  { type: 'signal', shape: 'hexagon', name: 'Signal', desc: 'A read-only measurement tap. No cardinality limit — wire it to the plotter or into a controller\u2019s input.' },
  { type: 'control', shape: 'bar', name: 'Control', desc: 'A command written back into the physics. Closes a feedback loop — this is what a controller drives a motor\u2019s duty with.' },
];

const BLOCK_DOCS: { kind: string; name: string; desc: string }[] = [
  { kind: 'battery', name: 'Battery', desc: 'Open-circuit voltage and internal resistance. Everything else\u2019s current draw sags this.' },
  { kind: 'motor', name: 'Motor', desc: 'Pick a model, set a count. Two motors is 2\u00d7 torque at the same speed, not a second block.' },
  { kind: 'gear', name: 'Gearbox', desc: 'Gearbox or belt (rotation in, rotation out), with an option to add a drum so the same block also converts to travel — or a standalone drum for pure conversion with no reduction.' },
  { kind: 'solid', name: 'Solid', desc: 'Mass and inertia, with a gravity mode: none (flywheel), constant (elevator), or angle-dependent (arm). One block, three mechanisms.' },
  { kind: 'pid', name: 'PID', desc: 'Classic proportional-integral-derivative control on a position or velocity channel, plus a constant feedforward.' },
  { kind: 'bangbang', name: 'Bang-bang', desc: 'Full output toward the target, nothing inside a deadband. Cheap and chattery \u2014 no in-between.' },
  { kind: 'lqr', name: 'LQR', desc: 'Full-state regulator. Derives its own plant from the attached chain and solves for gains \u2014 you only set costs, not gains.' },
  { kind: 'plotter', name: 'Plotter', desc: 'Not part of the physics. Drag any hex port here to chart it against time.' },
];

export function Library({ onClose }: { onClose: () => void }) {
  return (
    <div className="lib-overlay" onClick={onClose}>
      <div className="lib-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lib-head">
          <h2 className="railhead" style={{ margin: 0 }}>Library</h2>
          <button className="iconbtn" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <h3 className="railhead">Ports</h3>
        <div className="lib-grid">
          {PORT_DOCS.map((p) => (
            <div className="lib-row" key={p.type}>
              <span className={`port-icon ${p.shape}`} style={{ ['--h' as string]: `var(--${p.type})` }} />
              <div>
                <div className="lib-title">{p.name}</div>
                <div className="lib-desc">{p.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <h3 className="railhead">Blocks</h3>
        <div className="lib-grid">
          {BLOCK_DOCS.map((b) => (
            <div className="lib-row" key={b.kind}>
              <span className="lib-dot" style={{ ['--acc' as string]: KIND_ACCENT[b.kind] ?? 'var(--ink-3)' }} />
              <div>
                <div className="lib-title">{b.name}</div>
                <div className="lib-desc">{b.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
