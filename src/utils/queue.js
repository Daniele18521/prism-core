//Definiamo la coda chiamata prism-jobs. È come creare una corsia preferenziale in autostrada.
//Essa sarà usata dall'API per "aggiungere" lavori e dal Worker per "prelevarli".

import { Queue } from 'bullmq';
import redisConnection from './redis.js';

// Creiamo l'istanza della coda. 
// Questa sarà usata dall'API per "aggiungere" lavori e dal Worker per "prelevarli".
export const prismQueue = new Queue('prism-jobs', {
  connection: redisConnection
});