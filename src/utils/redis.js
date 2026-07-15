/**
 * CONNESSIONE REDIS — database veloce in memoria usato durante l'elaborazione job.
 *
 * Redis serve a:
 * - tenere lo stato del job mentre il worker lavora (F1→F2→F3→F4)
 * - fare da coda per BullMQ (lista di job da processare)
 *
 * Locale: Docker (redis://127.0.0.1:6379) — scelto automaticamente in development.
 * Produzione: Upstash (rediss://...) — scelto automaticamente con NODE_ENV=production.
 */

import IORedis from 'ioredis';
import dotenv from 'dotenv';
// Risolve quale URL usare (locale vs produzione) leggendo il .env
import { resolveRedisUrl, maskRedisUrl } from './resolveRedisUrl.js';

dotenv.config();

// Sceglie URL in base a NODE_ENV / PRISM_ENV (vedi resolveRedisUrl.js)
const { url: redisUrl, profile, source } = resolveRedisUrl();

// Log di avvio senza esporre password (URL mascherato)
console.log(`ℹ️ [REDIS] Profilo: [${profile.toUpperCase()}] — sorgente: ${source}`);
console.log(`ℹ️ [REDIS] Endpoint: ${maskRedisUrl(redisUrl)}`);

// rediss:// (con doppia s) = connessione criptata TLS, obbligatoria su Upstash
const useTls = redisUrl.startsWith('rediss://');

const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null, // BullMQ gestisce i retry da solo, non ioredis
  connectTimeout: 10_000, // 10 secondi per la prima connessione
  // Nessun commandTimeout: BullMQ usa comandi bloccanti (BRPOP) che aspettano job in coda.
  // Con timeout attivo, ioredis lancia "Command timed out" ogni ~15s in loop infinito.
  // Quanto aspettare tra un tentativo di riconnessione e l'altro (max 5 secondi)
  retryStrategy: (times) => Math.min(times * 300, 5_000),
  // Riconnetti automaticamente se la connessione cade per questi errori
  reconnectOnError: (err) => {
    const msg = err?.message || '';
    return msg.includes('READONLY') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
  },
  ...(useTls ? { tls: {} } : {}), // abilita TLS solo se l'URL lo richiede
});

// Flag interno: true solo quando Redis ha finito l'handshake ed è pronto
let redisReady = false;

// "ready" = connessione attiva e utilizzabile
redisConnection.on('ready', () => {
  redisReady = true;
  console.log('✅ Redis pronto');
});

// "connect" = socket aperto (può arrivare prima di "ready")
redisConnection.on('connect', () => {
  console.log('🔗 Connessione Redis stabilita');
});

// Sta provando a riconnettersi dopo un errore di rete
redisConnection.on('reconnecting', (delay) => {
  console.warn(`🔄 Redis riconnessione tra ${delay}ms...`);
});

redisConnection.on('close', () => {
  redisReady = false;
});

redisConnection.on('end', () => {
  redisReady = false;
  console.warn('⚠️ Connessione Redis chiusa');
});

/**
 * Log differenziati: errori di rete temporanei = warning, altri = errore vero.
 * ECONNRESET/ENOTFOUND che vedevi prima sono spesso transitori (wifi, idle timeout Upstash).
 */
redisConnection.on('error', (err) => {
  const transient = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err?.code);
  if (transient) {
    console.warn(`⚠️ Redis transitorio [${err.code}]: ${err.message}`);
  } else {
    console.error(`❌ Redis errore [${err.code}]: ${err.message}`);
  }
});

/** Ping = comando leggerissimo per verificare che Redis risponda (usato da /ready) */
export const pingRedis = () => redisConnection.ping();

/** True se Redis è connesso e pronto a ricevere comandi */
export const isRedisReady = () => redisReady && redisConnection.status === 'ready';

/** Chiude la connessione in modo pulito (usato durante lo shutdown) */
export const closeRedis = async () => {
  if (redisConnection.status === 'end') return; // già chiuso
  await redisConnection.quit(); // invia comando QUIT a Redis
};

export default redisConnection;
