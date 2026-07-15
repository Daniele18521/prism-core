/**
 * API PRISM — server HTTP che riceve le richieste dal frontend.
 *
 * Cosa fa:
 * - Crea job e li mette in coda (BullMQ/Redis)
 * - Risponde al frontend con jobId per fare polling dello stato
 * - Espone /health e /ready per monitoraggio produzione
 *
 * Miglioramenti produzione:
 * - jobId generato PRIMA → Redis creato prima della coda (niente race col worker)
 * - Se accodamento fallisce → cancella Redis (niente job fantasma)
 * - Shutdown graceful su deploy/restart
 * - requestId su ogni richiesta per tracciare errori nei log
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { Queue } from 'bullmq';
import redisConnection, { closeRedis, isRedisReady, pingRedis } from '../utils/redis.js';
import { logError } from '../utils/errors.js';
import { registerProcessHandlers } from '../utils/processHandlers.js';
import {
  initializeRedisJob,
  getRedisJob,
  getFirestoreJob,
  patchRedisJob,
  hydrateRedisFromFirestore,
  getJobStatusForClient,
  updateToneOnRedis,
  deleteRedisJob,
  normalizePlatform,
  MAX_INSTRUCTIONS_LENGTH,
} from '../services/stateManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../logs'); // cartella log errori frontend
const ERROR_LOG_FILE = path.join(LOGS_DIR, 'production_errors.log');

const app = express();
app.use(cors()); // permette richieste dal browser su dominio diverso
app.use(express.json()); // parse body JSON automatico

// Ogni richiesta HTTP riceve un ID corto per ritrovarla nei log se qualcosa va storto
app.use((req, res, next) => {
  req.requestId = randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// Coda BullMQ: lista di job che il worker preleverà uno alla volta
const prismQueue = new Queue('prism-jobs', { connection: redisConnection });

const ensureLogsDir = () => {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
};

/**
 * Accoda un job in modo sicuro.
 *
 * Ordine IMPORTANTE:
 * 1. Crea record in Redis (così il worker trova subito i dati)
 * 2. Metti il job in coda BullMQ
 * 3. Se la coda fallisce → cancella Redis (rollback)
 *
 * Prima facevamo queue.add PRIMA di Redis: il worker poteva partire
 * e non trovare il job → errore "Job Redis non trovato".
 */
const enqueueJob = async (jobId, payload, queueOpts) => {
  await initializeRedisJob(payload.userId, jobId, {
    companyId: payload.companyId,
    topic: payload.topic,
    platform: payload.platform || 'general',
    language: payload.language || 'italiano',
    action: payload.action || 'standard',
  });

  try {
    await prismQueue.add('generate-content', payload, { jobId, ...queueOpts });
  } catch (err) {
    await deleteRedisJob(payload.userId, jobId).catch(() => {}); // rollback
    throw err;
  }

  return jobId;
};

/** /health = "sono vivo?" — usato da load balancer, non controlla Redis */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/** /ready = "posso servire traffico?" — controlla che Redis risponda al ping */
app.get('/ready', async (_req, res) => {
  try {
    await pingRedis();
    res.json({ status: 'ready', redis: isRedisReady() });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

/** POST /api/generate — avvia pipeline completa F1→F4 (generazione contenuti) */
app.post('/api/generate', async (req, res) => {
  const { userId, companyId, topic, platform, language, maxChars } = req.body;
  if (!userId || !topic) return res.status(400).json({ error: 'Missing userId or topic' });
  if (!companyId) return res.status(400).json({ error: 'Missing companyId' });

  // UUID generato qui: stesso ID per Redis e per la coda
  const jobId = randomUUID();

  try {
    await enqueueJob(jobId, {
      userId,
      companyId,
      topic,
      platform,
      language: language || 'italiano',
      maxChars,
      action: 'standard',
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    res.json({ success: true, jobId });
  } catch (error) {
    logError('API:generate', error, { requestId: req.requestId, jobId });
    res.status(500).json({ error: 'Internal Server Error', requestId: req.requestId });
  }
});

/** POST /api/prepare-shaping — solo analisi F1→F3, senza generazione testi (shaping_only) */
app.post('/api/prepare-shaping', async (req, res) => {
  const { userId, companyId, topic, platform, language } = req.body;
  if (!userId || !topic || !companyId) {
    return res.status(400).json({ error: 'Missing userId, companyId or topic' });
  }

  // UUID generato qui: stesso ID per Redis e per la coda
  const jobId = randomUUID();

  try {
    await enqueueJob(jobId, {
      userId,
      companyId,
      topic,
      platform,
      language,
      action: 'shaping_only',
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    console.log(`🧠 [SERVER] Job ${jobId} accodato (Redis).`);
    res.json({ success: true, jobId });
  } catch (error) {
    logError('API:prepare-shaping', error, { requestId: req.requestId, jobId });
    res.status(500).json({ error: 'Internal Server Error', requestId: req.requestId });
  }
});

/** GET /jobs/status — polling frontend: a che punto è il job? */
app.get('/jobs/status/:userId/:jobId', async (req, res) => {
  try {
    const { userId, jobId } = req.params;
    const jobStatus = await getJobStatusForClient(userId, jobId);

    if (!jobStatus) {
      return res.status(404).json({ success: false, error: 'JOB_NOT_FOUND' });
    }

    if (jobStatus.status === 'failed' || jobStatus.status === 'blocked') {
      return res.json({ success: false, ...jobStatus });
    }

    res.json({ success: true, data: jobStatus });
  } catch (error) {
    logError('API:status', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Internal Server Error', requestId: req.requestId });
  }
});

/** POST /api/regenerate-tone-surgical — rigenera un solo tono su job esistente */
app.post('/api/regenerate-tone-surgical', async (req, res) => {
  try {
    const { userId, companyId, toneKey, jobId, platform, language, instructions } = req.body;
    if (!userId || !companyId || !toneKey || !jobId) {
      return res.status(400).json({ success: false, error: 'Parametri mancanti.' });
    }

    let job = await getRedisJob(userId, jobId);
    if (!job) job = await getFirestoreJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Task non trovato.' });

    if (job.tones?.[toneKey]?.status === 'OFF') {
      return res.status(400).json({ success: false, error: `Tono ${toneKey} bloccato: ${job.tones[toneKey].lock_reason}` });
    }

    if (!await getRedisJob(userId, jobId)) {
      await hydrateRedisFromFirestore(userId, jobId);
    }

    const regenInstructions = instructions
      ? String(instructions).slice(0, MAX_INSTRUCTIONS_LENGTH)
      : '';

    const regenJobId = randomUUID();

    // Prima accoda il lavoro, POI aggiorna lo stato in Redis.
    // Se accodamento fallisce, lo stato del job originale non resta bloccato su "generating".
    await prismQueue.add(
      'generate-content',
      {
        userId,
        companyId,
        toneKey,
        platform: normalizePlatform(platform || job.platform),
        language: language || job.language,
        instructions: regenInstructions,
        parentJobId: jobId,
        action: 'regen_tone',
      },
      {
        jobId: regenJobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    await patchRedisJob(userId, jobId, {
      status: 'generating',
      workerState: { currentStep: 'generation', progress: 0.2, updatedAt: new Date().toISOString() },
      ...(platform ? { platform: normalizePlatform(platform) } : {}),
      ...(language ? { language } : {}),
    });

    res.json({ success: true, jobId });
  } catch (error) {
    logError('API:regenerate-tone', error, { requestId: req.requestId });
    res.status(500).json({ success: false, error: error.message || 'Internal Server Error', requestId: req.requestId });
  }
});

/** POST /api/update-tone-redis — salva modifica manuale testo tono da editor UI */
app.post('/api/update-tone-redis', async (req, res) => {
  try {
    const { userId, jobId, toneKey, text } = req.body;
    if (!userId || !jobId || !toneKey || text === undefined) {
      return res.status(400).json({ success: false, error: 'Dati incompleti.' });
    }

    await updateToneOnRedis(userId, jobId, toneKey, text);
    res.json({ success: true });
  } catch (error) {
    logError('API:update-tone', error, { requestId: req.requestId });
    res.status(500).json({ success: false, error: 'Internal Server Error', requestId: req.requestId });
  }
});

/** POST /api/log-error — il frontend invia errori JavaScript da salvare su file */
app.post('/api/log-error', async (req, res) => {
  try {
    const { type, message, filename, lineno, colno, stack, url, userId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "Campo 'message' obbligatorio." });

    ensureLogsDir();
    await fs.promises.appendFile(ERROR_LOG_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: type || 'unknown',
      message: String(message).slice(0, 2000),
      filename, lineno, colno,
      stack: stack ? String(stack).slice(0, 8000) : null,
      url, userId,
      requestId: req.requestId,
    }) + '\n', 'utf8');

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`📡 API PRISM attiva sulla porta ${PORT}`));

// Su deploy/restart: chiude server HTTP → coda → Redis, in ordine
registerProcessHandlers({
  label: 'api',
  onShutdown: async () => {
    await new Promise((resolve) => server.close(resolve)); // smette di accettare nuove richieste
    await prismQueue.close();
    await closeRedis();
  },
});

// Verifica connessione Redis all'avvio
pingRedis()
  .then(() => console.log('✅ API connessa a Redis'))
  .catch((err) => logError('api:startup:redis', err));
