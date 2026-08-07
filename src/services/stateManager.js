/**
 * STATE MANAGER — gestisce dove vivono i dati del job durante e dopo l'elaborazione.
 *
 * Due "posti" per i dati:
 * - REDIS = memoria veloce, temporanea (mentre il worker lavora) — date in ISO string
 * - FIRESTORE = database permanente (quando il job è finito) — date in Timestamp nativo
 *
 * Flusso tipico:
 * 1. API crea job in Redis (initializeRedisJob)
 * 2. Worker aggiorna Redis ad ogni fase (writeContentIngest, writeShaping, writeTavily, writeRefiner...)
 * 3. A fine job → consolidateToFirestore copia tutto su Firestore (date → Timestamp) e cancella Redis
 */

import redisConnection from '../utils/redis.js';
// Timestamp nativo Firestore per query range; Redis resta su ISO string
import { db, Timestamp } from '../utils/firebaseAdmin.js';
// Utility errori: log strutturato + stati terminali job
import { isTerminalJobStatus, logError } from '../utils/errors.js';
// Rileva URL in input per impostare lo step iniziale F0 (content_ingest)
import { isUrlInput } from './contentIngest.js';

// Riesportiamo isTerminalJobStatus così il worker può usarlo senza import doppio
export { isTerminalJobStatus };

// Lista dei toni editoriali supportati da PRISM (catalogo prodotto)
export const TONE_IDS = [
  'provocatore',
  'confidente',
  'sferzante',
  'visionario',
  'metodologico',
  'narratore',
  'promotore',
  'informatore',
];

const REDIS_TTL = 86400; // job in Redis scadono dopo 24 ore se non consolidati
const MAX_INSTRUCTIONS_LENGTH = 100; // limite caratteri istruzioni rigenerazione tono

/** Chiavi data: su Firestore → Timestamp; su Redis/API → ISO string */
const DATE_KEYS = new Set(['createdAt', 'updatedAt', 'extractedAt', 'retrievedAt']);

/** Normalizza nome piattaforma (es. "linkedin" → "LinkedIn") per coerenza in DB */
export const normalizePlatform = (platform) => {
  const map = {
    linkedin: 'LinkedIn',
    instagram: 'Instagram',
    ig: 'Instagram',
    facebook: 'Facebook',
    x: 'X',
    twitter: 'X',
    carosello: 'Carosello',
    carousel: 'Carosello',
    general: 'LinkedIn',
  };
  return map[(platform || 'general').toLowerCase().trim()] || platform;
};

/** ISO string per Redis/JSON (il job in elaborazione non può tenere Timestamp) */
const nowIso = () => new Date().toISOString();
/** Timestamp Firestore “adesso” per scritture dirette su contents */
const nowFs = () => Timestamp.now();
const redisKey = (userId, jobId) => `${userId}:jobs:${jobId}`; // chiave univoca job in Redis

/**
 * Converte un valore data in Timestamp Firestore (scrittura DB permanente).
 * Accetta ISO string, Date, millis, Timestamp già pronto; null resta null.
 */
export const toFirestoreTimestamp = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Timestamp) return value;
  // Oggetto Timestamp serializzato da SDK (toDate/toMillis)
  if (typeof value?.toDate === 'function' && typeof value?.toMillis === 'function') {
    return value instanceof Timestamp ? value : Timestamp.fromMillis(value.toMillis());
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : Timestamp.fromDate(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Timestamp.fromMillis(value);
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
  }
  return null;
};

/**
 * Converte Timestamp (o Date) in ISO string per Redis e risposte API.
 * Se è già stringa, la lascia com’è.
 */
export const toIsoString = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
};

/** True se sembra un Timestamp Firestore (anche da snap.data()) */
const isFirestoreTimestamp = (value) =>
  value instanceof Timestamp ||
  (value &&
    typeof value === 'object' &&
    typeof value.toDate === 'function' &&
    typeof value.toMillis === 'function');

/**
 * Percorre l’oggetto e converte solo le chiavi data note (createdAt, updatedAt, …).
 * @param {*} input
 * @param {(v: *) => *} convert — toFirestoreTimestamp oppure toIsoString
 */
export const mapDateFieldsDeep = (input, convert) => {
  if (Array.isArray(input)) {
    return input.map((item) => mapDateFieldsDeep(item, convert));
  }
  if (isFirestoreTimestamp(input)) {
    return convert(input);
  }
  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(input)) {
      if (DATE_KEYS.has(key)) {
        out[key] = convert(val);
      } else if (val && typeof val === 'object') {
        out[key] = mapDateFieldsDeep(val, convert);
      } else {
        out[key] = val;
      }
    }
    return out;
  }
  return input;
};

/** Crea struttura toni vuota: tutti OFF, testo vuoto, versione 0 */
export const buildEmptyTones = (toneIds = TONE_IDS) => {
  const tones = {};
  for (const id of toneIds) {
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

// Gemini a volte usa nomi diversi (es. "il_provocatore") → mappiamo al nome canonico
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
  promotore: 'promotore',
  il_promotore: 'promotore',
  informatore: 'informatore',
  l_informatore: 'informatore',
};

/** Converte l'output toni dello Shaper (F1) nella struttura usata dal worker e Firestore */
export const buildTonesFromSuitability = (toneSuitability = {}, enabledToneIds = null) => {
  // Se F1 ha già filtrato per company, usa quelle chiavi; altrimenti catalogo pieno
  const ids =
    Array.isArray(enabledToneIds) && enabledToneIds.length > 0
      ? enabledToneIds
      : Object.keys(toneSuitability).length > 0
        ? Object.keys(toneSuitability)
        : TONE_IDS;
  const tones = buildEmptyTones(ids);
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

/** Unisce patch nel job esistente senza sovrascrivere interi oggetti annidati (shaping, tones...) */
const deepMerge = (base, patch) => {
  const out = { ...base, ...patch };
  for (const key of ['shaping', 'tavily', 'refiner', 'contentIngest', 'sourceMeta', 'workerState', 'error', 'tones']) {
    if (patch[key] !== undefined) {
      out[key] = { ...(base[key] || {}), ...patch[key] };
    }
  }
  return out;
};

/**
 * Crea un nuovo job in Redis quando l'API riceve una richiesta.
 * Stato iniziale: pending, shaping vuoto, toni tutti OFF.
 */
export const initializeRedisJob = async (userId, jobId, {
  companyId,
  topic,
  platform = 'general',
  language = 'italiano',
  outputFormat = 'text',
  action,
}) => {
  const timestamp = nowIso();
  // Capisce se l'utente ha incollato un URL (attiva F0 nel worker)
  const inputType = isUrlInput(topic) ? 'url' : 'text';
  // Step iniziale mostrato al frontend durante il polling
  const initialStep = inputType === 'url' ? 'content_ingest' : 'query_shaping';
  const job = {
    jobId,
    companyId,
    userId,
    topic,
    // Conserva l'input originale (URL o testo) per audit e UI "basato su..."
    originalInput: topic,
    inputType,
    sourceMeta: null,
    status: inputType === 'url' ? 'ingesting' : 'pending',
    language,
    platform: normalizePlatform(platform),
    outputFormat: String(outputFormat || 'text').toLowerCase().trim() || 'text',
    action: action || 'standard',
    createdAt: timestamp,
    updatedAt: timestamp,
    contentIngest: {
      updatedAt: null,
      sourceUrl: inputType === 'url' ? String(topic).trim() : null,
    },
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
      currentStep: initialStep,
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

/** Legge il job da Redis. Restituisce null se non esiste o se i dati sono corrotti */
export const getRedisJob = async (userId, jobId) => {
  const raw = await redisConnection.get(redisKey(userId, jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw); // converte stringa JSON salvata in Redis → oggetto
  } catch (err) {
    // Dati corrotti in Redis (raro): meglio cancellare che crashare tutto il worker
    logError('stateManager:getRedisJob', err, { jobId, userId });
    await deleteRedisJob(userId, jobId).catch(() => {});
    return null;
  }
};

/** Aggiorna parzialmente un job in Redis (merge, non sostituzione totale) */
export const patchRedisJob = async (userId, jobId, patch) => {
  const current = await getRedisJob(userId, jobId);
  if (!current) throw new Error(`Job Redis non trovato: ${jobId}`);

  const merged = deepMerge(current, { ...patch, updatedAt: nowIso() });
  await redisConnection.set(redisKey(userId, jobId), JSON.stringify(merged), 'EX', REDIS_TTL);
  return merged;
};

/** Rimuove il job da Redis (dopo consolidamento su Firestore) */
export const deleteRedisJob = async (userId, jobId) => {
  await redisConnection.del(redisKey(userId, jobId));
};

/** Salva output F0 (Content Ingest): testo estratto da URL e metadati sorgente */
export const writeContentIngestToRedis = async (userId, jobId, ingestOutput) => {
  return patchRedisJob(userId, jobId, {
    // Il topic diventa il testo pulito per F1→F4 (l'URL resta in originalInput/sourceMeta)
    topic: ingestOutput.topic,
    originalInput: ingestOutput.originalInput,
    inputType: ingestOutput.inputType,
    sourceMeta: ingestOutput.sourceMeta,
    contentIngest: {
      updatedAt: nowIso(),
      sourceUrl: ingestOutput.sourceMeta?.url || null,
      sourceTitle: ingestOutput.sourceMeta?.title || '',
      charCount: ingestOutput.sourceMeta?.charCount || 0,
      truncated: ingestOutput.sourceMeta?.truncated || false,
    },
    workerState: {
      currentStep: 'query_shaping',
      progress: 0.12,
      updatedAt: nowIso(),
    },
    // F0 completato → il job rientra nel flusso standard "running"
    status: 'running',
  });
};

/** Salva output F1 (Shaper): diagnosi GAP, plan query, toni ON/OFF */
export const writeShapingToRedis = async (userId, jobId, shaperOutput) => {
  // Se non serve ricerca web, plan e suggestedQueries devono restare vuoti
  const searchRequired = shaperOutput.search_required !== false;
  const plan = searchRequired ? (shaperOutput.plan || []) : [];
  const suggestedQueries = plan.map((p) => p.query).filter(Boolean);
  const tones = buildTonesFromSuitability(shaperOutput.tone_suitability);

  return patchRedisJob(userId, jobId, {
    shaping: {
      is_blocked: shaperOutput.is_blocked,
      block_message: shaperOutput.block_message || '',
      diagnosi: shaperOutput.diagnosi || {},
      search_required: searchRequired,
      tone_suitability: shaperOutput.tone_suitability || {},
      plan,
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

/** Salva output F2 (Tavily): fonti web trovate con ID S1, S2... */
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

/** Salva output F3 (Refiner): 3 blocchi SCENARIO/CONTESTO/SFIDE_OPPORTUNITA */
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

/** Segna il job come failed in Redis (prima del consolidamento su Firestore) */
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

/**
 * Trasforma il job Redis nel formato documento Firestore (collection: contents).
 * Tutte le chiavi data diventano Timestamp nativi (query range <= / >=).
 */
const buildFirestorePayload = (job, finalStatus) => {
  const timestamp = nowIso(); // ancora ISO in bozza; conversione sotto
  const payload = {
    jobId: job.jobId,
    companyId: job.companyId,
    userId: job.userId,
    topic: job.topic,
    originalInput: job.originalInput || job.topic,
    inputType: job.inputType || 'text',
    sourceMeta: job.sourceMeta || null,
    status: finalStatus,
    language: job.language,
    platform: job.platform,
    outputFormat: job.outputFormat || 'text',
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
      contentIngest: job.contentIngest || null,
      shaping: job.shaping,
      tavily: job.tavily,
      refiner: job.refiner,
    },
    tones: job.tones,
    error: job.error?.message ? job.error : null,
  };
  // ISO (e nested extractedAt/retrievedAt) → Timestamp prima del .set
  return mapDateFieldsDeep(payload, toFirestoreTimestamp);
};

/**
 * Prova a cancellare il job da Redis più volte.
 * Perché: a volte la rete cade proprio nel momento del delete dopo il salvataggio su Firestore.
 * Senza retry resterebbe duplicato (sia Redis che Firestore).
 */
const retryDeleteRedis = async (userId, jobId, maxAttempts = 3) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await deleteRedisJob(userId, jobId);
      return;
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err; // ultimo tentativo fallito → lancia errore
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); // aspetta e riprova
    }
  }
};

/**
 * Fine pipeline: copia tutto da Redis (veloce) a Firestore (permanente) e cancella Redis.
 * Firestore = database definitivo dove il frontend legge i risultati.
 */
export const consolidateToFirestore = async (userId, jobId, finalStatus = 'completed') => {
  const job = await getRedisJob(userId, jobId);
  if (!job) throw new Error(`Impossibile consolidare: job ${jobId} assente da Redis.`);

  const payload = buildFirestorePayload(job, finalStatus);
  await db.collection('contents').doc(jobId).set(payload, { merge: true });
  await retryDeleteRedis(userId, jobId);
  console.log(`[WORKER][${jobId}] Record portato su Firestore (status: ${finalStatus}) e rimosso da Redis.`);
  return payload;
};

/**
 * Quando un job fallisce: salva l'errore e sposta tutto su Firestore.
 *
 * Restituisce { persisted: true/false } così il worker sa se ha senso riprovare.
 * Se persisted=true, il job è chiuso → NON rilanciare l'errore a BullMQ (evita retry inutili).
 */
export const failAndConsolidate = async (userId, jobId, message, step, status = 'failed') => {
  try {
    const existing = await getRedisJob(userId, jobId);
    if (existing) {
      await patchRedisJob(userId, jobId, {
        status,
        error: { message, step },
        workerState: { currentStep: step, updatedAt: nowIso() },
      });
      await consolidateToFirestore(userId, jobId, status);
      return { persisted: true, source: 'redis' };
    }
  } catch (err) {
    logError('stateManager:failAndConsolidate', err, { jobId, step });
  }

  try {
    // Fallback diretto su FS: anche qui Timestamp, non ISO string
    await db.collection('contents').doc(jobId).set({
      jobId,
      userId,
      status,
      error: { message, step },
      updatedAt: nowFs(),
    }, { merge: true });
    await deleteRedisJob(userId, jobId).catch(() => {});
    return { persisted: true, source: 'firestore' };
  } catch (err) {
    logError('stateManager:failAndConsolidate:fallback', err, { jobId, step });
    return { persisted: false, source: 'none', error: err.message };
  }
};

/**
 * Legge un job già consolidato da Firestore (dopo che Redis è stato cancellato).
 * Converte Timestamp → ISO così Redis/API restano serializzabili in JSON.
 */
export const getFirestoreJob = async (jobId) => {
  const snap = await db.collection('contents').doc(jobId).get();
  if (!snap.exists) return null;
  return mapDateFieldsDeep(snap.data(), toIsoString);
};

/**
 * Ricopia un job da Firestore a Redis.
 * Serve per rigenerare un tono su un job già completato (regen_tone).
 */
export const hydrateRedisFromFirestore = async (userId, jobId) => {
  const fs = await getFirestoreJob(jobId);
  if (!fs) return null;

  const job = {
    jobId: fs.jobId || jobId,
    companyId: fs.companyId,
    userId: fs.userId || userId,
    topic: fs.topic,
    originalInput: fs.originalInput || fs.topic,
    inputType: fs.inputType || 'text',
    sourceMeta: fs.sourceMeta || null,
    status: fs.status,
    language: fs.language,
    platform: fs.platform,
    outputFormat: fs.outputFormat || 'text',
    action: fs.action || 'standard',
    createdAt: fs.createdAt,
    updatedAt: nowIso(),
    contentIngest: fs.research?.contentIngest || fs.contentIngest || { updatedAt: null },
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

/** Cerca job prima in Redis (in corso), poi in Firestore (completato) */
export const getJobState = async (userId, jobId) => {
  const redis = await getRedisJob(userId, jobId);
  if (redis) return redis;
  return getFirestoreJob(jobId);
};

/** Formatta lo stato job per il frontend (polling /jobs/status) */
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
    originalInput: job.originalInput || job.topic,
    inputType: job.inputType || 'text',
    sourceMeta: job.sourceMeta || null,
    platform: normalizePlatform(job.platform),
    language: job.language,
    outputFormat: job.outputFormat || 'text',
    action: job.action,
    workerState: {
      ...workerState,
      step: isDone ? 'done' : workerState.currentStep,
      progress: isDone ? 1 : workerState.progress,
    },
    error: job.error?.message ? job.error : null,
  };

  const contentIngest = job.contentIngest || job.research?.contentIngest;
  const shaping = job.shaping || job.research?.shaping;
  const tavily = job.tavily || job.research?.tavily;
  const refiner = job.refiner || job.research?.refiner;

  if (contentIngest || shaping || tavily || refiner) {
    response.research = {};
    if (contentIngest) response.research.contentIngest = contentIngest;
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

/** Aggiorna testo tono direttamente su Firestore (job già consolidato) */
export const updateToneTextOnFirestore = async (jobId, toneKey, text) => {
  const fs = await getFirestoreJob(jobId);
  if (!fs?.tones?.[toneKey]) throw new Error(`Tono ${toneKey} non trovato.`);

  const tone = { ...fs.tones[toneKey], text: String(text) };
  if (tone.version === 0 && text) tone.version = 1;

  await db.collection('contents').doc(jobId).set({
    [`tones.${toneKey}`]: tone,
    updatedAt: nowFs(),
  }, { merge: true });
};

/** Aggiorna testo tono: su Redis se job attivo, altrimenti su Firestore */
export const updateToneOnRedis = async (userId, jobId, toneKey, text) => {
  const job = await getRedisJob(userId, jobId);
  if (!job) return updateToneTextOnFirestore(jobId, toneKey, text);

  const tones = { ...job.tones };
  if (!tones[toneKey]) throw new Error(`Tono ${toneKey} non trovato.`);
  tones[toneKey] = { ...tones[toneKey], text: String(text) };
  if (tones[toneKey].version === 0 && text) tones[toneKey].version = 1;

  return patchRedisJob(userId, jobId, { tones });
};

/** Salva testo generato/rigenerato per un singolo tono e incrementa version */
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
