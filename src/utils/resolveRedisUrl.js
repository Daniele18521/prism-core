/**
 * RISOLUZIONE URL REDIS — sceglie automaticamente locale o produzione.
 *
 * Coerente con firebaseAdmin.js: in sviluppo usa Docker locale,
 * in produzione usa Upstash (o altro Redis cloud) senza cambiare file a mano.
 *
 * Priorità:
 * 1. REDIS_URL          → override manuale (vince sempre)
 * 2. PRISM_ENV / NODE_ENV → sceglie tra REDIS_URL_LOCAL e REDIS_URL_PRODUCTION
 */

/** Default Redis Docker in locale se REDIS_URL_LOCAL non è nel .env */
const DEFAULT_LOCAL_REDIS_URL = 'redis://127.0.0.1:6379';

/**
 * Normalizza stringhe ambiente: trim e lowercase per confronti stabili.
 * @param {string|undefined} value
 * @returns {string}
 */
const norm = (value) => String(value ?? '').trim().toLowerCase();

/**
 * True se l'app gira in modalità produzione (stessa regola di Firebase Admin).
 * @returns {boolean}
 */
export const isProductionRuntime = () => norm(process.env.NODE_ENV) === 'production';

/**
 * Profilo Redis richiesto: local, production oppure auto (dedotto da NODE_ENV).
 * @returns {'local'|'production'}
 */
export const resolveRedisProfile = () => {
  // PRISM_ENV esplicito nel .env: local | production | auto
  const prismEnv = norm(process.env.PRISM_ENV);

  if (prismEnv === 'local' || prismEnv === 'development' || prismEnv === 'dev') {
    return 'local';
  }
  if (prismEnv === 'production' || prismEnv === 'prod') {
    return 'production';
  }

  // auto o non impostato → come Firebase: NODE_ENV decide
  return isProductionRuntime() ? 'production' : 'local';
};

/**
 * Maschera password nell'URL per log sicuri (non stampare segreti in console).
 * @param {string} url
 * @returns {string}
 */
export const maskRedisUrl = (url) => {
  try {
    const parsed = new URL(url);
    // Se c'è password nell'URL, la sostituisce con asterischi
    if (parsed.password) parsed.password = '****';
    return parsed.toString();
  } catch {
    // URL non standard: evita di loggare l'intera stringa
    return '[redis-url-non-valido]';
  }
};

/**
 * Restituisce l'URL Redis da usare per la connessione corrente.
 * @returns {{ url: string, profile: 'local'|'production', source: string }}
 */
export const resolveRedisUrl = () => {
  // Override totale: una sola variabile per CI o debug rapido
  const explicit = process.env.REDIS_URL?.trim();
  if (explicit) {
    return { url: explicit, profile: resolveRedisProfile(), source: 'REDIS_URL' };
  }

  const profile = resolveRedisProfile();

  if (profile === 'production') {
    const productionUrl = process.env.REDIS_URL_PRODUCTION?.trim();
    if (!productionUrl) {
      throw new Error(
        'Redis produzione non configurato. Imposta REDIS_URL_PRODUCTION nel .env (es. Upstash rediss://...).'
      );
    }
    return { url: productionUrl, profile: 'production', source: 'REDIS_URL_PRODUCTION' };
  }

  // Sviluppo: Docker locale (o URL custom in REDIS_URL_LOCAL)
  const localUrl = process.env.REDIS_URL_LOCAL?.trim() || DEFAULT_LOCAL_REDIS_URL;
  return { url: localUrl, profile: 'local', source: process.env.REDIS_URL_LOCAL ? 'REDIS_URL_LOCAL' : 'default' };
};
