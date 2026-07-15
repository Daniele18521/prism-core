/**
 * SHUTDOWN GRACEFUL — chiusura pulita del programma.
 *
 * Cosa significa "graceful shutdown"?
 * Quando spegni il server (deploy, Ctrl+C, riavvio), non vuoi tagliare
 * a metà un job in corso. Questo file intercetta il segnale di stop
 * e chiude le connessioni in ordine, dando tempo di finire.
 *
 * SIGTERM = segnale che manda il cloud (Heroku, Railway, Docker) per dire "spegniti"
 * SIGINT = segnale di Ctrl+C nel terminale
 */

import { logError } from './errors.js';

/**
 * Registra i listener sui segnali del sistema operativo.
 *
 * @param onShutdown - funzione async da chiamare per chiudere worker/API/redis
 * @param shutdownTimeoutMs - dopo quanto ms forza la chiusura se qualcosa resta appeso
 * @param label - nome per i log ("worker" o "api")
 */
export const registerProcessHandlers = ({ onShutdown, shutdownTimeoutMs = 30_000, label = 'process' }) => {
  let shuttingDown = false; // evita di eseguire lo shutdown due volte

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 [${label}] ${signal} — avvio shutdown graceful...`);

    // Timer di sicurezza: se dopo 30s non ha finito, chiude brutalmente
    const forceTimer = setTimeout(() => {
      console.error(`❌ [${label}] Shutdown forzato dopo ${shutdownTimeoutMs}ms`);
      process.exit(1); // codice 1 = uscita con errore
    }, shutdownTimeoutMs);

    try {
      await onShutdown(); // chiude worker, server HTTP, redis...
      clearTimeout(forceTimer);
      console.log(`✅ [${label}] Shutdown completato.`);
      process.exit(0); // codice 0 = uscita ok
    } catch (err) {
      clearTimeout(forceTimer);
      logError(`${label}:shutdown`, err);
      process.exit(1);
    }
  };

  // Cloud / Docker manda SIGTERM quando fa deploy o restart
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Ctrl+C nel terminale
  process.on('SIGINT', () => shutdown('SIGINT'));

  /**
   * Promise rifiutata senza catch → prima crashava in silenzio.
   * Ora la logghiamo per capire cosa è successo.
   */
  process.on('unhandledRejection', (reason) => {
    logError(`${label}:unhandledRejection`, reason instanceof Error ? reason : new Error(String(reason)));
  });

  /**
   * Errore sincrono non catturato da try/catch → chiude il processo in modo pulito.
   */
  process.on('uncaughtException', (err) => {
    logError(`${label}:uncaughtException`, err);
    shutdown('uncaughtException');
  });
};
