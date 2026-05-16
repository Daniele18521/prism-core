//Gestire la persistenza del JSON /{userId}/jobs/{jobId} su Redis

import redisConnection from '../utils/redis.js'; // Importa la connessione centralizzata

/**
 * Aggiorna o inizializza lo stato atomico di un Job
 */
export const updateJobState = async (userId, jobId, updates) => {
  const key = `${userId}:jobs:${jobId}`; // Definisce la chiave gerarchica richiesta
  
  // 1. Tenta di recuperare lo stato attuale
  const rawState = await redisConnection.get(key);
  
  // 2. Definisce la struttura di base se il Job è nuovo (Default Schema)
  let state = rawState ? JSON.parse(rawState) : {
    status: 'queued', // Stato globale iniziale
    createdAt: Math.floor(Date.now() / 1000), // Timestamp creazione (UNIX)
    updatedAt: Math.floor(Date.now() / 1000), // Timestamp aggiornamento
    type: 'generation', // Tipo di esecuzione
    version: 'v1', // Versione pipeline
    input: {}, // Dati inviati dall'utente
    pipeline: { step: 'query_shaping', progress: 0, message: 'Inizializzazione...' }, // Stato UX
    sources_preview: [], // Array per le anteprime link
    tones: { // I 6 output finali previsti
      tone_1: { status: 'pending', text: '' },
      tone_2: { status: 'pending', text: '' },
      tone_3: { status: 'pending', text: '' },
      tone_4: { status: 'pending', text: '' },
      tone_5: { status: 'pending', text: '' },
      tone_6: { status: 'pending', text: '' }
    },
    patches: {}, // Per modifiche real-time future
    error: { code: null, message: null, step: null }, // Gestione errori
    internal_data: {} // Campo privato per salvare dati intermedi (queries, raw text) non visibili in UI
  };

  // 3. Esegue l'unione dei dati (Merge)
  // Usiamo lo spread operator per aggiornare i nodi in modo pulito
  const newState = {
    ...state,
    ...updates, // Sovrascrive i campi a primo livello (status, type, ecc.)
    updatedAt: Math.floor(Date.now() / 1000), // Aggiorna sempre il timestamp
    input: { ...state.input, ...(updates.input || {}) }, // Merge del nodo input
    pipeline: { ...state.pipeline, ...(updates.pipeline || {}) }, // Merge del nodo pipeline
    internal_data: { ...state.internal_data, ...(updates.internal_data || {}) }, // Salva dati per il ripristino
    error: { ...state.error, ...(updates.error || {}) } // Merge del nodo errore
  };

  // 4. Scrive su Redis con scadenza 24 ore (86400 secondi)
  await redisConnection.set(key, JSON.stringify(newState), 'EX', 86400);
  
  return newState; // Ritorna lo stato aggiornato
};

/**
 * Recupera lo stato attuale di un Job
 */
export const getJobState = async (userId, jobId) => {
  const data = await redisConnection.get(`${userId}:jobs:${jobId}`);
  return data ? JSON.parse(data) : null;
};