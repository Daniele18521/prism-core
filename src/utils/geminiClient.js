/**
 * CLIENT GEMINI — chiamate all'AI di Google in modo sicuro.
 *
 * Problema che risolve:
 * Prima chiamavamo fetch() direttamente: se Google non rispondeva per 5 minuti,
 * il worker restava bloccato. Se la risposta era malformata, il programma crashava
 * con errori incomprensibili tipo "Cannot read property '0' of undefined".
 *
 * Cosa fa questo file:
 * 1. Timeout → se non risponde entro 60 secondi, interrompe
 * 2. Retry → se è un errore temporaneo, riprova fino a 3 volte
 * 3. Parsing sicuro → controlla che la risposta abbia il formato atteso
 */

import { AppError, isRetryableHttpStatus, isRetryableError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 60_000; // 60 secondi massimo di attesa per risposta
const DEFAULT_MAX_RETRIES = 3; // numero massimo di tentativi
const RETRY_BASE_DELAY_MS = 1_500; // pausa base tra un tentativo e l'altro

// Funzione di pausa: aspetta X millisecondi prima di riprovare
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() con timer di sicurezza.
 * Se la richiesta non finisce entro timeoutMs, la interrompe (abort).
 */
export const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController(); // oggetto Node per annullare la richiesta
  const timer = setTimeout(() => controller.abort(), timeoutMs); // scatta dopo timeoutMs
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      // Il timer è scattato: Google non ha risposto in tempo
      throw new AppError(`Timeout Gemini dopo ${timeoutMs}ms`, {
        code: 'GEMINI_TIMEOUT',
        retryable: true, // spesso basta riprovare
        step: options.step,
        cause: err,
      });
    }
    // Problema di rete generico (wifi, DNS, ecc.)
    throw new AppError(`Errore rete Gemini: ${err.message}`, {
      code: 'GEMINI_NETWORK',
      retryable: isRetryableError(err),
      step: options.step,
      cause: err,
    });
  } finally {
    clearTimeout(timer); // pulisce il timer se la richiesta finisce prima
  }
};

/**
 * Estrae e converte in oggetto JavaScript il JSON che Gemini mette nella risposta.
 *
 * Gemini risponde con una struttura annidata:
 * data.candidates[0].content.parts[0].text → stringa JSON
 *
 * Controlliamo ogni passaggio per non crashare se manca qualcosa.
 */
export const extractGeminiJsonText = (data, step) => {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new AppError(
      blockReason
        ? `Risposta Gemini bloccata (${step}): ${blockReason}` // es. contenuto sensibile
        : `Risposta Gemini vuota (${step})`,
      { code: 'GEMINI_EMPTY', retryable: false, step }
    );
  }
  try {
    return JSON.parse(text); // converte stringa JSON → oggetto
  } catch (err) {
    throw new AppError(`JSON Gemini non valido (${step}): ${err.message}`, {
      code: 'GEMINI_PARSE',
      retryable: false, // JSON rotto = problema del modello, riprovare non aiuta
      step,
      cause: err,
    });
  }
};

/**
 * Funzione principale: chiama Gemini e restituisce un oggetto JSON già parsato.
 *
 * Usata da shaper.js (F1) e refiner.js (F3).
 */
export const callGeminiJson = async ({
  url,
  body,
  step,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
}) => {
  let lastError = null;

  // Ciclo di tentativi: attempt 0 = primo tentativo, poi retry
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        step,
      }, timeoutMs);

      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        // A volte i server rispondono con HTML di errore invece di JSON
        throw new AppError(`Risposta HTTP non JSON (${step})`, {
          code: 'GEMINI_HTTP_PARSE',
          retryable: isRetryableHttpStatus(response.status),
          step,
          cause: parseErr,
        });
      }

      if (!response.ok) {
        // Google ha risposto ma con errore (401, 429, 500...)
        const apiMsg = data?.error?.message || `HTTP ${response.status}`;
        throw new AppError(`Google API Error (${step}): ${apiMsg}`, {
          code: 'GEMINI_API',
          retryable: isRetryableHttpStatus(response.status),
          step,
        });
      }

      return extractGeminiJsonText(data, step);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AppError ? err.retryable : isRetryableError(err);
      // Se non è retryable O abbiamo esaurito i tentativi → lancia l'errore
      if (!retryable || attempt >= maxRetries) throw err;
      const delay = RETRY_BASE_DELAY_MS * (attempt + 1); // aspetta sempre di più ad ogni retry
      console.warn(`⚠️ ${step}: retry ${attempt + 1}/${maxRetries} tra ${delay}ms — ${err.message}`);
      await sleep(delay);
    }
  }

  throw lastError;
};
