/**
 * API PRISM — Accodamento su Redis, polling da Redis/Firestore.
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Queue } from 'bullmq';
import redisConnection from '../utils/redis.js';
import {
  initializeRedisJob,
  getRedisJob,
  getFirestoreJob,
  patchRedisJob,
  hydrateRedisFromFirestore,
  getJobStatusForClient,
  updateToneOnRedis,
  normalizePlatform,
  MAX_INSTRUCTIONS_LENGTH,
} from '../services/stateManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../logs');
const ERROR_LOG_FILE = path.join(LOGS_DIR, 'production_errors.log');

const app = express();
app.use(cors());
app.use(express.json());

const prismQueue = new Queue('prism-jobs', { connection: redisConnection });

const ensureLogsDir = () => {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
};

app.post('/api/generate', async (req, res) => {
  const { userId, companyId, topic, platform, language, maxChars } = req.body;
  if (!userId || !topic) return res.status(400).json({ error: 'Missing userId or topic' });
  if (!companyId) return res.status(400).json({ error: 'Missing companyId' });

  try {
    const job = await prismQueue.add(
      'generate-content',
      { userId, companyId, topic, platform, language: language || 'italiano', maxChars },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    );

    await initializeRedisJob(userId, job.id, {
      companyId,
      topic,
      platform: platform || 'general',
      language: language || 'italiano',
      action: 'standard',
    });

    res.json({ success: true, jobId: job.id });
  } catch (error) {
    console.error('❌ API Generate:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/prepare-shaping', async (req, res) => {
  const { userId, companyId, topic, platform, language } = req.body;
  if (!userId || !topic || !companyId) {
    return res.status(400).json({ error: 'Missing userId, companyId or topic' });
  }

  try {
    const job = await prismQueue.add(
      'generate-content',
      { userId, companyId, topic, platform, language, action: 'shaping_only' },
      { attempts: 2, removeOnComplete: true, removeOnFail: false }
    );

    await initializeRedisJob(userId, job.id, {
      companyId,
      topic,
      platform: platform || 'general',
      language: language || 'italiano',
      action: 'shaping_only',
    });

    console.log(`🧠 [SERVER] Job ${job.id} accodato (Redis).`);
    res.json({ success: true, jobId: job.id });
  } catch (error) {
    console.error('❌ API Prepare-Shaping:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

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
    console.error('❌ Polling:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

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

    await patchRedisJob(userId, jobId, {
      status: 'generating',
      workerState: { currentStep: 'generation', progress: 0.2, updatedAt: new Date().toISOString() },
      ...(platform ? { platform: normalizePlatform(platform) } : {}),
      ...(language ? { language } : {}),
    });

    const regenInstructions = instructions
      ? String(instructions).slice(0, MAX_INSTRUCTIONS_LENGTH)
      : '';

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
      { attempts: 2, removeOnComplete: true, removeOnFail: false }
    );

    res.json({ success: true, jobId });
  } catch (error) {
    console.error('❌ Rigenerazione:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
});

app.post('/api/update-tone-redis', async (req, res) => {
  try {
    const { userId, jobId, toneKey, text } = req.body;
    if (!userId || !jobId || !toneKey || text === undefined) {
      return res.status(400).json({ success: false, error: 'Dati incompleti.' });
    }

    await updateToneOnRedis(userId, jobId, toneKey, text);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update Tone:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

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
    }) + '\n', 'utf8');

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`📡 API PRISM attiva sulla porta ${PORT}`));
