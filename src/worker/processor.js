/**
 * WORKER PRISM — esegue i job accodati dall'API.
 *
 * Due sole azioni supportate:
 * 1) shaping_only (prepare-shaping) → F0→F1→F2→F3, poi consolidamento. NIENTE F4.
 * 2) regen_tone   (regenerate-tone-surgical) → genera/rigenera UN solo tono (F4).
 *
 * Flusso analisi:
 *   API prepare-shaping → Redis + coda → worker F0…F3 → Firestore → DEL Redis
 *
 * Flusso tono:
 *   API regenerate-tone-surgical → coda regen_tone → worker F4 su parentJobId
 *   → salva testo tono → Firestore → risposta con contenutoGenerato
 */

import dotenv from 'dotenv';
import { Worker } from 'bullmq';
// Connessione Redis + ping/chiusura pulita
import redisConnection, { closeRedis, pingRedis } from '../utils/redis.js';
// Errori tipizzati + retry policy + log JSON
import { AppError, isRetryableError, logError } from '../utils/errors.js';
// SIGTERM/SIGINT → chiusura senza troncare il job in corso
import { registerProcessHandlers } from '../utils/processHandlers.js';
// Simula errori di fase in test (SIMULATE_FAULT=F1, F2, …)
import { maybeSimulateFault, logSimulationBanner } from '../utils/simulateFault.js';
import {
  getRedisJob,
  getFirestoreJob,
  patchRedisJob,
  writeShapingToRedis,
  writeContentIngestToRedis,
  writeTavilyToRedis,
  writeRefinerToRedis,
  consolidateToFirestore,
  failAndConsolidate,
  hydrateRedisFromFirestore,
  writeGeneratedTone,
  isTerminalJobStatus,
  normalizePlatform,
  TONE_IDS,
} from '../services/stateManager.js';
// F1: diagnosi GAP + toni ON/OFF (+ normalizza mock come F1 reale)
import { runShaperGatekeeper, normalizeShaperOutput } from '../services/shaper.js';
// F0: estrazione testo da URL (Tavily Extract)
import { resolveInput } from '../services/contentIngest.js';
// F2: ricerche web etichettate
import { performWebSearch } from '../services/search.js';
// F3: pilastri SCENARIO / CONTESTO / SFIDE_OPPORTUNITA
import { refineResults } from '../services/refiner.js';
// F4: generazione di UN tono (solo path regen_tone)
import { generateTones } from '../services/generator.js';
// Verifica companies.enabled_tones + lista toni per F1
import {
  assertToneEnabledForCompany,
  getCompanyEnabledTones,
  resolveEnabledToneIds,
} from '../services/companyAccess.js';
// BYPASS_DATA_CUTTING: TRUE solo se search_required=false (input utente completo)
import { resolveBypassDataCutting } from '../services/promptLoader.js';

dotenv.config();

const QUEUE_NAME = 'prism-jobs'; // stesso nome della coda API
const IS_MOCK = process.env.USE_MOCK_GENERATOR === 'true'; // salta AI esterne in dev

/** Dati finti F0 — testo estratto simulato da un URL (senza Tavily) */
const mockContentIngest = (url) => {
  const sourceUrl = String(url).trim();
  const mockText = [
    'Articolo mock estratto dal sito indicato.',
    'Contiene dati numerici e contesto sufficiente per alimentare Shaper e Refiner.',
    'Questo blocco simula il risultato di Tavily Extract in modalità sviluppo senza consumare crediti API.',
    'Il testo supera la soglia minima di duecento caratteri richiesta dalla fase F0.',
  ].join(' ');
  return {
    inputType: 'url',
    originalInput: sourceUrl,
    topic: mockText,
    sourceMeta: {
      type: 'url',
      url: sourceUrl,
      title: 'Mock Article — PRISM F0',
      charCount: mockText.length,
      truncated: false,
      extractedAt: new Date().toISOString(),
    },
  };
};

/** Dati finti F1 per test locali senza Gemini (include promotore se in catalogo) */
const mockShaper = (topic, enabledTones = TONE_IDS) => {
  const tone_suitability = {};
  for (const id of enabledTones) {
    tone_suitability[id] = { status: 'ON', lock_reason: '' };
  }
  return {
    is_blocked: false,
    block_message: '',
    diagnosi: { scenario: 'GAP', context: 'GAP', sfide_opportunita: 'GAP' },
    search_required: true,
    tone_suitability,
    plan: [
      { pillar: 'SCENARIO', query: `statistiche ${topic} ${new Date().getFullYear()}` },
      { pillar: 'CONTESTO', query: `trend ${topic} ${new Date().getFullYear() - 1}` },
      { pillar: 'SFIDE_OPPORTUNITA', query: `criticità ${topic} ${new Date().getFullYear()}` },
    ],
  };
};

/** Dati finti F2 — una fonte web simulata */
const mockTavily = () => ({
  rawResults: [{
    title: 'Mock Source',
    url: 'https://example.com',
    content: 'Contenuto mock.',
    retrievedAt: new Date().toISOString(),
    pillar: 'SCENARIO',
  }],
});

/** Dati finti F3 — tre blocchi pilastro simulati */
const mockRefiner = () => ({
  compressedFacts: [
    'SCENARIO: Dati mock +15%.',
    'CONTESTO: Trend in crescita.',
    'SFIDE_OPPORTUNITA: Ostacoli normativi e leve di digitalizzazione.',
  ],
  sourcesPreview: [{ title: 'Mock Source', url: 'https://example.com' }],
  isContextRelevant: true,
  tables: [],
});

/**
 * True se F0 è già fatta.
 * Input testo libero → F0 non esiste → sempre true.
 */
const isContentIngestDone = (job) => {
  if (job?.inputType !== 'url') return true;
  return Boolean(job.contentIngest?.updatedAt);
};

/**
 * True se F1 (Shaper) è già stato eseguito.
 * Non basta plan.length: con search_required=false il plan è vuoto ma lo shaping c'è.
 */
const isShapingDone = (shaping) =>
  Boolean(shaping?.updatedAt || shaping?.diagnosi || shaping?.is_blocked);

/**
 * Se il job è già completed/failed/blocked su Firestore, non rifare lavoro.
 * Succede se BullMQ riprova un job già consolidato.
 */
const skipIfTerminal = async (targetJobId) => {
  const fsJob = await getFirestoreJob(targetJobId);
  if (fsJob && isTerminalJobStatus(fsJob.status)) {
    console.log(`⏭️ [WORKER][${targetJobId}] Già terminale (${fsJob.status}), skip.`);
    return true;
  }
  return false;
};

/**
 * Pipeline di analisi F0→F3 (prepare-shaping).
 * Termina SEMPRE dopo F3: nessun F4 qui.
 */
const runAnalysisPipeline = async ({ uid, targetJobId, topic }) => {
  // --- Carica stato Redis (creato dall'API) ---
  let state = await getRedisJob(uid, targetJobId);
  if (!state) {
    throw new AppError(
      `Job Redis ${targetJobId} non trovato. Deve essere creato dall'API prepare-shaping.`,
      { step: 'query_shaping', retryable: true },
    );
  }

  // Status iniziale: ingesting se URL da processare, altrimenti running
  await patchRedisJob(uid, targetJobId, {
    status: state.inputType === 'url' && !isContentIngestDone(state) ? 'ingesting' : 'running',
  });

  // -------------------------------------------------------------------------
  // F0 — CONTENT INGEST (solo se l'input è un URL)
  // -------------------------------------------------------------------------
  if (!isContentIngestDone(state)) {
    console.log(`📄 [WORKER][${targetJobId}] F0 Content Ingest (URL)...`);
    maybeSimulateFault('content_ingest');

    await patchRedisJob(uid, targetJobId, {
      status: 'ingesting',
      workerState: {
        currentStep: 'content_ingest',
        progress: 0.05,
        updatedAt: new Date().toISOString(),
      },
    });

    const sourceUrl = state.originalInput || topic;
    const ingestOut = IS_MOCK
      ? mockContentIngest(sourceUrl)
      : await resolveInput(sourceUrl);

    state = await writeContentIngestToRedis(uid, targetJobId, ingestOut);
    console.log(
      `✅ [WORKER][${targetJobId}] F0 completata (${ingestOut.sourceMeta?.charCount || 0} caratteri).`,
    );
  }

  // -------------------------------------------------------------------------
  // F1 — SHAPER & GATEKEEPER (diagnosi GAP + toni ON/OFF)
  // -------------------------------------------------------------------------
  if (!isShapingDone(state.shaping)) {
    console.log(`🧠 [WORKER][${targetJobId}] F1 Shaper...`);
    maybeSimulateFault('query_shaping');

    // Toni da valutare = companies.enabled_tones (dinamico per company)
    const companyId = state.companyId;
    let enabledTones = TONE_IDS;
    if (companyId) {
      const rawEnabled = await getCompanyEnabledTones(companyId);
      const resolved = resolveEnabledToneIds(rawEnabled);
      if (resolved.length > 0) enabledTones = resolved;
      else {
        console.warn(
          `⚠️ [WORKER][${targetJobId}] enabled_tones vuoto/non valido → fallback catalogo completo.`,
        );
      }
    }

    const shaperTopic = state.topic || topic;
    const shaperRaw = IS_MOCK
      ? mockShaper(shaperTopic, enabledTones)
      : await runShaperGatekeeper(shaperTopic, { enabledTones });
    // Mock: applica stesso gatekeeper/filtro company della F1 reale
    const shaperOut = IS_MOCK
      ? normalizeShaperOutput(shaperRaw, shaperTopic, { enabledTones })
      : shaperRaw;
    state = await writeShapingToRedis(uid, targetJobId, shaperOut);

    // Input non ammesso → blocked e stop (niente F2/F3)
    if (shaperOut.is_blocked) {
      await patchRedisJob(uid, targetJobId, {
        status: 'blocked',
        error: { message: shaperOut.block_message, step: 'query_shaping' },
      });
      await consolidateToFirestore(uid, targetJobId, 'blocked');
      console.log(`[WORKER][${targetJobId}] Input bloccato dal Gatekeeper.`);
      return;
    }
  }

  state = await getRedisJob(uid, targetJobId);
  // false = tutti i pilastri OK → salta le ricerche web
  const searchRequired = state.shaping?.search_required !== false;
  const plan = state.shaping?.plan || [];

  // -------------------------------------------------------------------------
  // F2 — TAVILY SEARCH (solo se serve)
  // -------------------------------------------------------------------------
  if (searchRequired && !state.tavily?.rawResults?.length) {
    console.log(`🌐 [WORKER][${targetJobId}] F2 Search...`);
    maybeSimulateFault('tavily_search');

    const { rawResults } = IS_MOCK ? mockTavily() : await performWebSearch(plan);
    state = await writeTavilyToRedis(uid, targetJobId, rawResults);
  } else if (!searchRequired) {
    console.log(`⏭️ [WORKER][${targetJobId}] F2 saltata (search_required=false).`);
    await patchRedisJob(uid, targetJobId, {
      tavily: { rawResults: [] },
      workerState: {
        currentStep: 'tavily_search',
        progress: 0.5,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // F3 — REFINER (3 pilastri editoriali)
  // -------------------------------------------------------------------------
  state = await getRedisJob(uid, targetJobId);
  if (!state.refiner?.compressedFacts?.length) {
    console.log(`💎 [WORKER][${targetJobId}] F3 Refiner...`);
    maybeSimulateFault('refiner');

    const refinerOut = IS_MOCK
      ? mockRefiner()
      : await refineResults(state.topic || topic, {
        diagnosi: state.shaping?.diagnosi,
        rawResults: state.tavily?.rawResults || [],
        searchRequired,
      });

    state = await writeRefinerToRedis(uid, targetJobId, refinerOut);
  }

  // -------------------------------------------------------------------------
  // FINE ANALISI — nessun F4: i testi tono arrivano solo da regen_tone
  // -------------------------------------------------------------------------
  await patchRedisJob(uid, targetJobId, {
    status: 'completed',
    workerState: {
      currentStep: 'done',
      progress: 1.0,
      updatedAt: new Date().toISOString(),
    },
  });
  await consolidateToFirestore(uid, targetJobId, 'completed');
  console.log(
    `[WORKER][${targetJobId}] Analisi F0→F3 completata. Consolidato su Firestore (niente F4).`,
  );
};

/**
 * Generazione / rigenerazione di UN solo tono (regenerate-tone-surgical).
 * Usa i pilastri già prodotti da prepare-shaping.
 */
const runToneGeneration = async ({
  uid,
  targetJobId,
  companyId,
  toneKey,
  topic,
  platform,
  language,
  maxChars,
  instructions,
  previousContent,
}) => {
  // Company abilitata a questo tono?
  await assertToneEnabledForCompany(companyId, toneKey);

  // Job padre: Redis oppure idratazione da Firestore
  let state = await getRedisJob(uid, targetJobId);
  if (!state) state = await hydrateRedisFromFirestore(uid, targetJobId);
  if (!state) {
    throw new AppError(`Job ${targetJobId} non trovato.`, {
      step: 'generation',
      retryable: false,
    });
  }

  // Tono deve esistere ed essere ON (decisione Shaper + gatekeeper)
  const tone = state.tones?.[toneKey];
  if (!tone || tone.status !== 'ON') {
    throw new AppError(`Tono ${toneKey} non idoneo (status OFF o assente).`, {
      step: 'generation',
      retryable: false,
    });
  }

  await patchRedisJob(uid, targetJobId, {
    status: 'generating',
    workerState: {
      currentStep: 'generation',
      progress: 0.5,
      updatedAt: new Date().toISOString(),
    },
  });

  const refiner = state.refiner || {};
  // TRUE se search_required=false (dati utente completi → non tagliare in Desire)
  const bypassDataCutting = resolveBypassDataCutting(state.shaping);
  // Baseline strutturale: request o testo già presente
  const prevContent =
    String(previousContent || '').trim() || String(tone.text || '').trim();

  // Una sola chiamata Gemini per questo tono
  const output = await generateTones(
    {
      topic: topic || state.topic,
      platform: normalizePlatform(platform || state.platform),
      language: language || state.language,
      maxChars,
      toneKey,
      instructions: instructions || '',
      previousContent: prevContent,
      bypassDataCutting,
      shaping: state.shaping,
    },
    refiner.compressedFacts || [],
  );

  const newText = output?.text;
  if (!newText) {
    throw new AppError(`Generazione fallita per tono: ${toneKey}`, {
      step: 'generation',
      retryable: true,
    });
  }

  // Salva testo + bump versione sul job padre
  await writeGeneratedTone(uid, targetJobId, toneKey, newText, { instructions });
  await patchRedisJob(uid, targetJobId, {
    status: 'completed',
    workerState: {
      currentStep: 'done',
      progress: 1.0,
      updatedAt: new Date().toISOString(),
    },
  });
  await consolidateToFirestore(uid, targetJobId, 'completed');
  console.log(`[WORKER][${targetJobId}] Tono ${toneKey} generato e consolidato.`);

  // Valore letto da waitUntilFinished nell'API
  return { text: newText, contenutoGenerato: newText, toneKey };
};

// Worker BullMQ: un job alla volta (concurrency: 1)
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    // Payload messo in coda dall'API
    const {
      userId,
      companyId,
      topic,
      platform,
      language,
      maxChars,
      toneKey,
      action,
      parentJobId,
      instructions,
      previousContent,
    } = job.data;

    const jobId = job.id;
    // regen_tone aggiorna il job di analisi (parent); shaping_only usa il proprio id
    const targetJobId = action === 'regen_tone' ? parentJobId : jobId;
    const uid = userId;

    console.log(
      `🚀 [WORKER][${targetJobId}] Azione: ${action} (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1})`,
    );

    // Già chiuso su Firestore → esci
    if (await skipIfTerminal(targetJobId)) return;

    let state = null;

    try {
      // --- Solo generazione tono ---
      if (action === 'regen_tone') {
        if (!toneKey) {
          throw new AppError('toneKey obbligatorio per regen_tone.', {
            step: 'generation',
            retryable: false,
          });
        }
        return await runToneGeneration({
          uid,
          targetJobId,
          companyId,
          toneKey,
          topic,
          platform,
          language,
          maxChars,
          instructions,
          previousContent,
        });
      }

      // --- Solo analisi F0→F3 (prepare-shaping) ---
      if (action === 'shaping_only') {
        await runAnalysisPipeline({ uid, targetJobId, topic });
        return;
      }

      // Qualsiasi altra action non è più supportata
      throw new AppError(
        `Azione non supportata: ${action || '(vuota)'}. Usa shaping_only o regen_tone.`,
        { step: 'unknown', retryable: false },
      );
    } catch (err) {
      const step = err?.step || state?.workerState?.currentStep || 'unknown';
      logError(`WORKER:${targetJobId}`, err, {
        step,
        attempt: job.attemptsMade + 1,
      });

      // Regen fallita: non marcare il job padre come failed (resta completed)
      if (action === 'regen_tone') {
        try {
          await patchRedisJob(uid, targetJobId, {
            status: 'completed',
            workerState: {
              currentStep: 'done',
              progress: 1.0,
              lastError: err.message,
              updatedAt: new Date().toISOString(),
            },
          });
        } catch (patchErr) {
          logError(`WORKER:${targetJobId}:regenRestore`, patchErr);
        }
        // Rilancia → BullMQ failed → API waitUntilFinished riceve l'errore
        throw err;
      }

      const maxAttempts = job.opts?.attempts ?? 1;
      const canRetry =
        isRetryableError(err) && job.attemptsMade < maxAttempts - 1;

      if (canRetry) {
        // Aggiorna Redis per il polling UI (stiamo riprovando)
        try {
          const current = await getRedisJob(uid, targetJobId);
          if (current) {
            await patchRedisJob(uid, targetJobId, {
              workerState: {
                retryCount: job.attemptsMade + 1,
                lastError: err.message,
                currentStep: step,
                updatedAt: new Date().toISOString(),
              },
            });
          }
        } catch (patchErr) {
          logError(`WORKER:${targetJobId}:retryPatch`, patchErr);
        }
        throw err; // BullMQ ritenta
      }

      // Errore definitivo sull'analisi → failed su Firestore
      const { persisted } = await failAndConsolidate(
        uid,
        targetJobId,
        err.message,
        step,
        'failed',
      );
      if (!persisted) throw err;
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

// Log eventi coda (produzione)
worker.on('failed', (job, err) => {
  logError('WORKER:queue:failed', err, {
    jobId: job?.id,
    attemptsMade: job?.attemptsMade,
    failedReason: job?.failedReason,
  });
});

worker.on('error', (err) => {
  logError('WORKER:queue:error', err);
});

worker.on('stalled', (jobId) => {
  console.warn(`⚠️ [WORKER] Job stalled: ${jobId}`);
});

// Chiusura pulita su deploy / Ctrl+C
registerProcessHandlers({
  label: 'worker',
  onShutdown: async () => {
    await worker.close();
    await closeRedis();
  },
});

logSimulationBanner();

pingRedis()
  .then(() =>
    console.log('🚀 Worker PRISM operativo (shaping_only F0→F3 | regen_tone F4).'),
  )
  .catch((err) => {
    logError('worker:startup', err);
    console.warn('⚠️ Worker avviato ma Redis non raggiungibile — in attesa di riconnessione.');
  });
