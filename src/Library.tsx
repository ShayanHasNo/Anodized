import { PortType } from './sim/blocks';
import { KIND_ACCENT } from './canvas/nodes';

const PORT_DOCS: { type: PortType; shape: string; name: string; desc: string }[] = [
  { type: 'rotational', shape: 'circle', name: 'Rotational', desc: 'Torque and angular velocity. The motor, gearbox, and most solids speak this.' },
  { type: 'linear', shape: 'square', name: 'Linear', desc: 'Force and linear velocity. Only appears after a drum converts rotation into travel.' },
  { type: 'electrical', shape: 'triangle', name: 'Electrical', desc: 'Voltage and current. Runs from the battery to every motor.' },
  { type: 'signal', shape: 'hexagon', name: 'Signal', desc: 'A read-only measurement tap. No cardinality limit — wire it to the plotter or into a controller\u2019s input.' },
  { type: 'control', shape: 'bar', name: 'Control', desc: 'A command written back into the physics. Closes a feedback loop — this is what a controller drives a motor\u2019s duty with.' },
  { type: 'mount', shape: 'bigsquare', name: 'Mount', desc: 'Not power, not a measurement — a structural claim about what\u2019s attached to what. Every solid has a tip (out) and a mount (in); a joint block sits between two solids\u2019 tip and mount to link them.' },
];

const BLOCK_DOCS: { kind: string; name: string; desc: string }[] = [
  { kind: 'battery', name: 'Battery', desc: 'Open-circuit voltage and internal resistance. Everything else\u2019s current draw sags this.' },
  { kind: 'motor', name: 'Motor', desc: 'Pick a model, set a count. Two motors is 2\u00d7 torque at the same speed, not a second block.' },
  { kind: 'gear', name: 'Gearbox', desc: 'Gearbox or belt (rotation in, rotation out), with an option to add a drum so the same block also converts to travel — or a standalone drum for pure conversion with no reduction.' },
  { kind: 'solid', name: 'Solid', desc: 'Mass and inertia, with a gravity mode: none (flywheel), constant (elevator), or angle-dependent (arm). One block, three mechanisms.' },
  { kind: 'joint', name: 'Joint', desc: 'Connects two solids into a multi-part mechanism — an arm carrying a wrist. See "Joints" below for how to wire one.' },
  { kind: 'pid', name: 'PID', desc: 'Classic proportional-integral-derivative control on a position or velocity channel, plus a constant feedforward.' },
  { kind: 'bangbang', name: 'Bang-bang', desc: 'Full output toward the target, nothing inside a deadband. Cheap and chattery \u2014 no in-between.' },
  { kind: 'voltage', name: 'Voltage', desc: 'Commands a fixed number of volts at the motor, open loop. Each step it divides that by the live bus voltage to get a duty, so the mechanism holds its voltage as the battery sags \u2014 unlike a raw duty, which quietly weakens under load. Saturates at full duty if you ask for more than the bus can give.' },
  { kind: 'lqr', name: 'LQR', desc: 'Full-state regulator. Derives its own plant from the attached chain and solves for gains \u2014 you only set costs, not gains.' },
  { kind: 'state', name: 'States', desc: 'Named target presets \u2014 \u201cstow\u201d, \u201cL4\u201d \u2014 for every controller on a mechanism at once. Wire a MECHANISM BOX\u2019s hex port into it, not a solid: the box is what holds one complete chain, so the states reach every controller inside it plus everything jointed below it.' },
  { kind: 'plotter', name: 'Plotter', desc: 'Not part of the physics. Drag any hex port here to chart it against time.' },
];

interface JointDoc { title: string; desc: string; }
const JOINT_DOCS: JointDoc[] = [
  {
    title: 'What a joint does',
    desc: 'A joint attaches a second, fully independent mechanism to the first one\u2019s tip. The child keeps its own motor, gearbox, and solid — a joint doesn\u2019t supply torque, it just declares what\u2019s mounted on what, and how.',
  },
  {
    title: 'How to wire one',
    desc: 'Build the child exactly like any other mechanism (its own motor \u2192 gear \u2192 solid). Drag from the parent solid\u2019s tip port to the joint\u2019s parent input, then from the joint\u2019s child output to the child solid\u2019s mount input. Both ends use the large gray mount port — nothing else connects there.',
  },
  {
    title: 'Revolute vs. prismatic',
    desc: 'Revolute means the child pivots — pick this for a wrist, a hood, anything that rotates. It requires the child to be an arm or flywheel-type solid. Prismatic means the child slides — pick this for a telescoping stage. It requires the child to be an elevator-type solid. Wire the wrong pairing and the joint refuses to compile, naming exactly which solid is the problem.',
  },
  {
    title: 'What actually gets coupled',
    desc: 'Two real effects: the child\u2019s weight loads onto the parent (its mass and gravity reflect through the parent\u2019s tip radius or drum radius, same as a mounted load would), and — for revolute joints only — the child\u2019s gravity depends on the parent\u2019s current angle, live, every step. A wrist held level swings differently depending on whether the arm is horizontal or vertical.',
  },
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

        <h3 className="railhead">Canvas shortcuts</h3>
        <div className="lib-grid">
          {[
            ['Delete / Backspace', 'Removes every selected block and any wire touching it. Ignored while you\u2019re typing in a field.'],
            ['Drag on empty canvas', 'Draws a selection box. Anything it touches gets selected.'],
            ['Shift + click', 'Adds or removes a single block from the selection.'],
            ['Middle-drag or right-drag', 'Pans the canvas, since plain dragging now draws a selection box.'],
            ['Ctrl/Cmd + A', 'Selects everything.'],
            ['Ctrl/Cmd + C, then V', 'Copies the selection and pastes it offset, with fresh ids.'],
            ['Ctrl/Cmd + D', 'Duplicates the selection in one step.'],
            ['Escape', 'Clears the selection.'],
          ].map(([k, d]) => (
            <div className="lib-row" key={k}>
              <div>
                <div className="lib-title">{k}</div>
                <div className="lib-desc">{d}</div>
              </div>
            </div>
          ))}
          <div className="lib-row">
            <div>
              <div className="lib-title">What copying carries</div>
              <div className="lib-desc">
                Wires are copied only when both ends are inside the selection.
                Copy a motor, gear, and solid together and the copy is a
                working chain; copy just the gear and it arrives unwired,
                rather than silently re-attaching to the original\u2019s motor and
                giving one motor two chains.
              </div>
            </div>
          </div>
        </div>

        <h3 className="railhead">Joints — tip, mount, and tip radius</h3>
        <div className="lib-grid">
          {JOINT_DOCS.map((j) => (
            <div className="lib-row" key={j.title}>
              <div>
                <div className="lib-title">{j.title}</div>
                <div className="lib-desc">{j.desc}</div>
              </div>
            </div>
          ))}
          <div className="lib-row">
            <div>
              <div className="lib-title">Tip radius</div>
              <div className="lib-desc">
                A field on rotational solids (arm or flywheel type), in the
                inspector under Solid. It\u2019s the distance from this solid\u2019s
                pivot out to where its tip actually is — the point something
                gets mounted. Ordinary solids never need it. It only matters
                once a joint attaches a child here, because it\u2019s what turns
                the child\u2019s mass into a torque and an inertia the parent
                actually feels: a heavier tip radius means the same child mass
                loads the parent harder, exactly like moving a weight further
                out on a lever. Leave it unset and compiling will say which
                solid needs one.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
