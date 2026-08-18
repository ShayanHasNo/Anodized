/**
 * Motor catalog and derived electrical constants.
 *
 * Datasheet values are per-motor at nominal 12 V. Rotor inertias are
 * manufacturer figures where published and estimates otherwise -- they only
 * matter for high-ratio, low-load mechanisms, but that is exactly where they
 * dominate, so they are flagged.
 */

export interface MotorSpec {
  id: string;
  name: string;
  vNom: number;        // V
  freeSpeedRpm: number;
  stallTorque: number; // N-m
  stallCurrent: number; // A
  freeCurrent: number; // A
  rotorInertia: number; // kg-m^2
  rotorInertiaIsEstimate: boolean;
}

const RPM_TO_RAD_S = (2 * Math.PI) / 60;

export const MOTORS: Record<string, MotorSpec> = {
  krakenX60: {
    id: 'krakenX60', name: 'Kraken X60',
    vNom: 12, freeSpeedRpm: 6000, stallTorque: 7.09, stallCurrent: 366,
    freeCurrent: 2.0, rotorInertia: 6.0e-5, rotorInertiaIsEstimate: true,
  },
  krakenX60Foc: {
    id: 'krakenX60Foc', name: 'Kraken X60 (FOC)',
    vNom: 12, freeSpeedRpm: 5800, stallTorque: 9.37, stallCurrent: 483,
    freeCurrent: 2.0, rotorInertia: 6.0e-5, rotorInertiaIsEstimate: true,
  },
  falcon500: {
    id: 'falcon500', name: 'Falcon 500',
    vNom: 12, freeSpeedRpm: 6380, stallTorque: 4.69, stallCurrent: 257,
    freeCurrent: 1.5, rotorInertia: 5.6e-5, rotorInertiaIsEstimate: true,
  },
  neoVortex: {
    id: 'neoVortex', name: 'NEO Vortex',
    vNom: 12, freeSpeedRpm: 6784, stallTorque: 3.60, stallCurrent: 211,
    freeCurrent: 3.6, rotorInertia: 3.3e-5, rotorInertiaIsEstimate: true,
  },
  neo: {
    id: 'neo', name: 'NEO (v1.1)',
    vNom: 12, freeSpeedRpm: 5676, stallTorque: 2.60, stallCurrent: 105,
    freeCurrent: 1.8, rotorInertia: 3.2e-5, rotorInertiaIsEstimate: true,
  },
  neo550: {
    id: 'neo550', name: 'NEO 550',
    vNom: 12, freeSpeedRpm: 11000, stallTorque: 0.97, stallCurrent: 100,
    freeCurrent: 1.4, rotorInertia: 4.3e-6, rotorInertiaIsEstimate: true,
  },
  cim: {
    id: 'cim', name: 'CIM',
    vNom: 12, freeSpeedRpm: 5330, stallTorque: 2.41, stallCurrent: 131,
    freeCurrent: 2.7, rotorInertia: 9.8e-5, rotorInertiaIsEstimate: true,
  },
  miniCim: {
    id: 'miniCim', name: 'MiniCIM',
    vNom: 12, freeSpeedRpm: 5840, stallTorque: 1.41, stallCurrent: 89,
    freeCurrent: 3.0, rotorInertia: 4.7e-5, rotorInertiaIsEstimate: true,
  },
  redline775: {
    id: 'redline775', name: '775pro',
    vNom: 12, freeSpeedRpm: 18730, stallTorque: 0.71, stallCurrent: 134,
    freeCurrent: 0.7, rotorInertia: 1.3e-5, rotorInertiaIsEstimate: true,
  },
};

/** Electrical constants derived from datasheet values. Computed once per block. */
export interface MotorConstants {
  spec: MotorSpec;
  R: number;         // winding resistance, ohms
  Kt: number;        // N-m per amp
  Kv: number;        // rad/s per volt
  Ke: number;        // V per rad/s (back-EMF constant, = 1/Kv)
  freeSpeed: number; // rad/s
}

export function deriveConstants(spec: MotorSpec): MotorConstants {
  const R = spec.vNom / spec.stallCurrent;
  const Kt = spec.stallTorque / spec.stallCurrent;
  const freeSpeed = spec.freeSpeedRpm * RPM_TO_RAD_S;
  const Kv = freeSpeed / (spec.vNom - spec.freeCurrent * R);
  return { spec, R, Kt, Kv, Ke: 1 / Kv, freeSpeed };
}

export function getMotor(id: string): MotorConstants {
  const spec = MOTORS[id];
  if (!spec) throw new Error(`Unknown motor id: ${id}`);
  return deriveConstants(spec);
}
