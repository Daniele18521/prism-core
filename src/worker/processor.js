/**
 * WORKER CORE: PRISM PIPELINE ENGINERING
 * Scopo: Gestire la coda asincrona di BullMQ per l'elaborazione dei post.
 * Gestisce sia il flusso di generazione standard (F1-F4) sia la rigenerazione chirurgica.
 */

import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import redisConnection from '../utils/redis.js'; 
import { updateJobState, getJobState } from '../services/stateManager.js'; 
import { generateQueries } from '../services/shaper.js'; 
import { performWebSearch } from '../services/search.js'; 
import { refineResults } from '../services/refiner.js'; 
import { generateTones } from '../services/generator.js'; 
// Importiamo l'istanza core di Firestore e la classe per i Timestamp nativi di Firebase
import { db, FieldValue } from '../utils/firebaseAdmin.js';

// Nome della coda su cui si aggancia il worker, sincronizzato con l'API Server
const QUEUE_NAME = 'prism-jobs'; 
const IS_MOCK_ENABLED = process.env.USE_MOCK_GENERATOR === 'true';
// Helper per i dati di Mock
const getMockOutput = (stage, topic) => {
  const mocks = {
    query_shaping: ["strategia di marketing per " + topic, "trend 2026 nel settore " + topic],
    tavily_search: { sources: [{ title: "Mock Source", url: "https://example.com", score: 0.95 }] },
    refiner: {
      verifiedFacts: ["Fatto 1 (Mock)", "Fatto 2 (Mock)"],
      verifiedImages: ["https://picsum.photos/400/300"],
      verifiedTables: [{ "Parametro": "Stato", "Valore": "Mocked" }]
    },
    generation: {
      professional: { text: "[MOCK] Testo professionale generato.", authority: "high" },
      creative: { text: "[MOCK] Testo creativo generato.", authority: "medium" }
    }
  };
  return mocks[stage];
};

// Inizializzazione del Worker di BullMQ
const worker = new Worker(QUEUE_NAME, async (job) => {
  // Estrazione sicura di tutti i parametri inviati dall'API Server nel payload del job
  const { userId, companyId, topic, platform, language, maxChars, toneKey, action, parentJobId } = job.data; 
  const jobId = job.id; 
  const isMock = IS_MOCK_ENABLED
  console.log(`🚀 [WORKER] Job Iniziato. ID: ${jobId} | Azione: ${action || 'standard'}`);
  console.log(`🚀 [WORKER] Job Iniziato. in modalità: ${isMock}`);

  // Se l'azione è una rigenerazione chirurgica di un tono, lavoriamo sul record del post padre
  const targetJobId = action === 'regen_tone' ? parentJobId : jobId;
  // Chiave standard di identificazione del record dello stato su Redis
  const standardRedisKey = `${userId}:jobs:${targetJobId}`;

  // Recupero a caldo dello stato corrente del Job registrato su Redis
  let currentState = await getJobState(userId, targetJobId);
  
  // Se lo stato non esiste e siamo in un flusso normale, inizializziamo lo stato su "running"
  if (!currentState && action !== 'regen_tone') {
    currentState = await updateJobState(userId, targetJobId, {
      status: 'running',
      input: { topic, platform, language: language || 'italiano', maxChars }
    });
  }
  
  try {
    // =========================================================================
    // 🎯 DEVIAZIONE CHIRURGICA: RIGENERAZIONE CON STORICO VERSIONATO (SINGOLO TONO)
    // =========================================================================
    if (action === 'regen_tone' && toneKey) {
      console.log(`🎯 Esecuzione chirurgica per il Tono: [${toneKey}] su Record: ${targetJobId}`);
      
      // Aggiorna lo stato su Redis per indicare l'avvio della fase di scrittura mirata
      currentState = await updateJobState(userId, targetJobId, {
        status: 'generating',
        pipeline: { 
          step: 'generation', 
          progress: 0.50, 
          message: `F4: Scrittura della nuova variante per lo stile [${toneKey.toUpperCase()}]...` 
        }
      });

      // Recupera i fatti verificati e gli asset multimediali pre-elaborati a monte nel record padre
      const verifiedFacts = currentState?.internal_data?.verifiedFacts || [];
      const sourcesPreview = currentState?.sources_preview || [];
      const originalInput = currentState?.input || { topic, platform, language, maxChars };
      
      // Recupero a caldo degli asset multimediali già raffinati da Gemini Flash per iniettarli nel generatore
      const verifiedImages = currentState?.internal_data?.verifiedImages || [];
      const verifiedTables = currentState?.internal_data?.verifiedTables || [];

      // Chiamata al modulo generator.js per generare esclusivamente il testo del tono richiesto
      const singleGeneratedOutput = await generateTones(
        { ...originalInput, singleToneTarget: toneKey }, 
        verifiedFacts,
        sourcesPreview,
        verifiedImages, // Passaggio dell'array di immagini approvate
        verifiedTables  // Passaggio dell'array di tabelle approvate
      );

      // Estrae il testo puro restituito dall'LLM di scrittura (Gemini Pro/Ultra)
      const newText = singleGeneratedOutput[toneKey]?.text || singleGeneratedOutput?.text;
      if (!newText) {
        throw new Error(`Il modello non ha prodotto testo valido per lo stile richiesto: ${toneKey}`);
      }

      // Recupero della stringa JSON grezza da Redis per evitare sovrascritture in ambienti concorrenti
      const parentDataRaw = await redisConnection.get(standardRedisKey);
      let parentData = parentDataRaw ? JSON.parse(parentDataRaw) : {};

      // Controllo di integrità: blocca l'esecuzione se il tono da modificare non fa parte del set originale
      if (!parentData.tones || !parentData.tones[toneKey]) {
        throw new Error(`Impossibile storicizzare: il tono ${toneKey} non esiste nel record di partenza.`);
      }

      // 1. INIZIALIZZAZIONE E GESTIONE DELLO STORICO DELLE VERSIONI PRECEDENTI SU REDIS
      if (!parentData.storico) parentData.storico = {};
      if (!Array.isArray(parentData.storico[toneKey])) {
        parentData.storico[toneKey] = [];
      }

      // Estrae la versione corrente del blocco (di default parte da 1)
      const oldVersion = parentData.tones[toneKey].version || 1;

      // Sposta la vecchia versione nel cassetto dello storico per non perdere i testi precedenti
      parentData.storico[toneKey].push({
        version: oldVersion,
        text: parentData.tones[toneKey].text,
        timestamp: parentData.tones[toneKey].last_updated || new Date().toISOString(),
        reason: oldVersion === 1 ? "Generazione iniziale della pipeline" : `Rigenerazione numero ${oldVersion - 1}`
      });

      // 2. AGGIORNAMENTO DEL BLOCCO DEL TONO CON IL NUOVO TESTO E I NUOVI METADATI
      const nextVersion = oldVersion + 1;
      
      parentData.tones[toneKey].text = newText; // Inietta il nuovo testo rigenerato
      parentData.tones[toneKey].status = 'done';
      parentData.tones[toneKey].authority = singleGeneratedOutput[toneKey]?.authority || parentData.tones[toneKey].authority;
      parentData.tones[toneKey].is_regenerated = true; // Flag per far mostrare l'etichetta "Modificato" nel frontend
      parentData.tones[toneKey].version = nextVersion; // Incrementa il contatore di versione
      parentData.tones[toneKey].last_updated = new Date().toISOString();
      parentData.tones[toneKey].fonte_rigenerazione = "";

      // Rimuove eventuali patch temporanee rimaste in memoria
      if (parentData.patches) delete parentData.patches;

      // Reimposta lo stato generale a completato
      parentData.status = 'completed';
      parentData.pipeline = { 
        step: 'done', 
        progress: 1.0, 
        message: 'Rigenerazione completata con successo!' 
      };

      // 3. SALVATAGGIO REQUISITI AGGIORNATI SU REDIS REIMPOSTANDO IL TTL DI 24 ORE
      await redisConnection.set(standardRedisKey, JSON.stringify(parentData), 'EX', 86400);
      console.log(`✅ [REDIS] Record chirurgico aggiornato. TTL residuo resettato a 24h.`);

      // 4. PERSISTENZA STRUTTURATA E AGGIORNAMENTO CHIRURGICO DEL DOCUMENTO SU FIRESTORE
      try {
        console.log(`⏳ [FIRESTORE] Aggiornamento contenuto permanente in contents/${targetJobId}...`);
        
        const contentRef = db.collection('contents').doc(targetJobId);
        // Usa merge: true per sovrascrivere solo il nodo modificato senza spaccare le altre chiavi
        await contentRef.set({
          company_id: companyId || 'unknown_cluster', 
          user_id: userId,
          testo: parentData, 
          media_support: { 
            verified_images: verifiedImages,
            verified_tables: verifiedTables
          },
          created_at: FieldValue.serverTimestamp() // Timestamp nativo del server di Firebase
        }, { merge: true });

        console.log(`🔥 [FIRESTORE] Storico versione v${nextVersion} consolidato in contents/`);
      } catch (fsError) {
        console.error(`❌ [FIRESTORE ERROR] Errore di backup nel flusso chirurgico:`, fsError.message);
      }

      return; // Interrompe l'esecuzione del worker per questo job, avendo completato il ramo chirurgico
    }

    // =========================================================================
    // 🔄 FLUSSO STANDARD DI GENERAZIONE COMPLETA (F1 -> F4)
    // =========================================================================

    // --- FASE F1: QUERY SHAPING (Pianificazione strategica delle ricerche) ---
    if (!currentState.internal_data?.queries) {
      currentState = await updateJobState(userId, targetJobId, {
        status: 'running',
        pipeline: { step: 'query_shaping', progress: 0.15, message: 'F1: Analisi semantica e query strategiche...' }
      });
      // Chiama Gemini Flash per spezzettare l'argomento in query efficaci per il web
      //const queries = await generateQueries(topic); 
      const queries = isMock ? getMockOutput('query_shaping', topic) : await generateQueries(topic);
      currentState = await updateJobState(userId, targetJobId, {
        internal_data: { ...currentState.internal_data, queries }
      });
    }

    // --- FASE F2: TAVILY SEARCH (Esplorazione e aggancio dei media nativi) ---
    if (!currentState.internal_data?.rawSources) {
      currentState = await updateJobState(userId, targetJobId, {
        status: 'fetching',
        pipeline: { step: 'tavily_search', progress: 0.40, message: 'F2: Esplorazione web e recupero fonti con media...' }
      });
      
      // Esegue la ricerca web avanzata. Le immagini ora vivono all'interno delle sorgenti stesse
      //const { sources } = await performWebSearch(currentState.internal_data.queries); 
      const { sources } = isMock ? getMockOutput('tavily_search') : await performWebSearch(currentState.internal_data.queries);
      // Mappa un'anteprima leggera delle prime 5 fonti da mostrare istantaneamente nella UI
      const sourcesPreview = sources.slice(0, 5).map(s => ({
        title: s.title,
        url: s.url,
        trust_score: s.score || 0.8
      }));
      
      // Sincronizza lo stato salvando l'array "rawSources" che contiene testi + URL delle immagini
      currentState = await updateJobState(userId, targetJobId, {
        sources_preview: sourcesPreview,
        internal_data: { 
          ...currentState.internal_data, 
          rawSources: sources     
        }
      });
    }

    // --- FASE F3: REFINER (Filtraggio semantico dei testi e pulizia delle porcherie visive) ---
    if (!currentState.internal_data?.verifiedFacts) {
      currentState = await updateJobState(userId, targetJobId, {
        status: 'compressing',
        pipeline: { step: 'compression', progress: 0.70, message: 'F3: Analisi semantica e filtraggio immagini coerenti...' }
      });
    
      // Passa a refineResults solo il topic e le rawSources. 
      // Gemini Flash leggerà i testi e pulirà gli URL scartando loghi o pubblicità.
      //const { verifiedFacts, verifiedImages, verifiedTables } = await refineResults(
      //  topic, 
      //  currentState.internal_data.rawSources
      //);
      const { verifiedFacts, verifiedImages, verifiedTables } = isMock ? getMockOutput('refiner') : await refineResults(topic, currentState.internal_data.rawSources);
    
      // Memorizza su Redis l'output purificato pronto per essere impastato dalla fase F4
      currentState = await updateJobState(userId, targetJobId, {
        internal_data: { 
          ...currentState.internal_data, 
          verifiedFacts,
          verifiedImages, // Array pulito contenente solo immagini pertinenti e coerenti
          verifiedTables: verifiedTables || []
        }
      });
    }

    // --- FASE F4: GENERATION (Scrittura dei post) ---
    // Verifica di sicurezza: controlla se l'oggetto tones esiste già ed è popolato per evitare doppie generazioni
    const hasTonesGenerated = currentState.tones && 
      Object.values(currentState.tones).some(tone => tone.text && tone.text.trim() !== "");

    if (!hasTonesGenerated) {
      currentState = await updateJobState(userId, targetJobId, {
        status: 'generating',
        pipeline: { step: 'generation', progress: 0.90, message: `F4: Generazione contenuti in corso...` }
      });

      // Passaggio dei dati strutturati e dei media filtrati al motore di scrittura (Gemini Pro)
      const generatedData = await generateTones(
        currentState.input, 
        currentState.internal_data.verifiedFacts,
        currentState.sources_preview,
        currentState.internal_data.verifiedImages || [], // Immagini verificate passate come argomento 4
        currentState.internal_data.verifiedTables || []  // Tabelle verificate passate come argomento 5
      );

      const updatedTones = {};
      const generatedKeys = Object.keys(generatedData);

      // Eccezione di blocco se l'LLM restituisce un oggetto vuoto
      if (generatedKeys.length === 0) {
        throw new Error("La generation ha restituito zero moduli.");
      }

      // Cicla i toni generati dal Master Kernel e crea la struttura JSON per il database
      for (const tKey of generatedKeys) {
        updatedTones[tKey] = {
          status: 'done',
          text: generatedData[tKey].text,
          authority: generatedData[tKey].authority || 'medium',
          is_regenerated: false,
          version: 1, // Versione di partenza per la riga storica
          last_updated: new Date().toISOString(),
          fonte_rigenerazione: ""
        };
      }

      // Sincronizza l'oggetto dei toni completati nello stato corrente su Redis
      currentState = await updateJobState(userId, targetJobId, {
        tones: updatedTones
      });
    }

    // --- FINALIZZAZIONE DEL FLUSSO STANDARD ---
    // Imposta lo stato finale a completed e chiude l'avanzamento della barra di caricamento (1.0)
    const finalState = await updateJobState(userId, targetJobId, {
      status: 'completed',
      pipeline: { step: 'done', progress: 1.0, message: 'Processo terminato. Contenuti pronti!' }
    });

    // Forza la scadenza automatica del record temporaneo su Redis dopo 24 ore per liberare RAM
    await redisConnection.expire(standardRedisKey, 86400);
    console.log(`💾 [REDIS] Cache di generazione standard impostata a 24 ore.`);

    // 2. PERSISTENZA IMMUTABILE DEL DOCUMENTO FINALE STANDARD SU FIRESTORE
    try {
      console.log(`⏳ [FIRESTORE] Scrittura record finale in contents/${targetJobId}...`);
      
      // Clonazione dello stato per eliminare l'HTML pesante prima di salvare su Firestore (limite di sicurezza)
      const cleanFinalState = { ...finalState };
      if (cleanFinalState.internal_data) {
        delete cleanFinalState.internal_data.rawSources; // Distrugge l'HTML accumulato in F2
      }

      const contentRef = db.collection('contents').doc(targetJobId);
      // Salva il record definitivo all'interno della raccolta globale contents/
      await contentRef.set({
        company_id: companyId || 'unknown_cluster', // Cluster aziendale multi-utente
        user_id: userId,
        testo: cleanFinalState, // Contiene i testi dei toni completi e lo storico versioni
        media_support: { 
          verified_images: currentState.internal_data?.verifiedImages || [], // Galleria di immagini pulite per il frontend
          verified_tables: currentState.internal_data?.verifiedTables || []
        },
        created_at: FieldValue.serverTimestamp()
      });
      
      console.log(`🔥 [FIRESTORE] Successo! Il contenuto standard è ora persistito globalmente.`);
    } catch (fsError) {
      console.error(`❌ [FIRESTORE ERROR] Mancato backup del flusso standard su Firestore:`, fsError.message);
    }

  } catch (err) {
    // =========================================================================
    // 🚨 GESTIONE CRITICA DEGLI ERRORI E FALLBACK ANTI-CRASH
    // =========================================================================
    console.error(`❌ Errore critico nel Worker (Job ${targetJobId}):`, err.message);
    
    // Scrive lo stato di fallimento su Redis catturando lo step in cui la pipeline si è interrotta
    const failedState = await updateJobState(userId, targetJobId, {
      status: 'failed',
      error: {
        code: action === 'regen_tone' ? 'SURGICAL_REGEN_ERROR' : 'PIPELINE_ERROR',
        message: err.message,
        step: currentState?.pipeline?.step || 'unknown'
      }
    });

    // Imposta il TTL di sicurezza anche sul record fallito
    await redisConnection.expire(standardRedisKey, 86400);

    // Clonazione e pulizia immediata anti-crash (rimozione fonti grezze) prima di salvare il log del crash su Firestore
    const lightFailedState = { ...failedState };
    if (lightFailedState.internal_data) {
      delete lightFailedState.internal_data.rawSources; // Rimuove l'HTML pesante per stare sotto il limite di 1MB di Firestore
    }

    try {
      const contentRef = db.collection('contents').doc(targetJobId);
      // Salva lo stato di errore permanentemente per fare in modo che il frontend sblocchi la UI mostrando l'errore
      await contentRef.set({
        company_id: companyId || 'unknown_cluster', 
        user_id: userId,
        testo: lightFailedState,
        media_support: { 
          verified_images: currentState?.internal_data?.verifiedImages || [],
          verified_tables: currentState?.internal_data?.verifiedTables || []
        },
        created_at: FieldValue.serverTimestamp()
      });
      console.log(`⚠️ [FIRESTORE] Stato di fallimento memorizzato in sicurezza.`);
    } catch (fsErr) {
      console.error(`❌ Impossibile salvare lo stato di "Failed" in contents/ su Firestore:`, fsErr.message);
    }

    // Rilancia l'errore per notificare a BullMQ il fallimento definitivo del Job
    throw err; 
  }
}, { 
  connection: redisConnection, // Connessione Redis centralizzata
  concurrency: 1, // Numero di Job elaborati in contemporanea da questa singola istanza worker
  settings: { backoff: { type: 'exponential', delay: 5000 } } // In caso di errore riprova dopo 5s scalando in modo esponenziale
});

console.log(`🚀 Worker PRISM operativo. Configurato con barriera di sicurezza anti-crash 1MB in modalità: ${IS_MOCK_ENABLED}`);