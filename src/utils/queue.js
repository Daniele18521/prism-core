/**
 * CODA BULLMQ — lista di job da processare.
 *
 * Immagina una fila in posta:
 * - L'API "mette in coda" un job (add)
 * - Il worker "preleva" il prossimo job (Worker in processor.js)
 *
 * Usa la stessa connessione Redis di tutto il resto del progetto.
 */

import { Queue } from 'bullmq';
import redisConnection from './redis.js';

// Nome coda condiviso con worker/processor.js e api/index.js
export const prismQueue = new Queue('prism-jobs', {
  connection: redisConnection,
});
