/**
 * GESTIONE ERRORI — file condiviso da tutto il progetto.
 *
 * A cosa serve:
 * Quando qualcosa va storto, non vogliamo messaggi confusi in console.
 * Questo file ci aiuta a capire CHE tipo di errore è successo e COSA fare dopo.
 */

/**
 * AppError = un errore "con etichetta".
 *
 * Un errore normale in JavaScript dice solo "qualcosa è andato male".
 * AppError aggiunge informazioni utili:
 * - code: codice breve (es. GEMINI_TIMEOUT)
 * - retryable: true = possiamo riprovare, false = inutile riprovare
 * - step: in quale fase del pipeline è successo (F1, F2, F3, F4...)
 */
export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', retryable = false, step = 'unknown', cause = null } = {}) {
    super(message); // messaggio umano dell'errore
    this.name = 'AppError';
    this.code = code; // codice tecnico per capire il tipo di problema
    this.retryable = retryable; // true = errore temporaneo (rete), false = errore definitivo
    this.step = step; // fase del job (content_ingest, query_shaping, tavily_search, refiner, generation...)
    this.cause = cause; // errore originale, se c'è
  }
}

/**
 * Stati "terminali" = il job ha finito e NON deve più essere rielaborato.
 * completed = successo
 * failed = errore
 * blocked = input bloccato dal gatekeeper (contenuto non ammesso)
 */
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'blocked'];

// Controlla se uno status indica che il job è già chiuso
export const isTerminalJobStatus = (status) => TERMINAL_JOB_STATUSES.includes(status);

/**
 * Codici HTTP che di solito indicano un problema TEMPORANEO del server.
 * 429 = troppe richieste, aspetta e riprova
 * 502/503/504 = server Google/sovraccarico o down momentaneo
 */
export const isRetryableHttpStatus = (status) => status === 429 || status === 502 || status === 503 || status === 504;

/**
 * Decide se un errore vale la pena di essere RIPROVATO automaticamente.
 *
 * Esempi di errori temporanei (retryable = true):
 * - ECONNRESET = connessione internet interrotta
 * - ENOTFOUND = DNS non ha trovato il server (rete instabile)
 * - ETIMEDOUT = richiesta troppo lenta, scaduta
 *
 * Se l'errore è già un AppError, usiamo il flag retryable che abbiamo messo noi.
 */
export const isRetryableError = (err) => {
  if (err instanceof AppError) return err.retryable;
  const code = err?.code || '';
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'ECONNRESET'
    || code === 'ENOTFOUND'
    || code === 'ETIMEDOUT'
    || code === 'ECONNREFUSED'
    || msg.includes('timeout')
    || msg.includes('network')
    || msg.includes('fetch failed')
    || msg.includes('socket hang up')
  );
};

/**
 * Scrive un errore in console in formato JSON leggibile.
 *
 * Perché JSON e non solo err.message?
 * In produzione così possiamo cercare nei log per jobId, step, ecc.
 *
 * @param context - dove è successo (es. "WORKER:432", "API:generate")
 * @param err - l'errore catturato
 * @param extra - info aggiuntive (jobId, requestId...)
 */
export const logError = (context, err, extra = {}) => {
  const payload = {
    context,
    message: err?.message || String(err),
    code: err?.code || err?.name,
    step: err?.step,
    retryable: err?.retryable ?? isRetryableError(err),
    stack: err?.stack, // traccia tecnica per debug
    ...extra,
  };
  console.error(`❌ [${context}]`, JSON.stringify(payload));
  return payload;
};
