/**
 * Display units.
 *
 * The solver always works in SI at the output shaft -- radians and radians per
 * second -- and units exist only at the boundary: what a channel reports, what
 * a setpoint is written in, what a chart axis is labelled. Keeping conversion
 * out of the integration loop means changing a display unit can never change
 * the physics, only how it is read.
 */

export type Dimension = 'angle' | 'angularRate' | 'length' | 'linearRate';

export interface UnitDef {
  id: string;
  label: string;
  dimension: Dimension;
  /** Multiply a value in this unit by toBase to get the SI base unit. */
  toBase: number;
}

const TAU = Math.PI * 2;

export const UNITS: Record<string, UnitDef> = {
  // angle -- base: radian
  rad: { id: 'rad', label: 'rad', dimension: 'angle', toBase: 1 },
  deg: { id: 'deg', label: 'deg', dimension: 'angle', toBase: Math.PI / 180 },
  rot: { id: 'rot', label: 'rot', dimension: 'angle', toBase: TAU },

  // angular rate -- base: rad/s
  'rad/s': { id: 'rad/s', label: 'rad/s', dimension: 'angularRate', toBase: 1 },
  'deg/s': { id: 'deg/s', label: 'deg/s', dimension: 'angularRate', toBase: Math.PI / 180 },
  rpm: { id: 'rpm', label: 'RPM', dimension: 'angularRate', toBase: TAU / 60 },
  'rot/s': { id: 'rot/s', label: 'rot/s', dimension: 'angularRate', toBase: TAU },

  // length -- base: metre
  m: { id: 'm', label: 'm', dimension: 'length', toBase: 1 },
  cm: { id: 'cm', label: 'cm', dimension: 'length', toBase: 0.01 },
  mm: { id: 'mm', label: 'mm', dimension: 'length', toBase: 0.001 },
  in: { id: 'in', label: 'in', dimension: 'length', toBase: 0.0254 },
  ft: { id: 'ft', label: 'ft', dimension: 'length', toBase: 0.3048 },

  // linear rate -- base: m/s
  'm/s': { id: 'm/s', label: 'm/s', dimension: 'linearRate', toBase: 1 },
  'cm/s': { id: 'cm/s', label: 'cm/s', dimension: 'linearRate', toBase: 0.01 },
  'in/s': { id: 'in/s', label: 'in/s', dimension: 'linearRate', toBase: 0.0254 },
  'ft/s': { id: 'ft/s', label: 'ft/s', dimension: 'linearRate', toBase: 0.3048 },
};

export const UNITS_BY_DIMENSION: Record<Dimension, UnitDef[]> = {
  angle: ['deg', 'rad', 'rot'].map((u) => UNITS[u]),
  angularRate: ['deg/s', 'rad/s', 'rpm', 'rot/s'].map((u) => UNITS[u]),
  length: ['m', 'cm', 'mm', 'in', 'ft'].map((u) => UNITS[u]),
  linearRate: ['m/s', 'cm/s', 'in/s', 'ft/s'].map((u) => UNITS[u]),
};

export const DEFAULT_UNIT: Record<Dimension, string> = {
  angle: 'deg', angularRate: 'deg/s', length: 'm', linearRate: 'm/s',
};

/** Dimension of a unit id, or null if it is not a convertible display unit. */
export function dimensionOf(unit: string | undefined): Dimension | null {
  if (!unit) return null;
  return UNITS[unit]?.dimension ?? null;
}

/**
 * Factor that converts a value FROM one unit TO another. Both must share a
 * dimension; mixing them is a programming error, not a user-facing one, so
 * this returns 1 rather than throwing.
 */
export function conversionFactor(from: string, to: string): number {
  const a = UNITS[from], b = UNITS[to];
  if (!a || !b || a.dimension !== b.dimension) return 1;
  return a.toBase / b.toBase;
}

/** Scale that turns an SI base value into the given display unit. */
export function scaleFromBase(unit: string): number {
  const u = UNITS[unit];
  return u ? 1 / u.toBase : 1;
}

export function unitLabel(unit: string | undefined): string {
  return unit ? UNITS[unit]?.label ?? unit : '';
}
