//Ricevere la richiesta e inizializzare il Job

import express from 'express'; // Framework web
import cors from 'cors'; // Gestione sicurezza cross-origin
import { Queue } from 'bullmq'; // Gestore code
import redisConnection from '../utils/redis.js'; // Connessione Redis
import { updateJobState } from '../services/stateManager.js'; // Gestore stato JSON

const app = express();
app.use(cors()); // Abilita CORS
app.use(express.json()); // Abilita il parsing dei body JSON

// Inizializza la coda BullMQ
const prismQueue = new Queue('prism-jobs', { connection: redisConnection });

app.post('/generate', async (req, res) => {
  // Estrae i parametri richiesti dal frontend
  const { userId, topic, platform, language, maxChars } = req.body;

  // Validazione minima obbligatoria
  if (!userId || !topic) return res.status(400).json({ error: "Missing userId or topic" });

  try {
    // 1. Aggiunge il lavoro alla coda con 3 tentativi di retry (come richiesto)
    const job = await prismQueue.add('generate-content', 
      { userId, topic, platform, language, maxChars },
      { 
        attempts: 3, // Riprova fino a 10 volte se il worker crasha
        backoff: { type: 'exponential', delay: 60000 }, // Aspetta 5s, 10s, 20s tra i retry
        removeOnComplete: true, // Pulisce Redis dai job finiti bene
        removeOnFail: false    // Teniamo quelli falliti per debugging
      }
    );

    // 2. Crea il record iniziale su Redis seguendo la tua struttura JSON
    await updateJobState(userId, job.id, {
      status: 'queued',
      input: { topic, platform, language, maxChars }
    });

    // 3. Risponde all'utente con l'ID del Job
    res.json({ success: true, jobId: job.id });

  } catch (error) {
    console.error("Errore API:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(3000, () => console.log('📡 API PRISM attiva sulla porta 3000'));