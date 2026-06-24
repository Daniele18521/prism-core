/**
 * STATE MANAGER — Redis online, Firestore consolidato a fine processo.
 */

import redisConnection from '../utils/redis.js';
import { db } from '../utils/firebaseAdmin.js';

export const TONE_IDS = [
  'provocatore',
  'confidente',
  'sferzante',
  'visionario',
  'metodologico',
  'narratore',
];

const REDIS_TTL = 86400;
const MAX_INSTRUCTIONS_LENGTH = 100;

export const normalizePlatform = (platform) => {
  const map = {
    linkedin: 'LinkedIn',
    facebook: 'Facebook',
    x: 'X',
    twitter: 'X',
    general: 'LinkedIn',
  };
  return map[(platform || 'general').toLowerCase().trim()] || platform;
};

const nowIso = () => new Date().toISOString();
const redisKey = (userId, jobId) => `${userId}:jobs:${jobId}`;

export const buildEmptyTones = () => {
  const tones = {};
  for (const id of TONE_IDS) {
    tones[id] = {
      status: 'OFF',
      lock_reason: '',
      text: '',
      version: 0,
      type: 'generation',
    };
  }
  return tones;
};

const TONE_ALIASES = {
  provocatore: 'provocatore',
  il_provocatore: 'provocatore',
  confidente: 'confidente',
  il_confidente: 'confidente',
  sferzante: 'sferzante',
  lo_sferzante: 'sferzante',
  visionario: 'visionario',
  il_visionario: 'visionario',
  metodologico: 'metodologico',
  il_metodologico: 'metodologico',
  narratore: 'narratore',
  il_narratore: 'narratore',
};

export const buildTonesFromSuitability = (toneSuitability = {}) => {
  const tones = buildEmptyTones();
  for (const [rawKey, val] of Object.entries(toneSuitability)) {
    const key = TONE_ALIASES[rawKey.toLowerCase().replace(/\s+/g, '_')] || rawKey.toLowerCase();
    if (!tones[key]) continue;
    tones[key] = {
      status: val.status === 'ON' ? 'ON' : 'OFF',
      lock_reason: val.lock_reason || val.reason || '',
      text: '',
      version: 0,
      type: 'generation',
    };
  }
  return tones;
};

const deepMerge = (base, patch) => {
  const out = { ...base, ...patch };
  for (const key of ['shaping', 'tavily', 'refiner', 'workerState', 'error', 'tones']) {
    if (patch[key] !== undefined) {
      out[key] = { ...(base[key] || {}), ...patch[key] };
    }
  }
  return out;
};

export const initializeRedisJob = async (userId, jobId, {
  companyId,
  topic,
  platform = 'general',
  language = 'italiano',
  action,
}) => {
  const timestamp = nowIso();
  const job = {
    jobId,
    companyId,
    userId,
    topic,
    status: 'pending',
    language,
    platform: normalizePlatform(platform),
    action: action || 'standard',
    createdAt: timestamp,
    updatedAt: timestamp,
    shaping: {
      suggestedQueries: [],
      updatedAt: null,
    },
    tavily: { rawResults: [] },
    refiner: {
      compressedFacts: [],
      sourcesPreview: [],
      tables: [],
    },
    workerState: {
      currentStep: 'query_shaping',
      progress: 0.0,
      retryCount: 0,
      updatedAt: timestamp,
    },
    error: { message: null, step: null },
    tones: buildEmptyTones(),
  };

  await redisConnection.set(redisKey(userId, jobId), JSON.stringify(job), 'EX', REDIS_TTL);
  return job;
};

export const getRedisJob = async (userId, jobId) => {
  const raw = await redisConnection.get(redisKey(userId, jobId));
  return raw ? JSON.parse(raw) : null;
};

export const patchRedisJob = async (userId, jobId, patch) => {
  const current = await getRedisJob(userId, jobId);
  if (!current) throw new Error(`Job Redis non trovato: ${jobId}`);

  const merged = deepMerge(current, { ...patch, updatedAt: nowIso() });
  await redisConnection.set(redisKey(userId, jobId), JSON.stringify(merged), 'EX', REDIS_TTL);
  return merged;
};

export const deleteRedisJob = async (userId, jobId) => {
  await redisConnection.del(redisKey(userId, jobId));
};

export const writeShapingToRedis = async (userId, jobId, shaperOutput) => {
  const suggestedQueries = (shaperOutput.plan || []).map((p) => p.query).filter(Boolean);
  const tones = buildTonesFromSuitability(shaperOutput.tone_suitability);

  return patchRedisJob(userId, jobId, {
    shaping: {
      is_blocked: shaperOutput.is_blocked,
      block_message: shaperOutput.block_message || '',
      diagnosi: shaperOutput.diagnosi || {},
      search_required: shaperOutput.search_required,
      tone_suitability: shaperOutput.tone_suitability || {},
      plan: shaperOutput.plan || [],
      suggestedQueries,
      updatedAt: nowIso(),
    },
    tones,
    workerState: {
      currentStep: 'query_shaping',
      progress: 0.2,
      updatedAt: nowIso(),
    },
    status: 'running',
  });
};

export const writeTavilyToRedis = async (userId, jobId, rawResults) => {
  return patchRedisJob(userId, jobId, {
    tavily: { rawResults },
    workerState: {
      currentStep: 'tavily_search',
      progress: 0.5,
      updatedAt: nowIso(),
    },
  });
};

export const writeRefinerToRedis = async (userId, jobId, refinerOutput) => {
  return patchRedisJob(userId, jobId, {
    refiner: {
      compressedFacts: refinerOutput.compressedFacts || [],
      sourcesPreview: refinerOutput.sourcesPreview || [],
      tables: refinerOutput.tables || [],
      isContextRelevant: refinerOutput.isContextRelevant ?? true,
    },
    workerState: {
      currentStep: 'refiner',
      progress: 0.8,
      updatedAt: nowIso(),
    },
  });
};

export const setJobError = async (userId, jobId, message, step) => {
  return patchRedisJob(userId, jobId, {
    status: 'failed',
    error: { message, step },
    workerState: {
      currentStep: step,
      updatedAt: nowIso(),
    },
  });
};

const buildFirestorePayload = (job, finalStatus) => {
  const timestamp = nowIso();
  return {
    jobId: job.jobId,
    companyId: job.companyId,
    userId: job.userId,
    topic: job.topic,
    status: finalStatus,
    language: job.language,
    platform: job.platform,
    action: job.action,
    createdAt: job.createdAt || timestamp,
    updatedAt: timestamp,
    workerState: {
      ...job.workerState,
      currentStep: finalStatus === 'completed' ? 'done' : job.workerState?.currentStep,
      progress: finalStatus === 'completed' ? 1.0 : job.workerState?.progress,
      updatedAt: timestamp,
    },
    research: {
      shaping: job.shaping,
      tavily: job.tavily,
      refiner: job.refiner,
    },
    tones: job.tones,
    error: job.error?.message ? job.error : null,
  };
};

export const consolidateToFirestore = async (userId, jobId, finalStatus = 'completed') => {
  const job = await getRedisJob(userId, jobId);
  if (!job) throw new Error(`Impossibile consolidare: job ${jobId} assente da Redis.`);

  const payload = buildFirestorePayload(job, finalStatus);
  await db.collection('contents').doc(jobId).set(payload, { merge: true });
  await deleteRedisJob(userId, jobId);
  console.log(`[WORKER][${jobId}] Record portato su Firestore (status: ${finalStatus}) e rimosso da Redis.`);
  return payload;
};

export const failAndConsolidate = async (userId, jobId, message, step, status = 'failed') => {
  try {
    const existing = await getRedisJob(userId, jobId);
    if (existing) {
      await patchRedisJob(userId, jobId, {
        status,
        error: { message, step },
        workerState: { currentStep: step, updatedAt: nowIso() },
      });
      return consolidateToFirestore(userId, jobId, status);
    }
  } catch (err) {
    console.error(`❌ failAndConsolidate(${jobId}):`, err.message);
  }

  await db.collection('contents').doc(jobId).set({
    jobId,
    userId,
    status,
    error: { message, step },
    updatedAt: nowIso(),
  }, { merge: true });
};

export const getFirestoreJob = async (jobId) => {
  const snap = await db.collection('contents').doc(jobId).get();
  return snap.exists ? snap.data() : null;
};

export const hydrateRedisFromFirestore = async (userId, jobId) => {
  const fs = await getFirestoreJob(jobId);
  if (!fs) return null;

  const job = {
    jobId: fs.jobId || jobId,
    companyId: fs.companyId,
    userId: fs.userId || userId,
    topic: fs.topic,
    status: fs.status,
    language: fs.language,
    platform: fs.platform,
    action: fs.action || 'standard',
    createdAt: fs.createdAt,
    updatedAt: nowIso(),
    shaping: fs.research?.shaping || fs.shaping || { suggestedQueries: [] },
    tavily: fs.research?.tavily || fs.tavily || { rawResults: [] },
    refiner: fs.research?.refiner || fs.refiner || { compressedFacts: [], sourcesPreview: [], tables: [] },
    workerState: fs.workerState || { currentStep: 'done', progress: 1, retryCount: 0, updatedAt: nowIso() },
    error: fs.error || { message: null, step: null },
    tones: fs.tones || buildEmptyTones(),
  };

  await redisConnection.set(redisKey(userId, jobId), JSON.stringify(job), 'EX', REDIS_TTL);
  return job;
};

export const getJobState = async (userId, jobId) => {
  const redis = await getRedisJob(userId, jobId);
  if (redis) return redis;
  return getFirestoreJob(jobId);
};

export const getJobStatusForClient = async (userId, jobId) => {
  let job = await getRedisJob(userId, jobId);
  if (!job) job = await getFirestoreJob(jobId);
  if (!job) return null;

  const workerState = job.workerState || {
    currentStep: 'query_shaping',
    progress: 0,
    retryCount: 0,
    updatedAt: job.updatedAt,
  };

  const status = job.status;
  const isDone = status === 'completed' || status === 'blocked';

  const response = {
    jobId,
    status,
    topic: job.topic,
    platform: normalizePlatform(job.platform),
    language: job.language,
    action: job.action,
    workerState: {
      ...workerState,
      step: isDone ? 'done' : workerState.currentStep,
      progress: isDone ? 1 : workerState.progress,
    },
    error: job.error?.message ? job.error : null,
  };

  const shaping = job.shaping || job.research?.shaping;
  const tavily = job.tavily || job.research?.tavily;
  const refiner = job.refiner || job.research?.refiner;

  if (shaping || tavily || refiner) {
    response.research = {};
    if (shaping) response.research.shaping = shaping;
    if (tavily) response.research.tavily = tavily;
    if (refiner) response.research.refiner = refiner;
  }

  if (job.tones && Object.keys(job.tones).length > 0) {
    response.tones = job.tones;
  }

  if (job.shaping?.is_blocked) {
    response.blocked = true;
    response.block_message = job.shaping.block_message;
  }

  return response;
};

export const updateToneTextOnFirestore = async (jobId, toneKey, text) => {
  const fs = await getFirestoreJob(jobId);
  if (!fs?.tones?.[toneKey]) throw new Error(`Tono ${toneKey} non trovato.`);

  const tone = { ...fs.tones[toneKey], text: String(text) };
  if (tone.version === 0 && text) tone.version = 1;

  await db.collection('contents').doc(jobId).set({
    [`tones.${toneKey}`]: tone,
    updatedAt: nowIso(),
  }, { merge: true });
};

export const updateToneOnRedis = async (userId, jobId, toneKey, text) => {
  const job = await getRedisJob(userId, jobId);
  if (!job) return updateToneTextOnFirestore(jobId, toneKey, text);

  const tones = { ...job.tones };
  if (!tones[toneKey]) throw new Error(`Tono ${toneKey} non trovato.`);
  tones[toneKey] = { ...tones[toneKey], text: String(text) };
  if (tones[toneKey].version === 0 && text) tones[toneKey].version = 1;

  return patchRedisJob(userId, jobId, { tones });
};

export const writeGeneratedTone = async (userId, jobId, toneKey, text, { instructions = '' } = {}) => {
  const job = await getRedisJob(userId, jobId);
  if (!job) throw new Error('Job non in Redis — rigenerazione richiede job attivo o re-idratazione.');

  const tones = { ...job.tones };
  const prev = tones[toneKey] || { status: 'ON', lock_reason: '', version: 0, type: 'generation' };
  const nextVersion = prev.version > 0 ? prev.version + 1 : 1;

  tones[toneKey] = {
    ...prev,
    text,
    version: nextVersion,
    type: instructions.trim() ? 'regeneration' : 'generation',
  };

  return patchRedisJob(userId, jobId, {
    tones,
    status: 'generating',
    workerState: { currentStep: 'generation', progress: 0.9, updatedAt: nowIso() },
  });
};

export { MAX_INSTRUCTIONS_LENGTH, REDIS_TTL };
