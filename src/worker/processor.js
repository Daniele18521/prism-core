/**
 * WORKER CORE: PRISM PIPELINE ENGINERING
 * Scopo: Gestire la coda asincrona di BullMQ per l'elaborazione dei post.
 */

import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import redisConnection from '../utils/redis.js'; 
import { updateJobState, getJobState } from '../services/stateManager.js'; 
import { generateQueries } from '../services/shaper.js'; 
import { performWebSearch } from '../services/search.js'; 
import { refineResults } from '../services/refiner.js'; 
import { generateTones } from '../services/generator.js'; 
import { db, FieldValue } from '../utils/firebaseAdmin.js';

dotenv.config();

const QUEUE_NAME = 'prism-jobs'; 
const IS_MOCK_ENABLED = process.env.USE_MOCK_GENERATOR === 'true';

// Helper Mock aggiornato
const getMockOutput = (stage, topic) => {
  const mocks = {
    query_shaping: ["strategia per " + topic, "trend 2026 " + topic],
    tavily_search: { sources: [{ title: "Mock Source", url: "https://example.com", score: 0.95 }] },
    refiner: {
      isContextRelevant: true,
      data: {
        SCENARIO: "Dati quantitativi mock: +15% crescita.",
        CONTESTO: "Analisi qualitativa: trend in ascesa.",
        SFIDE: "Criticità: colli di bottiglia normativi."
      },
      verifiedImages: [{ url: "https://picsum.photos/400/300", altText: "Immagine Mock" }]
    }
  };
  return mocks[stage];
};

const worker = new Worker(QUEUE_NAME, async (job) => {
  const { userId, companyId, topic, platform, language, maxChars, toneKey, action, parentJobId } = job.data; 
  const jobId = job.id; 
  const isMock = IS_MOCK_ENABLED;

  console.log(`🚀 [WORKER] Job Iniziato. ID: ${jobId} | Azione: ${action || 'standard'}`);

  const targetJobId = action === 'regen_tone' ? parentJobId : jobId;
  const standardRedisKey = `${userId}:jobs:${targetJobId}`;

  let currentState = await getJobState(userId, targetJobId);
  
  if (!currentState && action !== 'regen_tone') {
    currentState = await updateJobState(userId, targetJobId, {
      status: 'running',
      input: { topic, platform, language: language || 'italiano', maxChars }
    });
  }
  
  try {
    // =========================================================================
    // 🎯 DEVIAZIONE CHIRURGICA: RIGENERAZIONE SINGOLO TONO
    // =========================================================================
    if (action === 'regen_tone' && toneKey) {
      console.log(`🎯 Rigenerazione Tono: [${toneKey}]`);
      
      currentState = await updateJobState(userId, targetJobId, {
        status: 'generating',
        pipeline: { step: 'generation', progress: 0.50, message: `F4: Rigenerazione ${toneKey.toUpperCase()}...` }
      });

      // ESTRAZIONE SICURA: Recuperiamo i dati raffinati dallo stato interno
      const refinedDataForRegen = currentState?.internal_data?.refinedData || {};
      const sourcesPreview = currentState?.sources_preview || [];
      const verifiedImages = currentState?.internal_data?.verifiedImages || [];
      const originalInput = currentState?.input || { topic, platform, language, maxChars };

      const singleGeneratedOutput = await generateTones(
        { ...originalInput, singleToneTarget: toneKey }, 
        refinedDataForRegen, // Corretto: passiamo l'oggetto
        sourcesPreview,
        verifiedImages
      );

      const newText = singleGeneratedOutput[toneKey]?.text || singleGeneratedOutput?.text;
      if (!newText) throw new Error(`Errore generazione testo per: ${toneKey}`);

      const parentDataRaw = await redisConnection.get(standardRedisKey);
      let parentData = parentDataRaw ? JSON.parse(parentDataRaw) : {};

      if (!parentData.tones?.[toneKey]) throw new Error(`Tono ${toneKey} non trovato.`);

      if (!parentData.storico) parentData.storico = {};
      if (!Array.isArray(parentData.storico[toneKey])) parentData.storico[toneKey] = [];

      parentData.storico[toneKey].push({
        version: parentData.tones[toneKey].version || 1,
        text: parentData.tones[toneKey].text,
        timestamp: new Date().toISOString()
      });

      parentData.tones[toneKey] = {
        ...parentData.tones[toneKey],
        text: newText,
        status: 'done',
        is_regenerated: true,
        version: (parentData.tones[toneKey].version || 1) + 1,
        last_updated: new Date().toISOString()
      };

      parentData.status = 'completed';
      await redisConnection.set(standardRedisKey, JSON.stringify(parentData), 'EX', 86400);

      const contentRef = db.collection('contents').doc(targetJobId);
      await contentRef.set({ testo: parentData }, { merge: true });
      return; 
    }

    // =========================================================================
    // 🔄 FLUSSO STANDARD (F1 -> F4)
    // =========================================================================

    // --- F1: QUERY SHAPING ---
    if (!currentState.internal_data?.queries) {
      const queries = isMock ? getMockOutput('query_shaping', topic) : await generateQueries(topic);
      currentState = await updateJobState(userId, targetJobId, {
        internal_data: { ...currentState.internal_data, queries },
        pipeline: { step: 'query_shaping', progress: 0.15, message: 'F1 completata.' }
      });
    }

    // --- F2: SEARCH ---
    if (!currentState.internal_data?.rawSources) {
      const { sources } = isMock ? getMockOutput('tavily_search') : await performWebSearch(currentState.internal_data.queries);
      currentState = await updateJobState(userId, targetJobId, {
        sources_preview: sources.slice(0, 5).map(s => ({ title: s.title, url: s.url })),
        internal_data: { ...currentState.internal_data, rawSources: sources },
        pipeline: { step: 'tavily_search', progress: 0.40, message: 'F2 completata.' }
      });
    }

    // --- F3: REFINER (TASSONOMIA) ---
    // NOTA: Cambiato il controllo da verifiedFacts a refinedData
    if (!currentState.internal_data?.refinedData) {
      currentState = await updateJobState(userId, targetJobId, {
        pipeline: { step: 'compression', progress: 0.70, message: 'F3: Raffinazione dati...' }
      });
    
      const refinedOutput = isMock ? getMockOutput('refiner') : await refineResults(topic, currentState.internal_data.rawSources);

      currentState = await updateJobState(userId, targetJobId, {
        internal_data: { 
          ...currentState.internal_data, 
          refinedData: refinedOutput.data, // Scenario, Contesto, Sfide
          verifiedImages: refinedOutput.verifiedImages || [],
          isContextRelevant: refinedOutput.isContextRelevant
        }
      });
    }

    // --- F4: GENERATION ---
    const hasTonesGenerated = currentState.tones && 
      Object.values(currentState.tones).some(tone => tone.text && tone.text.trim() !== "");

    if (!hasTonesGenerated) {
      currentState = await updateJobState(userId, targetJobId, {
        status: 'generating',
        pipeline: { step: 'generation', progress: 0.90, message: `F4: Scrittura contenuti...` }
      });

      // ESTRAZIONE SICURA DELLE PROPRIETÀ DALLO STATO
      const refinedDataForGen = currentState.internal_data?.refinedData || {};
      const verifiedImages = currentState.internal_data?.verifiedImages || [];

      const generatedData = await generateTones(
        currentState.input, 
        refinedDataForGen, // Passiamo l'oggetto estratto
        currentState.sources_preview,
        verifiedImages
      );

      const updatedTones = {};
      for (const tKey of Object.keys(generatedData)) {
        updatedTones[tKey] = {
          status: 'done',
          text: generatedData[tKey].text,
          authority: generatedData[tKey].authority || 'medium',
          version: 1,
          last_updated: new Date().toISOString()
        };
      }

      currentState = await updateJobState(userId, targetJobId, {
        tones: updatedTones
      });
    }

    // --- FINALIZZAZIONE ---
    const finalState = await updateJobState(userId, targetJobId, {
      status: 'completed',
      pipeline: { step: 'done', progress: 1.0, message: 'Completato!' }
    });

    await redisConnection.expire(standardRedisKey, 86400);

    const firestoreData = { ...finalState };
    if (firestoreData.internal_data) delete firestoreData.internal_data.rawSources;

    await db.collection('contents').doc(targetJobId).set({
      company_id: companyId,
      user_id: userId,
      testo: firestoreData,
      media_support: { verified_images: currentState.internal_data?.verifiedImages || [] },
      created_at: FieldValue.serverTimestamp()
    });

  } catch (err) {
    console.error(`❌ Errore nel Worker:`, err.message);
    await updateJobState(userId, targetJobId, { 
      status: 'failed', 
      error: { message: err.message, step: currentState?.pipeline?.step } 
    });
    throw err; 
  }
}, { connection: redisConnection, concurrency: 1 });