/**
 * CONTENT INGEST (F0) — Estrazione testo da URL tramite Tavily Extract.
 *
 * Attivo SOLO quando l'input utente è un URL valido (http/https).
 * Converte la pagina in testo pulito prima di F1 (Shaper), senza passare HTML grezzo al LLM.
 *
 * Flusso:
 *   URL → Tavily Extract (advanced) → testo troncato → topic per il pipeline F1→F4
 */

import dotenv from 'dotenv';
import { AppError } from '../utils/errors.js';
import { getTavilyClient } from '../utils/tavilyClient.js';

dotenv.config();

// Lunghezza minima accettabile dopo l'estrazione (sotto questa soglia = pagina vuota/paywall)
const MIN_EXTRACT_CHARS = 200;
// Tetto caratteri passati a Shaper/Refiner per evitare prompt troppo lunghi
const MAX_TOPIC_CHARS = 15000;
// Timeout massimo attesa risposta Tavily Extract (secondi)
const EXTRACT_TIMEOUT_SEC = 45;

/**
 * Rileva se la stringa in input è un URL http/https (non testo libero o pilastri pre-lavorati).
 * @param {string} value - Contenuto del campo topic dalla dashboard
 * @returns {boolean}
 */
export const isUrlInput = (value) => {
  // Normalizza spazi iniziali/finali
  const trimmed = String(value ?? '').trim();
  // Regex veloce: deve iniziare con http:// o https://
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // Verifica che sia un URL parsabile dal runtime Node
  try {
    const parsed = new URL(trimmed);
    // Accettiamo solo protocolli web standard (blocca javascript:, file:, ecc.)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    // URL malformato → non trattarlo come URL
    return false;
  }
};

/**
 * Tronca il testo estratto al limite massimo, cercando di non tagliare a metà parola.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
const truncateText = (text, max = MAX_TOPIC_CHARS) => {
  // Se già dentro il limite, restituisce così com'è
  const raw = String(text ?? '').trim();
  if (raw.length <= max) return raw;
  // Taglia al limite e ripulisce eventuale parola incompleta finale
  const slice = raw.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > max * 0.85) return `${slice.slice(0, lastSpace).trim()}…`;
  return `${slice.trim()}…`;
};

/**
 * Mappa errori Tavily/network in AppError con messaggi premium per l'utente finale.
 * @param {unknown} err
 * @param {string} url
 */
const mapExtractError = (err, url) => {
  // Se è già un nostro AppError (es. TAVILY_CONFIG), lo rilancia così com'è
  if (err instanceof AppError) throw err;

  const msg = String(err?.message || '').toLowerCase();
  // Timeout o problemi di rete → errore temporaneo, BullMQ può riprovare
  const retryable = (
    msg.includes('timeout')
    || msg.includes('network')
    || msg.includes('econnreset')
    || msg.includes('fetch failed')
    || msg.includes('socket hang up')
    || msg.includes('503')
    || msg.includes('502')
    || msg.includes('429')
  );

  throw new AppError(
    retryable
      ? 'Lettura pagina temporaneamente non disponibile. Riprova tra qualche istante.'
      : 'Impossibile leggere questa pagina. Incolla il testo dell\'articolo oppure verifica che il link sia pubblico.',
    {
      code: retryable ? 'EXTRACT_TRANSIENT' : 'EXTRACT_FAILED',
      retryable,
      step: 'content_ingest',
      cause: { url, originalMessage: err?.message },
    }
  );
};

/**
 * Estrae il contenuto principale di un URL con Tavily Extract (modalità advanced).
 * @param {string} url - URL http/https già validato
 * @param {object} [options]
 * @param {Function} [options.getTavilyClient] - iniettabile nei test
 * @returns {Promise<{ text: string, sourceUrl: string, sourceTitle: string, charCount: number, truncated: boolean }>}
 */
export const extractContentFromUrl = async (url, options = {}) => {
  // Permette ai test di mockare il client senza chiamate di rete reali
  // Mock nei test inietta il client; in produzione etichetta errori come content_ingest
  const resolveClient = options.getTavilyClient ?? (() => getTavilyClient({ step: 'content_ingest' }));
  const sourceUrl = String(url).trim();

  let response;
  try {
    // Client Tavily condiviso (stessa API key di F2 Search)
    const tvly = resolveClient();
    // Extract: rimuove boilerplate e restituisce testo/markdown pulito
    response = await tvly.extract([sourceUrl], {
      extractDepth: 'advanced', // gestisce meglio JS, tabelle e layout complessi
      format: 'text', // testo piano, meno rumore per Shaper/Refiner
      timeout: EXTRACT_TIMEOUT_SEC,
      includeImages: false,
      // NON usare query/chunksPerSource: serve l'articolo intero, non snippet
    });
  } catch (err) {
    // Converte l'errore grezzo in messaggio premium + flag retryable
    mapExtractError(err, sourceUrl);
  }

  // Prima pagina estratta con successo (una URL per richiesta)
  const result = response?.results?.[0];
  const failed = response?.failedResults?.[0];

  // Tavily può rispondere 200 con failedResults se la pagina è bloccata/paywall
  if (!result?.rawContent?.trim()) {
    const detail = failed?.error || 'Contenuto non disponibile o pagina protetta.';
    throw new AppError(
      'Non siamo riusciti a estrarre testo utile da questo link. Incolla il contenuto dell\'articolo manualmente.',
      {
        code: 'EXTRACT_EMPTY',
        retryable: false,
        step: 'content_ingest',
        cause: { url: sourceUrl, tavilyError: detail },
      }
    );
  }

  // Testo grezzo restituito da Tavily
  const rawContent = result.rawContent.trim();
  // Controlla che ci sia abbastanza materiale per analisi e generazione
  if (rawContent.length < MIN_EXTRACT_CHARS) {
    throw new AppError(
      'La pagina contiene troppo poco testo leggibile. Incolla il contenuto completo dell\'articolo.',
      {
        code: 'EXTRACT_TOO_SHORT',
        retryable: false,
        step: 'content_ingest',
        cause: { url: sourceUrl, charCount: rawContent.length },
      }
    );
  }

  // Applica tetto massimo per il pipeline downstream
  const text = truncateText(rawContent, MAX_TOPIC_CHARS);
  const truncated = text.length < rawContent.length;

  return {
    text,
    sourceUrl,
    sourceTitle: result.title || '',
    charCount: rawContent.length,
    truncated,
  };
};

/**
 * Risolve l'input utente: se è URL esegue F0, altrimenti passa il testo invariato.
 * @param {string} input - topic dalla dashboard (testo, pilastri o URL)
 * @param {object} [options] - opzioni per test (mock client)
 * @returns {Promise<{ inputType: 'url'|'text', originalInput: string, topic: string, sourceMeta: object|null }>}
 */
export const resolveInput = async (input, options = {}) => {
  // Conserva sempre ciò che l'utente ha digitato/incollato
  const originalInput = String(input ?? '').trim();
  // Input vuoto → errore immediato, non ha senso avviare il pipeline
  if (!originalInput) {
    throw new AppError('Inserisci un argomento, un testo o un URL valido.', {
      code: 'INPUT_EMPTY',
      retryable: false,
      step: 'content_ingest',
    });
  }

  // Percorso standard: testo libero o pilastri pre-lavorati → F0 saltato
  if (!isUrlInput(originalInput)) {
    return {
      inputType: 'text',
      originalInput,
      topic: originalInput,
      sourceMeta: null,
    };
  }

  // Percorso URL: F0 attivo → estrazione Tavily
  const extracted = await extractContentFromUrl(originalInput, options);

  return {
    inputType: 'url',
    originalInput,
    topic: extracted.text,
    sourceMeta: {
      type: 'url',
      url: extracted.sourceUrl,
      title: extracted.sourceTitle,
      charCount: extracted.charCount,
      truncated: extracted.truncated,
      extractedAt: new Date().toISOString(),
    },
  };
};
