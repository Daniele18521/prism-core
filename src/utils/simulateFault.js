/**
 * SIMULAZIONE ERRORI (solo sviluppo) — per testare retry e failAndConsolidate.
 *
 * Uso nel terminale del worker, PRIMA di avviarlo:
 *
 *   $env:SIMULATE_FAULT="F2"              # PowerShell — errore definitivo in F2
 *   $env:SIMULATE_FAULT_MODE="transient"  # errore temporaneo → BullMQ riprova
 *   node src/worker/processor.js
 *
 * Valori SIMULATE_FAULT: F0 | F1 | F2 | F3 | F4
 * Valori SIMULATE_FAULT_MODE: fatal (default) | transient
 *
 * NON funziona con NODE_ENV=production (sicurezza).
 */

import { AppError } from './errors.js';

const FAULT_TO_STEP = {
  F0: 'content_ingest',
  F1: 'query_shaping',
  F2: 'tavily_search',
  F3: 'refiner',
  F4: 'generation',
};

/**
 * Se SIMULATE_FAULT corrisponde a questo step, lancia un errore finto.
 * @param {string} step - content_ingest | query_shaping | tavily_search | refiner | generation
 */
export const maybeSimulateFault = (step) => {
  const target = process.env.SIMULATE_FAULT?.trim();
  if (!target) return;
  if (process.env.NODE_ENV === 'production') return;

  const mapped = FAULT_TO_STEP[target] || target;
  if (mapped !== step) return;

  const mode = (process.env.SIMULATE_FAULT_MODE || 'fatal').toLowerCase();
  const retryable = mode === 'transient';

  throw new AppError(`[SIMULATED] Errore ${mode} in fase ${step}`, {
    code: 'SIMULATED_FAULT',
    step,
    retryable,
  });
};

/** Log a avvio worker se la simulazione è attiva */
export const logSimulationBanner = () => {
  const target = process.env.SIMULATE_FAULT?.trim();
  if (!target || process.env.NODE_ENV === 'production') return;
  const mode = process.env.SIMULATE_FAULT_MODE || 'fatal';
  console.warn(`🧪 SIMULATE_FAULT attivo: ${target} (${mode}) — solo sviluppo`);
};
