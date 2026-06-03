/**
 * SERVIZIO: STATE MANAGER (FONDAMENTA DI PERSISTENZA)
 * Scopo: Gestire lo stato atomico dei Job su Redis in modo dinamico e polimorfo.
 * Risolve: Elimina il vincolo dei 6 toni statici, strutturando l'output in base al profilo utente.
 */

import redisConnection from '../utils/redis.js'; // Connessione centralizzata a Redis

/**
 * Inizializza o aggiorna lo stato atomico di un Job.
 * Se il Job è nuovo, interroga Redis per strutturare i toni in base al profilo utente.
 * * @param {string} userId - ID univoco dell'utente
 * @param {string} jobId - ID univoco del Job corrente
 * @param {Object} updates - Oggetto contenente le modifiche da applicare allo stato
 */
export const updateJobState = async (userId, jobId, updates) => {
  // Configurazione della chiave gerarchica richiesta: {userId}:jobs:{jobId}
  const key = `${userId}:jobs:${jobId}`; 
  
  // 1. Tentativo di recupero dello stato preesistente da Redis
  const rawState = await redisConnection.get(key);
  
  let state;

  if (rawState) {
    // Se lo stato esiste già, facciamo il parsing del JSON attuale
    state = JSON.parse(rawState);
  } else {
    // -----------------------------------------------------------------
    // 2. INIZIALIZZAZIONE DI UN NUOVO JOB (Default Schema Dinamico)
    // -----------------------------------------------------------------
    
    // Estraiamo il profilo dall'input o impostiamo il fallback di sicurezza su 'basic'
    const userProfile = (updates.input?.profile || 'basic').toLowerCase();
    
    // Prepariamo l'oggetto dei toni che verrà popolato dinamicamente
    const dynamicTones = {};

    try {
      // Interroghiamo la tabella dei profili su Redis per sapere quali toni spettano a questo account
      const profileAllowedTonesRaw = await redisConnection.hget('prism:config:profiles', userProfile);
      
      if (profileAllowedTonesRaw) {
        // Trasformiamo la stringa (es: "tone_1,tone_2") in un array pulito
        const allowedTones = profileAllowedTonesRaw.split(',').map(t => t.trim());
        
        // Generiamo i segnaposto (pending) solo per i toni effettivamente acquistati/abilitati
        for (const toneKey of allowedTones) {
          dynamicTones[toneKey] = { 
            status: 'pending', 
            text: '',
            authority: ''
          };
        }
      } else {
        console.warn(`⚠️ Profilo '${userProfile}' non configurato su Redis. Verrà inizializzato senza toni.`);
      }
    } catch (redisError) {
      console.error(`🔴 Errore durante il fetching dei profili da Redis:`, redisError.message);
      // In caso di errore del DB, lasciamo dynamicTones vuoto per evitare crash; l'F4 solleverà il problema
    }

    // Definizione della struttura di base del record dello stato
    state = {
      status: 'queued', // Stato iniziale nella coda di BullMQ
      createdAt: Math.floor(Date.now() / 1000), // Timestamp di creazione (Formato UNIX Epoch)
      updatedAt: Math.floor(Date.now() / 1000), // Timestamp dell'ultimo aggiornamento
      type: 'generation', // Tipologia di operazione
      version: 'v1', // Versione del motore pipeline
      input: {
        profile: userProfile // 🌟 Salviamo esplicitamente il profilo all'interno del nodo input
      }, 
      pipeline: { 
        step: 'query_shaping', 
        progress: 0, 
        message: 'Inizializzazione della pipeline PRISM...' 
      }, // Informazioni destinate alla barra di caricamento della UX
      sources_preview: [], // Contenitore per le anteprime dei link tracciati da Tavily (F2)
      tones: dynamicTones, // 🌟 QUESTO OGGETTO ORA È DINAMICO! Contiene solo i moduli del profilo utente
      error: { code: null, message: null, step: null }, // Struttura standard per il tracking dei fallimenti
      internal_data: {} // Spazio di memoria privato (es. raw sources) escluso dai log della UI per risparmiare banda
    };
  }

  // -----------------------------------------------------------------
  // 3. MERGE STRUTTURATO (Unione profonda dei dati modificati)
  // -----------------------------------------------------------------
  // Utilizziamo lo spread operator per aggiornare selettivamente i sotonodi senza cancellare i dati vecchi
  const newState = {
    ...state,
    ...updates, // Sovrascrittura dei campi di primo livello (es. status)
    updatedAt: Math.floor(Date.now() / 1000), // Rinnoviamo il timestamp di aggiornamento ad ogni mutazione
    input: { ...state.input, ...(updates.input || {}) }, // Unione dei dati di input utente
    tones: { ...state.tones, ...(updates.tones || {}) }, // Unione polimorfa dei toni generati
    pipeline: { ...state.pipeline, ...(updates.pipeline || {}) }, // Aggiornamento step della UX
    internal_data: { ...state.internal_data, ...(updates.internal_data || {}) }, // Mantenimento dati di cache per i retry
    error: { ...state.error, ...(updates.error || {}) } // Eventuale tracking dell'errore intercettato
  };

  // 4. Scrittura fisica del JSON serializzato su Redis con scadenza automatica di 24 ore (86400 secondi)
  await redisConnection.set(key, JSON.stringify(newState), 'EX', 86400);
  
  return newState; // Ritorna l'oggetto di stato mutato pronto per il ciclo successivo
};

/**
 * Recupera lo stato attuale completo di un Job da Redis.
 * Utilizzato dai Worker per capire da quale fase ripartire in caso di riavvio.
 * * @param {string} userId - ID univoco dell'utente
 * @param {string} jobId - ID univoco del Job da ripescare
 */
export const getJobState = async (userId, jobId) => {
  const data = await redisConnection.get(`${userId}:jobs:${jobId}`);
  return data ? JSON.parse(data) : null;
};

/**
 * Recupera lo stato ottimizzato per il polling dell'Interfaccia Utente (API GET).
 * Se il processo è terminato, restituisce solo i toni effettivamente compilati.
 * * @param {string} userId - ID univoco dell'utente
 * @param {string} jobId - ID univoco del Job richiesto dal frontend
 */
export const getJobStatusForClient = async (userId, jobId) => {
  const state = await getJobState(userId, jobId);
  
  if (!state) return null; 

  // 🌟 SICUREZZA EXTRA: Recuperiamo l'oggetto pipeline nativo o creiamo un fallback pulito
  const rawPipeline = state.pipeline || {};

  const response = {
    jobId: jobId,
    status: state.status, // Questo funziona bene e infatti chiude il popup
    pipeline: {
      // Se lo stato è completed forziamo 'done', altrimenti prendiamo lo step reale di Redis o 'query_shaping'
      step: state.status === 'completed' ? 'done' : (rawPipeline.step || 'query_shaping'),
      
      // Se è completed forza 1 (100%), altrimenti usa il progresso reale o 0
      progress: state.status === 'completed' ? 1 : (typeof rawPipeline.progress === 'number' ? rawPipeline.progress : 0),
      
      // Messaggio reale di Redis o fallback in base allo stato
      message: rawPipeline.message || (state.status === 'completed' ? 'Processo terminato. I contenuti autorizzati sono pronti!' : 'Inizializzazione pipeline...')
    },
    error: state.error?.code ? state.error : null
  };

  if (state.status === 'completed' && state.tones) {
    response.tones = {};
    const keys = Object.keys(state.tones);
    
    for (const key of keys) {
      response.tones[key] = {
        text: state.tones[key].text,
        authority: state.tones[key].authority || 'DOCUMENT-BOUND MODE'
      };
    }
  }

  return response;
};