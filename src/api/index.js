/**
 * SERVER API PRISM (PUNTO DI INGRESSO E ORCHESTRAZIONE)
 * Scopo: Ricevere le richieste di generazione (POST) e gestire il polling dello stato (GET).
 * Struttura: 100% asincrona, interfacciata con BullMQ e lo State Manager dinamico.
 */

import express from 'express'; // Framework web
import cors from 'cors'; // Gestione sicurezza cross-origin
import { Queue } from 'bullmq'; // Gestore code
import redisConnection from '../utils/redis.js'; // Connessione Redis centralizzata
import { updateJobState, getJobStatusForClient } from '../services/stateManager.js'; // Gestore stato JSON

const app = express();
app.use(cors()); // Abilita CORS per permettere le chiamate dal frontend
app.use(express.json()); // Abilita il parsing dei body JSON

// Inizializza la coda centralizzata BullMQ puntando alla connessione condivisa di Redis
const prismQueue = new Queue('prism-jobs', { connection: redisConnection });

/**
 * 🚀 ROTTA POST: INNESTO DELLA PIPELINE PRINCIPALE
 * Riceve i dati dall'utente, crea un Job asincrono nella coda e inizializza lo stato su Redis.
 * Allineato con il frontend sotto il prefisso /api
 */
app.post('/api/generate', async (req, res) => {
  // 🟢 Estrae 'companyId' inviato dal frontend al posto del vecchio 'profile'
  const { userId, companyId, topic, platform, language, maxChars } = req.body;

  // Validazione minima obbligatoria a livello di rete
  if (!userId || !topic) return res.status(400).json({ error: "Missing userId or topic" });
  if (!companyId) return res.status(400).json({ error: "Missing companyId context" });

  try {
    // 1. Aggiunge il lavoro alla coda di BullMQ passando il companyId al worker
    const job = await prismQueue.add('generate-content', 
      { userId, companyId, topic, platform, language: language || 'italiano', maxChars },
      { 
        attempts: 3, // Riprova fino a 3 volte se il worker incontra un crash temporaneo
        backoff: { type: 'exponential', delay: 5000 }, // Tempo di attesa esponenziale (5s, 10s...)
        removeOnComplete: true, // Pulisce Redis dai metadati interni di BullMQ se il job finisce bene
        removeOnFail: false    // Preserva i log strutturali in caso di fallimento per ispezione
      }
    );

    // 2. Crea il record di stato iniziale su Redis includendo il contesto aziendale
    await updateJobState(userId, job.id, {
      status: 'queued',
      input: { 
        topic, 
        platform, 
        language: language || 'italiano', 
        maxChars, 
        companyId 
      }
    });

    // 3. Risponde istantaneamente al client inviando il jobId da usare per il polling successivo
    res.json({ success: true, jobId: job.id });

  } catch (error) {
    console.error("❌ Errore durante l'inserimento del Job nell'API:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * 🔄 ROTTA GET: POLLING DINAMICO DELLO STATO
 * Questa rotta viene interpellata ciclicamente dall'interfaccia utente.
 * URL di esempio: GET /jobs/status/AAAAAAA/1
 */
app.get('/jobs/status/:userId/:jobId', async (req, res) => {
  try {
    const { userId, jobId } = req.params;

    // 1. Richiediamo l'estrazione pulita dei dati allo stateManager
    const jobStatus = await getJobStatusForClient(userId, jobId);

    // 2. Gestione caso in cui il Job sia inesistente o rimosso da Redis
    if (!jobStatus) {
      return res.status(404).json({ 
        success: false,
        error: "JOB_NOT_FOUND",
        message: "Il Job specificato non esiste o la sessione è scaduta." 
      });
    }

    // 3. Se il job è fallito a monte, notifichiamo l'errore senza bloccare il flusso
    if (jobStatus.status === 'failed') {
      return res.json({
        success: false,
        ...jobStatus // Contiene status: 'failed', progress, messaggio ed errore strutturato
      });
    }

    // 4. Risposta standard di successo per il frontend
    res.json({ 
      success: true, 
      data: jobStatus 
    });

  } catch (error) {
    console.error("❌ Errore durante l'esecuzione della rotta di Polling GET:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * ⚡ ROTTA POST: RIGENERAZIONE CHIRURGICA DEL SINGOLO TONO
 * Inserisce un job specifico nella coda BullMQ per eseguire la rigenerazione isolata.
 */
app.post('/api/regenerate-tone-surgical', async (req, res) => {
  try {
    // 🟢 Accetta 'companyId' al posto di 'profile'
    const { userId, companyId, toneKey, jobId } = req.body;

    if (!userId || !companyId || !toneKey || !jobId) {
      return res.status(400).json({ 
        success: false, 
        error: "Parametri obbligatori mancanti (userId, companyId, toneKey, jobId)." 
      });
    }

    const targetRedisKey = `${userId}:jobs:${jobId}`;
    console.log(`[SERVER] Inizio transazione di rigenerazione chirurgica per: ${targetRedisKey}`);

    const currentDataRaw = await redisConnection.get(targetRedisKey);
    if (!currentDataRaw) {
      return res.status(404).json({ 
        success: false, 
        error: `Task originale non trovato su Redis con la chiave: ${targetRedisKey}` 
      });
    }
    
    const jobData = JSON.parse(currentDataRaw);
    const originalTopic = jobData.topic || (jobData.input ? jobData.input.topic : "");

    // Impostiamo lo stato del record esistente in 'generating' per il polling del frontend
    jobData.status = 'generating';
    jobData.pipeline = {
      step: 'generation',
      progress: 0.20,
      message: `Richiesta di rigenerazione per lo stile [${toneKey.toUpperCase()}] presa in carico...`
    };
    
    // Salviamo lo stato di transizione temporaneo su Redis
    await redisConnection.set(targetRedisKey, JSON.stringify(jobData));

    // Inviamo il lavoro alla coda di BullMQ. Il worker riceverà il context corretto dell'azienda.
    await prismQueue.add('generate-content', 
      { 
        userId, 
        companyId, // 🟢 Passato correttamente al payload del Job BullMQ
        toneKey, 
        topic: originalTopic,
        parentJobId: jobId,  
        action: 'regen_tone' 
      },
      { 
        attempts: 2,
        removeOnComplete: true,
        removeOnFail: false 
      }
    );

    // Rispondiamo al frontend con lo STESSO jobId originale, così il polling continua fluido
    return res.json({ success: true, jobId: jobId });

  } catch (error) {
    console.error("❌ Errore nell'inserimento del Job di rigenerazione in coda:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal Server Error" });
  }
});

/**
 * ✏️ ROTTA POST: SALVATAGGIO BUFFER MODIFICHE MANUALI SU REDIS
 * Riceve il testo corretto a mano dall'utente nel modale e aggiorna la cache Redis.
 */
app.post('/api/update-tone-redis', async (req, res) => {
  try {
    const { userId, jobId, toneKey, text } = req.body;

    if (!userId || !jobId || !toneKey || text === undefined) {
      return res.status(400).json({ success: false, error: "Dati di aggiornamento incompleti." });
    }

    const targetRedisKey = `${userId}:jobs:${jobId}`;
    const currentDataRaw = await redisConnection.get(targetRedisKey);

    if (!currentDataRaw) {
      return res.status(404).json({ success: false, error: "Job di riferimento scaduto o inesistente." });
    }

    const jobData = JSON.parse(currentDataRaw);

    // Inizializza le strutture interne se assenti per robustezza
    if (!jobData.tones) jobData.tones = {};
    if (!jobData.tones[toneKey]) jobData.tones[toneKey] = {};

    // Sovrascrive il testo modificato dall'utente
    jobData.tones[toneKey].text = text;

    // Salva la struttura aggiornata nel cluster Redis
    await redisConnection.set(targetRedisKey, JSON.stringify(jobData));
    console.log(`✏️ [REDIS] Buffer aggiornato manualmente dall'utente per il tono: ${toneKey}`);

    return res.json({ success: true });

  } catch (error) {
    console.error("❌ Errore nel salvataggio manuale su Redis:", error);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Avvio dell'ascolto sulla porta assegnata dall'ambiente o sulla 3001 locale
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`📡 API PRISM attiva e pronta al polling sulla porta ${PORT}`));