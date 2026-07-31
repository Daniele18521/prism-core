/**
 * ACCESSO AZIENDA — verifica se la company può usare un tono editoriale.
 *
 * Legge da Firestore: companies/{companyId}.enabled_tones
 * Usato dal worker (e dall'API) prima di generare/rigenerare un tono.
 */

import { db } from '../utils/firebaseAdmin.js';
import { AppError } from '../utils/errors.js';
// Catalogo toni prodotto (unica fonte di verità)
import { TONE_IDS } from './stateManager.js';

/** Toni editoriali riconosciuti (allineati a stateManager.TONE_IDS) */
const KNOWN_TONES = [...TONE_IDS];

/**
 * Normalizza un nome tono (minuscolo, underscore) per confronti stabili.
 * @param {string} tone
 * @returns {string}
 */
export const normalizeToneKey = (tone) =>
  String(tone ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

/**
 * Legge l'array enabled_tones della company da Firestore.
 * @param {string} companyId
 * @returns {Promise<string[]>}
 */
export const getCompanyEnabledTones = async (companyId) => {
  if (!companyId) {
    throw new AppError('companyId mancante: impossibile verificare i toni abilitati.', {
      code: 'COMPANY_ID_MISSING',
      retryable: false,
      step: 'generation',
    });
  }

  const snap = await db.collection('companies').doc(String(companyId)).get();
  if (!snap.exists) {
    throw new AppError(`Azienda non trovata (companyId: ${companyId}).`, {
      code: 'COMPANY_NOT_FOUND',
      retryable: false,
      step: 'generation',
    });
  }

  const data = snap.data() || {};
  // Accetta enabled_tones o enabledTones (camelCase legacy)
  const raw = data.enabled_tones ?? data.enabledTones ?? [];
  if (!Array.isArray(raw)) {
    throw new AppError('Campo enabled_tones non valido sulla company.', {
      code: 'ENABLED_TONES_INVALID',
      retryable: false,
      step: 'generation',
    });
  }

  return raw.map(normalizeToneKey).filter(Boolean);
};

/**
 * Interseca enabled_tones company con il catalogo prodotto.
 * Ordine = ordine in enabled_tones (come in Firestore).
 * @param {string[]} enabledRaw
 * @returns {string[]}
 */
export const resolveEnabledToneIds = (enabledRaw = []) => {
  const known = new Set(KNOWN_TONES);
  const out = [];
  const seen = new Set();
  for (const raw of enabledRaw) {
    const id = normalizeToneKey(raw);
    if (!id || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/**
 * Verifica che il tono sia nella lista abilitata della company.
 * In caso negativo lancia errore bloccante (non retryable).
 *
 * @param {string} companyId
 * @param {string} toneKey
 * @returns {Promise<string[]>} lista toni abilitati (utile per log)
 */
export const assertToneEnabledForCompany = async (companyId, toneKey) => {
  const tone = normalizeToneKey(toneKey);
  if (!tone || !KNOWN_TONES.includes(tone)) {
    throw new AppError(`Tono non riconosciuto: ${toneKey}`, {
      code: 'TONE_UNKNOWN',
      retryable: false,
      step: 'generation',
    });
  }

  const enabled = await getCompanyEnabledTones(companyId);
  if (!enabled.includes(tone)) {
    throw new AppError(
      `Utente non abilitato alla generazione del tono (${tone}).`,
      {
        code: 'TONE_NOT_ENABLED',
        retryable: false,
        step: 'generation',
      },
    );
  }

  return enabled;
};
