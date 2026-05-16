/**
 * --- WORKER PRISM (FONDAMENTA OPERATIVE RE-INGEGNERIZZATE) ---
 * Gestisce il ciclo di vita del Job: dall'analisi del topic alla generazione finale.
 * Versione: Polimorfica e Dinamica. Si adatta a qualsiasi profilo utente e quantitativo di toni.
 */

import { Worker } from 'bullmq';
import redisConnection from '../utils/redis.js'; 
import { updateJobState, getJobState } from '../services/stateManager.js'; 
import { generateQueries } from '../services/shaper.js'; 
import { performWebSearch } from '../services/search.js'; 
import { refineResults } from '../services/refiner.js'; 
import { generateTones } from '../services/generator.js'; 

const worker = new Worker('prism-jobs', async (job) => {
  const { userId, topic } = job.data; 
  const jobId = job.id; 

  // 1. SINCRONIZZAZIONE STATO: Recuperiamo lo stato persistente da Redis
  let currentState = await getJobState(userId, jobId);
  
  try {
    // --- FASE F1: QUERY SHAPING (Analisi strategica del topic) ---
    if (!currentState.internal_data?.queries) {
      currentState = await updateJobState(userId, jobId, {
        status: 'running',
        pipeline: { step: 'query_shaping', progress: 0.15, message: 'F1: Analisi semantica e preparazione query strategiche...' }
      });

      const queries = await generateQueries(topic); 
      
      currentState = await updateJobState(userId, jobId, {
        internal_data: { ...currentState.internal_data, queries }
      });
      console.log(`✅ F1 Completata per Job ${jobId}`);
    }

    // --- FASE F2: TAVILY SEARCH (Recupero informazioni real-time) ---
    if (!currentState.internal_data?.rawSources) {
      currentState = await updateJobState(userId, jobId, {
        status: 'fetching',
        pipeline: { step: 'tavily_search', progress: 0.40, message: 'F2: Esplorazione web e recupero fonti in corso...' }
      });

      const sources = await performWebSearch(currentState.internal_data.queries); 
      
      const sourcesPreview = sources.slice(0, 5).map(s => ({
        title: s.title,
        url: s.url,
        trust_score: s.score || 0.8
      }));

      currentState = await updateJobState(userId, jobId, {
        sources_preview: sourcesPreview,
        internal_data: { ...currentState.internal_data, rawSources: sources }
      });
      console.log(`✅ F2 Completata per Job ${jobId}`);
    }

    // --- FASE F3: REFINER (Filtro dei fatti e compressione dati) ---
    if (!currentState.internal_data?.verifiedFacts) {
      currentState = await updateJobState(userId, jobId, {
        status: 'compressing',
        pipeline: { step: 'compression', progress: 0.70, message: 'F3: Raffinamento dati e isolamento fatti verificati...' }
      });

      const facts = await refineResults(topic, currentState.internal_data.rawSources);

      currentState = await updateJobState(userId, jobId, {
        internal_data: { ...currentState.internal_data, verifiedFacts: facts }
      });
      console.log(`✅ F3 Completata per Job ${jobId}`);
    }

    // --- FASE F4: GENERATION (Costruzione modulare dinamica ed estensibile) ---
    // 🌟 MODIFICA INPUT: Il controllo verifica se l'oggetto 'tones' è vuoto o non inizializzato
    const hasTonesGenerated = currentState.tones && 
      Object.values(currentState.tones).some(tone => tone.text && tone.text.trim() !== "");

    if (!hasTonesGenerated) {
      currentState = await updateJobState(userId, jobId, {
        status: 'generating',
        pipeline: { step: 'generation', progress: 0.90, message: `F4: Generazione contenuti in corso per profilo [${(currentState.input?.profile || 'BASIC').toUpperCase()}]...` }
      });

      // Esecuzione del generatore agnostico (F4 gestisce l'autorizzazione interna tramite Redis)
      const generatedData = await generateTones(
        currentState.input, // Contiene platform, language e profile (es: input.profile = "pro")
        currentState.internal_data.verifiedFacts,
        currentState.sources_preview
      );

      // 🌟 MODIFICA OUTPUT: Mappatura e composizione dinamica dello stato dei toni
      const updatedTones = {};
      const generatedKeys = Object.keys(generatedData);

      if (generatedKeys.length === 0) {
        throw new Error("La generazione ha restituito zero moduli. Verificare le tabelle dei profili su Redis.");
      }

      for (const toneKey of generatedKeys) {
        updatedTones[toneKey] = {
          status: 'done',
          text: generatedData[toneKey].text,
          authority: generatedData[toneKey].authority
        };
      }

      // Aggiornamento atomico dello stato con i soli toni prodotti per quel profilo utente
      currentState = await updateJobState(userId, jobId, {
        tones: updatedTones
      });
      console.log(`✅ F4 Completata. Generati con successo ${generatedKeys.length} moduli per Job ${jobId}`);
    }

    // --- FINALIZZAZIONE ---
    await updateJobState(userId, jobId, {
      status: 'completed',
      pipeline: { step: 'done', progress: 1.0, message: 'Processo terminato. I contenuti autorizzati sono pronti!' }
    });

  } catch (err) {
    // --- GESTIONE ERRORI E RECOVERY ---
    console.error(`❌ Errore critico nel Worker (Job ${jobId}):`, err.message);

    await updateJobState(userId, jobId, {
      status: 'failed',
      error: {
        code: 'PIPELINE_ERROR',
        message: err.message,
        step: currentState?.pipeline?.step || 'unknown'
      }
    });

    throw err; 
  }
}, { 
  connection: redisConnection,
  concurrency: 1, 
  settings: {
    backoff: { type: 'exponential', delay: 5000 } 
  }
});

console.log('🚀 Worker PRISM operativo, flessibile e connesso a Redis.');