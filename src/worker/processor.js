/**
 * WORKER — il "cuore" che esegue i job accodati dall'API.
 *
 * Flusso di un job:
 * 1. L'API crea il job in Redis e lo mette in coda (BullMQ)
 * 2. Questo worker preleva il job dalla coda
 * 3. Esegue F0 (Content Ingest, solo URL) → F1 (Shaper) → F2 (Search) → F3 (Refiner) → F4 (Generation)
 * 4. Alla fine salva tutto su Firestore e cancella da Redis
 *
 * Miglioramenti produzione in questo file:
 * - Errori temporanei (rete) → riprova automaticamente
 * - Errori definitivi → salva failed su Firestore, NON riprova
 * - Job già completati → skip (evita lavoro doppio)
 * - Ctrl+C / deploy → chiusura pulita senza lasciare connessioni aperte
 */

import dotenv from 'dotenv';
import { Worker } from 'bullmq';
// Connessione Redis + funzioni per ping e chiusura pulita
import redisConnection, { closeRedis, pingRedis } from '../utils/redis.js';
// AppError = errori con etichetta; isRetryableError = posso riprovare?; logError = log JSON
import { AppError, isRetryableError, logError } from '../utils/errors.js';
// Intercetta SIGTERM/SIGINT per chiudere il worker senza troncare i job
import { registerProcessHandlers } from '../utils/processHandlers.js';
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
  TONE_IDS,
  normalizePlatform,
} from '../services/stateManager.js';
import { runShaperGatekeeper } from '../services/shaper.js';
// F0: estrazione testo da URL (Tavily Extract) — attivo solo se inputType === 'url'
import { resolveInput } from '../services/contentIngest.js';
import { performWebSearch } from '../services/search.js';
import { refineResults } from '../services/refiner.js';
import { generateTones } from '../services/generator.js';

dotenv.config();

const QUEUE_NAME = 'prism-jobs'; // stesso nome usato dall'API quando accoda
const IS_MOCK = process.env.USE_MOCK_GENERATOR === 'true'; // true = salta chiamate AI reali

/** Dati finti F0 — testo estratto simulato da un URL (senza chiamata Tavily) */
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

/** Dati finti F1 per test locali senza Gemini */
const mockShaper = (topic) => ({
  is_blocked: false,
  block_message: '',
  diagnosi: { scenario: 'GAP', context: 'GAP', sfide_opportunita: 'GAP' },
  search_required: true,
  tone_suitability: {
    provocatore: { status: 'ON', lock_reason: '' },
    confidente: { status: 'OFF', lock_reason: 'Perchè non voglio che produca testi confidenziali.' },
    sferzante: { status: 'ON', lock_reason: '' },
    visionario: { status: 'OFF', lock_reason: 'Perchè non voglio che produca testi visionari.' },
    metodologico: { status: 'ON', lock_reason: '' },
    narratore: { status: 'ON', lock_reason: '' },
  },
  plan: [
    { pillar: 'SCENARIO', query: `statistiche ${topic} ${new Date().getFullYear()}` },
    { pillar: 'CONTESTO', query: `trend ${topic} ${new Date().getFullYear() - 1}` },
    { pillar: 'SFIDE_OPPORTUNITA', query: `criticità ${topic} ${new Date().getFullYear()}` },
  ],
});

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
 * Controlla se F0 (estrazione URL) è già stata completata.
 * Per input testo libero F0 non esiste → considerato sempre fatto.
 */
const isContentIngestDone = (job) => {
  if (job?.inputType !== 'url') return true;
  return Boolean(job.contentIngest?.updatedAt);
};

/**
 * Controlla se F1 (Shaper) è già stato eseguito.
 * Prima controllavamo solo plan.length: con search_required=false il plan è vuoto
 * ma lo shaping c'è → F1 partiva di nuovo per errore.
 */
const isShapingDone = (shaping) => Boolean(shaping?.updatedAt || shaping?.diagnosi || shaping?.is_blocked);

/**
 * Se il job è già su Firestore come completed/failed/blocked, non rifare nulla.
 * Può succedere se BullMQ riprova un job già consolidato.
 */
const skipIfTerminal = async (targetJobId) => {
  const fsJob = await getFirestoreJob(targetJobId);
  if (fsJob && isTerminalJobStatus(fsJob.status)) {
    console.log(`⏭️ [WORKER][${targetJobId}] Già terminale (${fsJob.status}), skip.`);
    return true;
  }
  return false;
};

// Crea il worker BullMQ: preleva job dalla coda e esegue la funzione sotto
const worker = new Worker(QUEUE_NAME, async (job) => {
  // Dati passati dall'API quando ha accodato il job
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
  } = job.data;

  const jobId = job.id; // ID del job in coda (può differire da targetJobId in regen_tone)
  const targetJobId = action === 'regen_tone' ? parentJobId : jobId; // job "vero" da aggiornare
  const uid = userId;

  console.log(`🚀 [WORKER][${targetJobId}] Azione: ${action || 'standard'} (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1})`);

  // Job già chiuso? Esci subito.
  if (await skipIfTerminal(targetJobId)) return;

  let state = null; // stato job letto da Redis, aggiornato ad ogni fase

  try {
    // -------------------------------------------------------------------------
    // RIGENERAZIONE SINGOLO TONO (post-consolidamento Firestore)
    // -------------------------------------------------------------------------
    if (action === 'regen_tone' && toneKey) {
      state = await getRedisJob(uid, targetJobId);
      if (!state) state = await hydrateRedisFromFirestore(uid, targetJobId);
      if (!state) throw new AppError(`Job ${targetJobId} non trovato.`, { step: 'generation', retryable: false });

      const tone = state.tones?.[toneKey];
      if (!tone || tone.status !== 'ON') {
        throw new AppError(`Tono ${toneKey} non idoneo (status OFF o assente).`, { step: 'generation', retryable: false });
      }

      await patchRedisJob(uid, targetJobId, {
        status: 'generating',
        workerState: { currentStep: 'generation', progress: 0.5, updatedAt: new Date().toISOString() },
      });

      const refiner = state.refiner;
      const output = await generateTones(
        {
          topic: state.topic,
          platform: normalizePlatform(platform || state.platform),
          language: language || state.language,
          maxChars,
          singleToneTarget: toneKey,
          instructions: instructions || '',
        },
        refiner.compressedFacts || [],
        refiner.sourcesPreview || [],
        refiner.tables || []
      );

      const newText = output[toneKey]?.text;
      if (!newText) {
        throw new AppError(`Generazione fallita per tono: ${toneKey}`, { step: 'generation', retryable: true });
      }

      await writeGeneratedTone(uid, targetJobId, toneKey, newText, { instructions });
      await patchRedisJob(uid, targetJobId, {
        status: 'completed',
        workerState: { currentStep: 'done', progress: 1.0, updatedAt: new Date().toISOString() },
      });

      await consolidateToFirestore(uid, targetJobId, 'completed');
      console.log(`[WORKER][${targetJobId}] Rigenerazione tono ${toneKey} consolidata.`);
      return;
    }

    // -------------------------------------------------------------------------
    // INIZIALIZZAZIONE REDIS
    // -------------------------------------------------------------------------
    state = await getRedisJob(uid, targetJobId);
    if (!state) {
      throw new AppError(
        `Job Redis ${targetJobId} non trovato. Deve essere creato dall'API.`,
        { step: 'query_shaping', retryable: true }
      );
    }

    await patchRedisJob(uid, targetJobId, {
      status: state.inputType === 'url' && !isContentIngestDone(state) ? 'ingesting' : 'running',
    });

    // -------------------------------------------------------------------------
    // F0 — CONTENT INGEST (solo se l'utente ha inserito un URL)
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
      console.log(`✅ [WORKER][${targetJobId}] F0 completata (${ingestOut.sourceMeta?.charCount || 0} caratteri estratti).`);
    }

    // -------------------------------------------------------------------------
    // F1 — SHAPER & GATEKEEPER
    // -------------------------------------------------------------------------
    if (!isShapingDone(state.shaping)) {
      console.log(`🧠 [WORKER][${targetJobId}] F1 Shaper...`);
      maybeSimulateFault('query_shaping');

      const shaperTopic = state.topic || topic;
      const shaperOut = IS_MOCK ? mockShaper(shaperTopic) : await runShaperGatekeeper(shaperTopic);
      state = await writeShapingToRedis(uid, targetJobId, shaperOut);

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
    const searchRequired = state.shaping?.search_required !== false; // false = salta F2
    const plan = state.shaping?.plan || []; // query Tavily create in F1

    // -------------------------------------------------------------------------
    // F2 — TAVILY (condizionale)
    // -------------------------------------------------------------------------
    if (searchRequired && !state.tavily?.rawResults?.length) {
      console.log(`🌐 [WORKER][${targetJobId}] F2 Search...`);
      maybeSimulateFault('tavily_search'); // test errore F2 se SIMULATE_FAULT=F2

      const { rawResults } = IS_MOCK ? mockTavily() : await performWebSearch(plan);
      state = await writeTavilyToRedis(uid, targetJobId, rawResults);
    } else if (!searchRequired) {
      console.log(`⏭️ [WORKER][${targetJobId}] F2 saltata (search_required=false).`);
      await patchRedisJob(uid, targetJobId, {
        tavily: { rawResults: [] },
        workerState: { currentStep: 'tavily_search', progress: 0.5, updatedAt: new Date().toISOString() },
      });
    }

    // -------------------------------------------------------------------------
    // F3 — REFINER
    // -------------------------------------------------------------------------
    state = await getRedisJob(uid, targetJobId);
    if (!state.refiner?.compressedFacts?.length) {
      console.log(`💎 [WORKER][${targetJobId}] F3 Refiner...`);
      maybeSimulateFault('refiner'); // test errore F3 se SIMULATE_FAULT=F3

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
    // STOP — shaping_only → consolidamento Firestore + DEL Redis
    // -------------------------------------------------------------------------
    if (action === 'shaping_only') {
      await patchRedisJob(uid, targetJobId, {
        status: 'completed',
        workerState: { currentStep: 'done', progress: 1.0, updatedAt: new Date().toISOString() },
      });
      await consolidateToFirestore(uid, targetJobId, 'completed');
      console.log(`[WORKER][${targetJobId}] Analisi completata. Record portato su Firestore e rimosso da Redis.`);
      return;
    }

    // -------------------------------------------------------------------------
    // F4 — GENERATION (tutti i toni ON)
    // -------------------------------------------------------------------------
    state = await getRedisJob(uid, targetJobId);
    // Solo toni con status ON (decisi dallo Shaper in F1)
    const tonesOn = TONE_IDS.filter((id) => state.tones?.[id]?.status === 'ON');
    // Genera solo i toni ON che non hanno ancora testo
    const needsGeneration = tonesOn.some((id) => !state.tones[id]?.text?.trim());

    if (needsGeneration) {
      console.log(`🎨 [WORKER][${targetJobId}] F4 Generation (${tonesOn.length} toni ON)...`);
      maybeSimulateFault('generation'); // test errore F4 se SIMULATE_FAULT=F4

      await patchRedisJob(uid, targetJobId, {
        status: 'generating',
        workerState: { currentStep: 'generation', progress: 0.9, updatedAt: new Date().toISOString() },
      });

      const generated = await generateTones(
        {
          topic: state.topic,
          platform: state.platform,
          language: state.language,
          maxChars,
          allowedTones: tonesOn,
        },
        state.refiner.compressedFacts || [],
        state.refiner.sourcesPreview || [],
        state.refiner.tables || []
      );

      const tones = { ...state.tones };
      for (const id of tonesOn) {
        if (generated[id]?.text) {
          tones[id] = {
            ...tones[id],
            text: generated[id].text,
            version: 1,
            type: 'generation',
          };
        }
      }

      // Se manca anche un solo tono ON, il job non è completo → errore (così riprova o fallisce chiaramente)
      const missingTones = tonesOn.filter((id) => !tones[id]?.text?.trim());
      if (missingTones.length) {
        throw new AppError(
          `Generazione incompleta per toni: ${missingTones.join(', ')}`,
          { step: 'generation', retryable: true }
        );
      }

      await patchRedisJob(uid, targetJobId, { tones });
    }

    await patchRedisJob(uid, targetJobId, {
      status: 'completed',
      workerState: { currentStep: 'done', progress: 1.0, updatedAt: new Date().toISOString() },
    });

    await consolidateToFirestore(uid, targetJobId, 'completed');
    console.log(`[WORKER][${targetJobId}] Pipeline completata. Consolidato su Firestore.`);

  } catch (err) {
    const step = err?.step || state?.workerState?.currentStep || 'unknown';
    logError(`WORKER:${targetJobId}`, err, { step, attempt: job.attemptsMade + 1 });

    const maxAttempts = job.opts?.attempts ?? 1;
    // Posso riprovare SOLO se l'errore è temporaneo E ho ancora tentativi BullMQ disponibili
    const canRetry = isRetryableError(err) && job.attemptsMade < maxAttempts - 1;

    if (canRetry) {
      // Salva in Redis che stiamo riprovando (utile per il frontend che fa polling)
      try {
        if (state) {
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
      throw err; // BullMQ riaccoderà il job per un nuovo tentativo
    }

    // Errore definitivo O tentativi esauriti → salva failed su Firestore
    const { persisted } = await failAndConsolidate(uid, targetJobId, err.message, step, 'failed');
    // Se failAndConsolidate ha funzionato, NON rilanciare: il job è chiuso correttamente
    // Se non ha funzionato (persisted=false), rilancia così BullMQ lo segnala come failed
    if (!persisted) throw err;
  }
}, { connection: redisConnection, concurrency: 1 }); // concurrency:1 = un job alla volta

// Eventi della coda BullMQ — utili per capire cosa succede in produzione
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

// "stalled" = job bloccato troppo a lungo (worker crashato a metà?)
worker.on('stalled', (jobId) => {
  console.warn(`⚠️ [WORKER] Job stalled: ${jobId}`);
});

// Registra chiusura pulita: Ctrl+C o deploy chiama worker.close() poi redis.quit()
registerProcessHandlers({
  label: 'worker',
  onShutdown: async () => {
    await worker.close(); // aspetta che il job in corso finisca
    await closeRedis();
  },
});

// All'avvio verifica che Redis risponda (se no, log warning ma il worker resta in ascolto)
logSimulationBanner();

pingRedis()
  .then(() => console.log('🚀 Worker PRISM operativo (Redis online → Firestore consolidato).'))
  .catch((err) => {
    logError('worker:startup', err);
    console.warn('⚠️ Worker avviato ma Redis non raggiungibile — in attesa di riconnessione.');
  });
