/**
 * API PRISM — server HTTP usato dal frontend.
 *
 * Endpoint tenuti (unico contratto frontend):
 * - POST /api/prepare-shaping          → analisi F0→F3 (niente generazione testi)
 * - POST /api/regenerate-tone-surgical → genera/rigenera UN solo tono
 * - GET  /jobs/status/:userId/:jobId   → polling stato job
 * - GET  /health e /ready              → monitoraggio infrastruttura
 *
 * Flusso tipico UI:
 * 1) prepare-shaping → polling fino a completed (pilastri + toni ON/OFF)
 * 2) regenerate-tone-surgical per ogni tono che l'utente attiva/rigenera
 */

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { Queue, QueueEvents } from 'bullmq';
// Redis: coda BullMQ + stato job durante l'elaborazione
import redisConnection, { closeRedis, isRedisReady, pingRedis } from '../utils/redis.js';
// Errori tipizzati + log strutturato
import { AppError, logError } from '../utils/errors.js';
// Chiude API/coda/Redis in modo pulito su Ctrl+C o deploy
import { registerProcessHandlers } from '../utils/processHandlers.js';
import {
  initializeRedisJob, // crea record Redis prima di accodare
  getRedisJob, // legge job da Redis
  getFirestoreJob, // legge job già consolidato su Firestore
  patchRedisJob, // aggiorna campi del job in Redis
  hydrateRedisFromFirestore, // ricarica job da Firestore a Redis (per regen)
  getJobStatusForClient, // payload compatto per il polling frontend
  deleteRedisJob, // rollback se l'accodamento fallisce
  normalizePlatform, // linkedin → LinkedIn, ecc.
} from '../services/stateManager.js';
// Controlla companies/{id}.enabled_tones prima di generare un tono
import { assertToneEnabledForCompany, normalizeToneKey } from '../services/companyAccess.js';

const app = express();
app.use(cors()); // permette chiamate dal browser su altro dominio
app.use(express.json()); // body JSON → req.body

// Ogni richiesta HTTP riceve un ID corto per ritrovarla nei log
app.use((req, res, next) => {
  req.requestId = randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// Coda BullMQ: l'API mette i job, il worker li preleva
const prismQueue = new Queue('prism-jobs', { connection: redisConnection });
// Eventi coda: servono ad attendere il risultato di regenerate-tone-surgical
const prismQueueEvents = new QueueEvents('prism-jobs', { connection: redisConnection });

/** Limite caratteri per istruzioni aggiuntive in rigenerazione */
const REGEN_INSTRUCTIONS_MAX = 2000;
/** Timeout (ms) attesa generazione tono prima di rispondere al frontend */
const REGEN_WAIT_MS = 120_000;

/**
 * Accoda un job di analisi (prepare-shaping) in modo sicuro.
 *
 * Ordine:
 * 1) Crea il record in Redis (il worker deve trovarlo subito)
 * 2) Metti il job in coda BullMQ
 * 3) Se la coda fallisce → cancella Redis (niente job fantasma)
 *
 * @param {string} jobId
 * @param {object} payload — userId, companyId, topic, platform, language, action
 * @param {object} queueOpts — attempts, backoff, removeOnComplete...
 */
const enqueueAnalysisJob = async (jobId, payload, queueOpts) => {
  // Scrive lo stato iniziale in Redis (status pending, toni vuoti, ecc.)
  await initializeRedisJob(payload.userId, jobId, {
    companyId: payload.companyId,
    topic: payload.topic,
    platform: payload.platform || 'general',
    language: payload.language || 'italiano',
    outputFormat: payload.outputFormat || 'text',
    action: 'shaping_only', // sempre analisi F0→F3, mai F4
  });

  try {
    // Accoda con lo stesso jobId usato in Redis
    await prismQueue.add(
      'prepare-shaping',
      { ...payload, action: 'shaping_only' },
      { jobId, ...queueOpts },
    );
  } catch (err) {
    // Rollback: senza questo resterebbe un job Redis orfano
    await deleteRedisJob(payload.userId, jobId).catch(() => {});
    throw err;
  }

  return jobId;
};

/** /health = processo vivo (load balancer), non verifica Redis */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/** /ready = può servire traffico? Controlla che Redis risponda al ping */
app.get('/ready', async (_req, res) => {
  try {
    await pingRedis();
    res.json({ status: 'ready', redis: isRedisReady() });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

/**
 * POST /api/prepare-shaping
 * Avvia l'analisi editoriale: F0 (URL) → F1 Shaper → F2 Search → F3 Refiner.
 * NON genera testi dei toni: quello lo fa regenerate-tone-surgical.
 *
 * Body: { userId, companyId, topic, platform?, language?, outputFormat? }
 * Risposta: { success, jobId } → poi polling su /jobs/status
 */
app.post('/api/prepare-shaping', async (req, res) => {
  const { userId, companyId, topic, platform, language, outputFormat, formatoOutput } = req.body;
  // Parametri minimi obbligatori
  if (!userId || !topic || !companyId) {
    return res.status(400).json({ error: 'Missing userId, companyId or topic' });
  }

  // Stesso UUID per Redis e per BullMQ
  const jobId = randomUUID();

  try {
    await enqueueAnalysisJob(
      jobId,
      {
        userId,
        companyId,
        topic,
        platform,
        language: language || 'italiano',
        outputFormat: outputFormat || formatoOutput || 'text',
        action: 'shaping_only',
      },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    console.log(`🧠 [API] prepare-shaping accodato: ${jobId}`);
    res.json({ success: true, jobId });
  } catch (error) {
    logError('API:prepare-shaping', error, { requestId: req.requestId, jobId });
    res.status(500).json({ error: 'Internal Server Error', requestId: req.requestId });
  }
});

/**
 * GET /jobs/status/:userId/:jobId
 * Polling frontend: a che punto è il job di analisi (o dopo una regen)?
 */
app.get('/jobs/status/:userId/:jobId', async (req, res) => {
  try {
    const { userId, jobId } = req.params;
    const jobStatus = await getJobStatusForClient(userId, jobId);

    if (!jobStatus) {
      return res.status(404).json({ success: false, error: 'JOB_NOT_FOUND' });
    }

    // failed/blocked → success false ma con dettagli utili alla UI
    if (jobStatus.status === 'failed' || jobStatus.status === 'blocked') {
      return res.json({ success: false, ...jobStatus });
    }

    res.json({ success: true, data: jobStatus });
  } catch (error) {
    logError('API:status', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Internal Server Error', requestId: req.requestId });
  }
});

/**
 * POST /api/regenerate-tone-surgical
 * Genera o rigenera UN solo tono su un job già analizzato (prepare-shaping completed).
 *
 * Input: tono, lingua, piattaforma, argomento, istruzioni, contenuto precedente,
 *        più userId, companyId, jobId.
 * Output: { contenutoGenerato } oppure { error }.
 */
app.post('/api/regenerate-tone-surgical', async (req, res) => {
  try {
    const body = req.body || {};
    // Accetta nomi IT e EN per i campi di input
    const userId = body.userId;
    const companyId = body.companyId;
    const jobId = body.jobId;
    const toneKey = normalizeToneKey(body.tono || body.toneKey);
    const language = body.linguaOutput || body.lingua || body.language;
    const platform = body.piattaforma || body.platform;
    const outputFormat = body.formatoOutput || body.outputFormat || body.format || 'text';
    const topic = body.argomento || body.topic;
    // Prima generazione: istruzioni/contenuto precedente opzionali (usati in altro flusso di regen)
    const instructionsRaw = body.istruzioniAggiuntive || body.istruzioni || body.instructions || '';
    const previousContent =
      body.contenutoPrecedente || body.contenuto_precedente || body.previousContent || '';

    // Obbligatori: userId, companyId, jobId, tono, lingua, piattaforma
    if (!userId || !companyId || !toneKey || !jobId || !language || !platform) {
      return res.status(400).json({
        success: false,
        error:
          'Parametri mancanti (userId, companyId, tono/toneKey, jobId, linguaOutput/language, piattaforma/platform).',
        contenutoGenerato: null,
      });
    }

    // Blocco immediato se la company non ha il tono in enabled_tones
    try {
      await assertToneEnabledForCompany(companyId, toneKey);
    } catch (accessErr) {
      const msg =
        accessErr?.message ||
        `Utente non abilitato alla generazione del tono (${toneKey}).`;
      return res.status(403).json({
        success: false,
        error: msg,
        contenutoGenerato: null,
      });
    }

    // Carica il job: prima Redis (in corso), poi Firestore (già consolidato)
    let job = await getRedisJob(userId, jobId);
    if (!job) job = await getFirestoreJob(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Task non trovato.',
        contenutoGenerato: null,
      });
    }

    // Lo Shaper ha messo questo tono OFF → non generare
    if (job.tones?.[toneKey]?.status === 'OFF') {
      return res.status(400).json({
        success: false,
        error: `Tono ${toneKey} bloccato: ${job.tones[toneKey].lock_reason}`,
        contenutoGenerato: null,
      });
    }

    // Job solo su Firestore → riporta in Redis per il worker
    if (!(await getRedisJob(userId, jobId))) {
      await hydrateRedisFromFirestore(userId, jobId);
    }

    // Baseline: body oppure testo già salvato sul tono
    const previous =
      String(previousContent || '').trim() ||
      String(job.tones?.[toneKey]?.text || '').trim();

    // Taglia istruzioni troppo lunghe
    const regenInstructions = instructionsRaw
      ? String(instructionsRaw).slice(0, REGEN_INSTRUCTIONS_MAX)
      : '';

    // ID del job BullMQ di regen (diverso dal parentJobId del contenuto)
    const regenJobId = randomUUID();
    const resolvedPlatform = normalizePlatform(platform);
    const resolvedLanguage = String(language).trim();
    const resolvedOutputFormat = String(outputFormat || 'text').trim().toLowerCase();
    const resolvedTopic = topic || job.topic || '';

    // Accoda SOLO la generazione del tono (action regen_tone)
    const bullJob = await prismQueue.add(
      'regen-tone',
      {
        userId,
        companyId,
        toneKey,
        platform: resolvedPlatform,
        language: resolvedLanguage,
        outputFormat: resolvedOutputFormat,
        topic: resolvedTopic,
        instructions: regenInstructions,
        previousContent: previous,
        parentJobId: jobId, // job di analisi su cui salvare il testo
        action: 'regen_tone',
      },
      {
        jobId: regenJobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    // Aggiorna lo stato del job padre per il polling UI
    await patchRedisJob(userId, jobId, {
      status: 'generating',
      workerState: {
        currentStep: 'generation',
        progress: 0.2,
        updatedAt: new Date().toISOString(),
      },
      platform: resolvedPlatform,
      language: resolvedLanguage,
      outputFormat: resolvedOutputFormat,
    });

    // Attende il worker e restituisce subito il contenuto (o l'errore)
    try {
      const result = await bullJob.waitUntilFinished(prismQueueEvents, REGEN_WAIT_MS);
      const contenutoGenerato = result?.text || result?.contenutoGenerato || null;
      if (!contenutoGenerato) {
        return res.status(500).json({
          success: false,
          error: 'Generazione completata ma senza contenuto.',
          contenutoGenerato: null,
          jobId,
        });
      }
      // Guardrail API: se formato carosello, assicura almeno JSON parsabile prima della risposta.
      if (resolvedOutputFormat === 'carousel' || resolvedOutputFormat === 'carosello') {
        try {
          JSON.parse(String(contenutoGenerato));
        } catch {
          return res.status(500).json({
            success: false,
            error: 'Output carosello non valido: JSON non parsabile.',
            contenutoGenerato: null,
            jobId,
          });
        }
      }
      return res.json({
        success: true,
        contenutoGenerato,
        jobId,
        toneKey,
      });
    } catch (waitErr) {
      const message =
        waitErr?.message ||
        waitErr?.failedReason ||
        'Errore durante la generazione del tono.';
      return res.status(500).json({
        success: false,
        error: message,
        contenutoGenerato: null,
        jobId,
      });
    }
  } catch (error) {
    logError('API:regenerate-tone', error, { requestId: req.requestId });
    const status =
      error instanceof AppError && error.code === 'TONE_NOT_ENABLED' ? 403 : 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Internal Server Error',
      contenutoGenerato: null,
      requestId: req.requestId,
    });
  }
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () =>
  console.log(`📡 API PRISM attiva sulla porta ${PORT}`),
);

// Su deploy/restart: chiude HTTP → coda → eventi → Redis
registerProcessHandlers({
  label: 'api',
  onShutdown: async () => {
    await new Promise((resolve) => server.close(resolve));
    await prismQueue.close();
    await prismQueueEvents.close();
    await closeRedis();
  },
});

// Verifica Redis all'avvio (warning se down, il server resta su)
pingRedis()
  .then(() => console.log('✅ API connessa a Redis'))
  .catch((err) => logError('api:startup:redis', err));
