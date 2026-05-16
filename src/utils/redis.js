import IORedis from 'ioredis'; // Importa il driver per Redis
import dotenv from 'dotenv'; // Carica le variabili d'ambiente

dotenv.config(); // Inizializza dotenv

// Creiamo l'istanza di connessione
const redisConnection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // Obbligatorio per BullMQ per gestire i retry internamente
  connectTimeout: 10000, // Fallisce se non si connette entro 10 secondi
});

// Gestione eventi per monitorare la stabilità
redisConnection.on('connect', () => console.log('✅ Connesso a Upstash Redis'));
redisConnection.on('error', (err) => console.error('❌ Errore critico Redis:', err.message));

export default redisConnection; // Esporta la connessione per usarla ovunque