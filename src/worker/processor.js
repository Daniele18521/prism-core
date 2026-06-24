/**
 * WORKER — Macchina a stati Redis → consolidamento Firestore a fine processo.
 */

import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import redisConnection from '../utils/redis.js';
import {
  getRedisJob,
  patchRedisJob,
  writeShapingToRedis,
  writeTavilyToRedis,
  writeRefinerToRedis,
  consolidateToFirestore,
  failAndConsolidate,
  hydrateRedisFromFirestore,
  writeGeneratedTone,
  TONE_IDS,
  normalizePlatform,
} from '../services/stateManager.js';
import { runShaperGatekeeper } from '../services/shaper.js';
import { performWebSearch } from '../services/search.js';
import { refineResults } from '../services/refiner.js';
import { generateTones } from '../services/generator.js';

dotenv.config();

const QUEUE_NAME = 'prism-jobs';
const IS_MOCK = process.env.USE_MOCK_GENERATOR === 'true';

const mockShaper = (topic) => ({
  is_blocked: false,
  block_message: '',
  diagnosi: { scenario: 'GAP', context: 'GAP', sfide_opportunita: 'GAP' },
  search_required: true,
  tone_suitability: {
    provocatore: { status: 'ON', lock_reason: '' },
    confidente: { status: 'ON', lock_reason: '' },
    sferzante: { status: 'ON', lock_reason: '' },
    visionario: { status: 'ON', lock_reason: '' },
    metodologico: { status: 'ON', lock_reason: '' },
    narratore: { status: 'ON', lock_reason: '' },
  },
  plan: [
    { pillar: 'SCENARIO', query: `statistiche ${topic} ${new Date().getFullYear()}` },
    { pillar: 'CONTESTO', query: `trend ${topic} ${new Date().getFullYear() - 1}` },
    { pillar: 'SFIDE_OPPORTUNITA', query: `criticità ${topic} ${new Date().getFullYear()}` },
  ],
});

const mockTavily = () => ({
  rawResults: [{
    title: 'Mock Source',
    url: 'https://example.com',
    content: 'Contenuto mock.',
    retrievedAt: new Date().toISOString(),
    pillar: 'SCENARIO',
  }],
});

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

const worker = new Worker(QUEUE_NAME, async (job) => {
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

  const jobId = job.id;
  const targetJobId = action === 'regen_tone' ? parentJobId : jobId;
  const uid = userId;

  console.log(`🚀 [WORKER][${targetJobId}] Azione: ${action || 'standard'}`);

  let state = null;

  try {
    // -------------------------------------------------------------------------
    // RIGENERAZIONE SINGOLO TONO (post-consolidamento Firestore)
    // -------------------------------------------------------------------------
    if (action === 'regen_tone' && toneKey) {
      state = await getRedisJob(uid, targetJobId);
      if (!state) state = await hydrateRedisFromFirestore(uid, targetJobId);
      if (!state) throw new Error(`Job ${targetJobId} non trovato.`);

      const tone = state.tones?.[toneKey];
      if (!tone || tone.status !== 'ON') {
        throw new Error(`Tono ${toneKey} non idoneo (status OFF o assente).`);
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
      if (!newText) throw new Error(`Generazione fallita per tono: ${toneKey}`);

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
      throw new Error(`Job Redis ${targetJobId} non trovato. Deve essere creato dall'API.`);
    }

    await patchRedisJob(uid, targetJobId, { status: 'running' });

    // -------------------------------------------------------------------------
    // F1 — SHAPER & GATEKEEPER
    // -------------------------------------------------------------------------
    if (!state.shaping?.plan?.length && !state.shaping?.is_blocked) {
      console.log(`🧠 [WORKER][${targetJobId}] F1 Shaper...`);

      const shaperOut = IS_MOCK ? mockShaper(topic) : await runShaperGatekeeper(topic);
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
    const searchRequired = state.shaping?.search_required !== false;
    const plan = state.shaping?.plan || [];

    // -------------------------------------------------------------------------
    // F2 — TAVILY (condizionale)
    // -------------------------------------------------------------------------
    if (searchRequired && !state.tavily?.rawResults?.length) {
      console.log(`🌐 [WORKER][${targetJobId}] F2 Search...`);
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
    const tonesOn = TONE_IDS.filter((id) => state.tones?.[id]?.status === 'ON');
    const needsGeneration = tonesOn.some((id) => !state.tones[id]?.text?.trim());

    if (needsGeneration) {
      console.log(`🎨 [WORKER][${targetJobId}] F4 Generation (${tonesOn.length} toni ON)...`);

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

      await patchRedisJob(uid, targetJobId, { tones });
    }

    await patchRedisJob(uid, targetJobId, {
      status: 'completed',
      workerState: { currentStep: 'done', progress: 1.0, updatedAt: new Date().toISOString() },
    });

    await consolidateToFirestore(uid, targetJobId, 'completed');
    console.log(`[WORKER][${targetJobId}] Pipeline completata. Consolidato su Firestore.`);

  } catch (err) {
    console.error(`❌ [WORKER][${targetJobId}]`, err.message);
    try {
      const step = state?.workerState?.currentStep || 'unknown';
      await failAndConsolidate(uid, targetJobId, err.message, step, 'failed');
    } catch (persistErr) {
      console.error(`❌ Persistenza errore fallita:`, persistErr.message);
    }
    throw err;
  }
}, { connection: redisConnection, concurrency: 1 });

console.log('🚀 Worker PRISM operativo (Redis online → Firestore consolidato).');
