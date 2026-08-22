/**
 * Turning a wired condition tree into Java.
 *
 * Shared by both codegen targets, because a condition means the same thing in
 * either framework -- only what it is ATTACHED to differs. Classic checks it in
 * `periodic()`; commands v3 hands it to `.when(...)` as a `BooleanSupplier`.
 * The expression itself is identical, so it is written once.
 *
 * TWO KINDS OF SENSOR, TWO KINDS OF OUTPUT:
 *
 * An encoder block is a COMPARISON. It reads state the mechanism already
 * reports, so it generates `elevator.getPositionMeters() >= 0.5` and no
 * hardware. Nothing new appears on the robot.
 *
 * A limit switch is an OBJECT. It is a real thing bolted where the mechanism
 * travels past, so it generates a `DigitalInput` with a TODO for its channel.
 * The simulator modelled it as a position threshold, and that threshold is
 * preserved in a comment -- it is what the switch's mounting position needs to
 * be, which is genuinely useful information that would otherwise be lost.
 *
 * Emitting a position comparison for a limit switch would be the tempting
 * shortcut, and it would be wrong: the code would silently not use the switch
 * that is physically on the robot, and would keep working in a way that hid
 * a disconnected or failed switch.
 */

import type { ConditionNode } from '../sim/compile';
import type { SubsystemPlan } from './java';
import { camel, num } from './java';

/** Java identifier for a programming block, derived from its label. */
export function condIdent(node: { blockId: string; label: string }): string {
  const words = node.label.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const joined = words.map((w, i) =>
    i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)).join('');
  const safe = /^[0-9]/.test(joined) ? `c${joined}` : joined;
  return safe || camel(node.blockId);
}

export interface ConditionContext {
  /** Which mechanism reports a given solid, and how to ask it. */
  plans: SubsystemPlan[];
}

/** The plan that reports a solid, whether it owns it or carries it passively. */
function planForSolid(ctx: ConditionContext, solidId: string): SubsystemPlan | undefined {
  return ctx.plans.find((p) => p.mech.solid.id === solidId)
    ?? ctx.plans.find((p) => p.mech.passiveChildren.some((c) => c.id === solidId));
}

/** Every limit switch in a tree, which become DigitalInput fields. */
export function collectSwitches(node: ConditionNode, out: ConditionNode[] = []): ConditionNode[] {
  if (node.kind === 'sensor' && node.physical) out.push(node);
  else if (node.kind === 'and' || node.kind === 'or') {
    collectSwitches(node.a, out); collectSwitches(node.b, out);
  } else if (node.kind === 'not' || node.kind === 'latch') collectSwitches(node.a, out);
  return out;
}

/** Every trigger in a tree, which become settable boolean fields. */
export function collectTriggers(node: ConditionNode, out: ConditionNode[] = []): ConditionNode[] {
  if (node.kind === 'trigger') out.push(node);
  else if (node.kind === 'and' || node.kind === 'or') {
    collectTriggers(node.a, out); collectTriggers(node.b, out);
  } else if (node.kind === 'not' || node.kind === 'latch') collectTriggers(node.a, out);
  return out;
}

/** Every latch in a tree, which become sticky boolean fields. */
export function collectLatches(node: ConditionNode, out: ConditionNode[] = []): ConditionNode[] {
  if (node.kind === 'latch') { out.push(node); collectLatches(node.a, out); }
  else if (node.kind === 'and' || node.kind === 'or') {
    collectLatches(node.a, out); collectLatches(node.b, out);
  } else if (node.kind === 'not') collectLatches(node.a, out);
  return out;
}

/**
 * The Java expression for a condition.
 *
 * Parenthesised at every combinator rather than tracking precedence: `&&`
 * binds tighter than `||` in Java, so an unparenthesised mix would silently
 * change meaning relative to the graph the person drew. Redundant brackets are
 * a much smaller cost than a wrong answer.
 */
export function conditionExpr(node: ConditionNode, ctx: ConditionContext): string {
  switch (node.kind) {
    case 'sensor': {
      if (node.physical) return `${condIdent(node)}.get()`;
      const plan = planForSolid(ctx, node.solidId);
      if (!plan) return `false /* ${node.solidId} is not in the export */`;
      const getter = node.signal === 'velocity'
        ? `get${plan.velSuffix ? `Velocity${plan.velSuffix}` : 'Velocity'}()`
        : `get${plan.posSuffix ? `Position${plan.posSuffix}` : 'Position'}()`;
      const op = node.direction === 'above' ? '>=' : '<=';
      return `${camel(plan.className)}.${getter} ${op} ${num(node.threshold, 4)}`;
    }
    case 'trigger':
      return condIdent(node);
    case 'and':
      return `(${conditionExpr(node.a, ctx)} && ${conditionExpr(node.b, ctx)})`;
    case 'or':
      return `(${conditionExpr(node.a, ctx)} || ${conditionExpr(node.b, ctx)})`;
    case 'not':
      return `!(${conditionExpr(node.a, ctx)})`;
    case 'latch':
      // The latch's own sticky field, updated once per loop in updateLatches().
      return condIdent(node);
  }
}

/** Field declarations for the hardware and state a condition tree needs. */
export function conditionFields(
  roots: ConditionNode[], ctx: ConditionContext,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const root of roots) {
    for (const sw of collectSwitches(root)) {
      if (seen.has(sw.blockId)) continue;
      seen.add(sw.blockId);
      const plan = planForSolid(ctx, sw.kind === 'sensor' ? sw.solidId : '');
      lines.push(
        `  /**\n`
        + `   * ${sw.label}.\n`
        + `   *\n`
        + `   * A real switch, so it reads a DIO channel rather than comparing a\n`
        + `   * position. Anodized modelled it tripping at ${num(sw.kind === 'sensor' ? sw.threshold : 0, 3)} ${sw.kind === 'sensor' ? sw.unit : ''}`
        + `${plan ? ` of ${camel(plan.className)}` : ''},\n`
        + `   * which is where it needs to be mounted for the logic to match.\n`
        + `   */\n`
        + `  // TODO: replace this — set the real DIO channel.\n`
        + `  private final DigitalInput ${condIdent(sw)} = new DigitalInput(0);`,
      );
    }
    for (const tr of collectTriggers(root)) {
      if (seen.has(tr.blockId)) continue;
      seen.add(tr.blockId);
      lines.push(
        `  /**\n`
        + `   * ${tr.label} — a manual trigger in the simulator.\n`
        + `   *\n`
        + `   * Stands in for something the simulator cannot model: an operator\n`
        + `   * button, a beam break with a game piece in it, a vision target.\n`
        + `   * Shaped like a sensor so swapping in the real source is a one-line\n`
        + `   * change to the setter.\n`
        + `   */\n`
        + `  // TODO: replace this — drive it from the real input.\n`
        + `  private boolean ${condIdent(tr)} = ${tr.kind === 'trigger' && tr.initial};`,
      );
    }
    for (const la of collectLatches(root)) {
      if (seen.has(la.blockId)) continue;
      seen.add(la.blockId);
      lines.push(
        `  /**\n`
        + `   * ${la.label} — latches true and stays true.\n`
        + `   *\n`
        + `   * "It happened at some point", not "it is happening now". A\n`
        + `   * mechanism that passes its trigger point and keeps going would\n`
        + `   * otherwise un-fire whatever was waiting on it.\n`
        + `   */\n`
        + `  private boolean ${condIdent(la)} = false;`,
      );
    }
  }
  return lines.join('\n\n');
}

/** Setters for every manual trigger, so real inputs can drive them. */
export function triggerSetters(roots: ConditionNode[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    for (const tr of collectTriggers(root)) {
      if (seen.has(tr.blockId)) continue;
      seen.add(tr.blockId);
      out.push(
        `  /** Sets ${tr.label}. */\n`
        + `  public void set${condIdent(tr)[0].toUpperCase()}${condIdent(tr).slice(1)}(boolean value) {\n`
        + `    this.${condIdent(tr)} = value;\n`
        + `  }`,
      );
    }
  }
  return out.join('\n\n');
}

/** The body that refreshes every latch, called once per loop. */
export function latchUpdates(roots: ConditionNode[], ctx: ConditionContext): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    for (const la of collectLatches(root)) {
      if (seen.has(la.blockId) || la.kind !== 'latch') continue;
      seen.add(la.blockId);
      out.push(
        `    if (!${condIdent(la)} && (${conditionExpr(la.a, ctx)})) {\n`
        + `      ${condIdent(la)} = true;\n`
        + `    }`,
      );
    }
  }
  return out.join('\n');
}

/** True when any condition in the set needs a DigitalInput import. */
export function needsDigitalInput(roots: ConditionNode[]): boolean {
  return roots.some((r) => collectSwitches(r).length > 0);
}
