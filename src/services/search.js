/**
 * RICERCA WEB (F2) — usa Tavily per cercare informazioni su internet.
 *
 * Il plan arriva dallo Shaper: lista di query tipo
 * [{ pillar: 'SCENARIO', query: 'trend AI 2026' }, ...]
 */

import dotenv from 'dotenv';
import { AppError } from '../utils/errors.js';
// Client Tavily condiviso con F0 (Extract) — una sola gestione API key
import { getTavilyClient } from '../utils/tavilyClient.js';

dotenv.config();

/** Esegue una singola ricerca su Tavily */
const searchQuery = async (tvly, query) => {
  return tvly.search(query, {
    searchDepth: 'advanced', // ricerca più approfondita
    maxResults: 3, // massimo 3 risultati per query
    includeAnswer: false,
    includeImages: false,
    includeRawContent: false,
  });
};

/**
 * Esegue tutte le query del plan e restituisce le fonti trovate.
 * Ogni fonte ha un ID (S1, S2...) usato dal Refiner per le citazioni [S1].
 */
export const performWebSearch = async (plan, options = {}) => {
  // Mock nei test inietta il client; in produzione usiamo step tavily_search per gli errori
  const resolveClient = options.getTavilyClient ?? (() => getTavilyClient({ step: 'tavily_search' }));
  console.log('🌐 F2: Ricerca etichettata Tavily...');

  const entries = Array.isArray(plan) ? plan : [];
  const queries = entries.map((p) => (typeof p === 'string' ? p : p.query)).filter(Boolean);

  if (queries.length === 0) {
    return { rawResults: [] }; // nessuna query = nessuna ricerca
  }

  const tvly = resolveClient();
  const retrievedAt = new Date().toISOString();
  const failures = []; // query che non hanno funzionato

  /**
   * Promise.allSettled = lancia TUTTE le ricerche in parallelo.
   * A differenza di Promise.all, se UNA fallisce le altre continuano.
   * Così 2 query su 3 possono comunque dare risultati utili.
   */
  const settled = await Promise.allSettled(
    entries.map((entry, idx) => searchQuery(tvly, entry.query || queries[idx]))
  );

  let sourceCounter = 1; // numerazione globale S1, S2, S3...
  const rawResults = [];

  for (let idx = 0; idx < settled.length; idx++) {
    const outcome = settled[idx];
    const entry = entries[idx];

    if (outcome.status === 'rejected') {
      // Questa query specifica è fallita, le altre possono andare avanti
      failures.push({ pillar: entry?.pillar, query: entry?.query, reason: outcome.reason?.message });
      console.warn(`⚠️ F2: query fallita [${entry?.pillar}]: ${outcome.reason?.message}`);
      continue;
    }

    // Trasforma ogni risultato Tavily nel formato che usa il Refiner
    for (const source of outcome.value.results || []) {
      rawResults.push({
        sourceId: `S${sourceCounter++}`,
        title: source.title || '',
        url: source.url || '',
        content: source.content ? source.content.substring(0, 4000) : '', // taglia testi lunghissimi
        retrievedAt,
        pillar: entry?.pillar || '',
      });
    }
  }

  // Se TUTTE le query falliscono, non possiamo continuare → errore retryable
  if (rawResults.length === 0) {
    throw new AppError('Tutte le ricerche Tavily sono fallite.', {
      code: 'TAVILY_ALL_FAILED',
      retryable: true,
      step: 'tavily_search',
      cause: failures,
    });
  }

  if (failures.length) {
    console.warn(`⚠️ F2: ${failures.length}/${entries.length} query fallite — proseguo con risultati parziali.`);
  }

  console.log(`✅ F2 completata: ${rawResults.length} fonti.`);
  return { rawResults, partialFailures: failures };
};
