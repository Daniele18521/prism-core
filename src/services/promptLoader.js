/**
 * PROMPT LOADER (F4) — recupera da Firestore i pezzi del prompt e li concatena.
 *
 * Schema reale Firestore (collection Prompt):
 *
 *   Prompt/config
 *     ├─ system_instructions   → Gemini systemInstruction (non nel contents)
 *     ├─ Toni/{tono}           → prompt utente
 *     └─ Piattaforma/{nome}    → prompt utente
 *
 * Ordine: system a parte; nel contents: tono → piattaforma → variabili → pilastri.
 */

import { db } from '../utils/firebaseAdmin.js';
import { AppError } from '../utils/errors.js';

/** Collection radice dei prompt (nome esatto su Firestore, con P maiuscola) */
const PROMPT_COLLECTION = 'Prompt';
/** Documento di configurazione che contiene system_instructions */
const CONFIG_DOC = 'config';
/** Sottocollection dei prompt per tono (come da schema ad albero) */
const TONI_SUBCOLLECTION = 'toni';
/** Sottocollection dei prompt per piattaforma */
const PIATTAFORMA_SUBCOLLECTION = 'piattaforma';

/**
 * Chiave documento piattaforma in Firestore (minuscolo).
 * Accetta sia "LinkedIn" (normalizzato PRISM) sia "linkedin".
 * @param {string} platform
 * @returns {'facebook'|'linkedin'|'x'}
 */
export const platformToDocId = (platform) => {
  const raw = String(platform ?? '')
    .toLowerCase()
    .trim();
  if (raw === 'facebook' || raw === 'fb') return 'facebook';
  if (raw === 'x' || raw === 'twitter') return 'x';
  // default LinkedIn (come normalizePlatform)
  return 'linkedin';
};

/**
 * Estrae il testo utile da un oggetto dati Firestore.
 * Accetta diversi nomi campo usati in console (text, content, prompt, instructions…).
 * @param {object} data
 * @param {string} [preferredField] — campo prioritario (es. system_instructions)
 * @returns {string}
 */
const extractTextFromData = (data = {}, preferredField) => {
  if (preferredField && data[preferredField] != null && String(data[preferredField]).trim()) {
    return String(data[preferredField]);
  }
  const candidates = [
    data.text,
    data.content,
    data.prompt,
    data.instructions,
    data.body,
    data.system_instructions,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c);
  }
  return '';
};

/**
 * Legge un documento e ne estrae il testo del prompt.
 * @param {FirebaseFirestore.DocumentSnapshot} snap
 * @param {string} label — path leggibile per errori
 * @param {string} [preferredField]
 * @returns {string}
 */
const readPromptText = (snap, label, preferredField) => {
  if (!snap.exists) {
    throw new AppError(`Prompt mancante su Firestore: ${label}`, {
      code: 'PROMPT_NOT_FOUND',
      retryable: false,
      step: 'generation',
    });
  }
  const text = extractTextFromData(snap.data() || {}, preferredField);
  if (!String(text).trim()) {
    throw new AppError(`Prompt vuoto su Firestore: ${label}`, {
      code: 'PROMPT_EMPTY',
      retryable: false,
      step: 'generation',
    });
  }
  return String(text);
};

/**
 * Riferimento al documento Prompt/config (system_instructions + sottocollection).
 * @returns {FirebaseFirestore.DocumentReference}
 */
const configRef = () => db.collection(PROMPT_COLLECTION).doc(CONFIG_DOC);

/**
 * Prova a leggere un doc tono/piattaforma; se manca in minuscolo, prova capitalizzato.
 * (In console a volte i doc id sono "Linkedin" / "Facebook".)
 * @param {FirebaseFirestore.CollectionReference} col
 * @param {string} docId
 * @returns {Promise<FirebaseFirestore.DocumentSnapshot>}
 */
const getDocFlexibleId = async (col, docId) => {
  let snap = await col.doc(docId).get();
  if (snap.exists) return snap;
  // Fallback: prima lettera maiuscola (es. linkedin → Linkedin)
  const titled = docId.charAt(0).toUpperCase() + docId.slice(1);
  if (titled !== docId) {
    snap = await col.doc(titled).get();
  }
  return snap;
};

/**
 * Carica i 3 blocchi prompt da Firestore.
 * system resta separato (va in Gemini systemInstruction);
 * tone + piattaforma si concatenano nel prompt utente.
 *
 * @param {{ toneKey: string, platform: string }} opts
 * @returns {Promise<{ system: string, tone: string, platform: string, userParts: string }>}
 */
export const loadComposedPromptFromFirestore = async ({ toneKey, platform }) => {
  const toneId = String(toneKey || '')
    .trim()
    .toLowerCase();
  const platformId = platformToDocId(platform);
  const cfg = configRef();

  // System da Prompt/config.system_instructions
  // Tono da Prompt/config/Toni/{tono}
  // Piattaforma da Prompt/config/Piattaforma/{piattaforma}
  const [systemSnap, toneSnap, platformSnap] = await Promise.all([
    cfg.get(),
    getDocFlexibleId(cfg.collection(TONI_SUBCOLLECTION), toneId),
    getDocFlexibleId(cfg.collection(PIATTAFORMA_SUBCOLLECTION), platformId),
  ]);

  const system = readPromptText(
    systemSnap,
    `${PROMPT_COLLECTION}/${CONFIG_DOC}.system_instructions`,
    'system_instructions',
  );
  const tone = readPromptText(
    toneSnap,
    `${PROMPT_COLLECTION}/${CONFIG_DOC}/${TONI_SUBCOLLECTION}/${toneId}`,
  );
  const platformText = readPromptText(
    platformSnap,
    `${PROMPT_COLLECTION}/${CONFIG_DOC}/${PIATTAFORMA_SUBCOLLECTION}/${platformId}`,
  );

  // Solo tono + piattaforma per il messaggio utente (system va a parte)
  const userParts = [tone, platformText].join('\n\n').trim();

  return {
    system,
    tone,
    platform: platformText,
    userParts,
  };
};

/**
 * True se lo Shaper ha segnato SCENARIO come OK (niente GAP) → BYPASS_DATA_CUTTING=TRUE.
 * @param {object} [shaping] — job.shaping da Redis/Firestore
 * @returns {boolean}
 */
export const resolveBypassDataCutting = (shaping) => {
  const scenario = String(shaping?.diagnosi?.scenario ?? '').trim().toUpperCase();
  return scenario === 'OK';
};

/**
 * Sostituisce eventuali placeholder {{NOME}} nel template; se assenti, non altera il testo.
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export const applyPromptPlaceholders = (template, vars) => {
  let out = String(template ?? '');
  for (const [key, value] of Object.entries(vars)) {
    const token = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi');
    out = out.replace(token, String(value ?? ''));
  }
  return out;
};

/**
 * Costruisce il blocco variabili da appendere al prompt concatenato.
 * @param {Record<string, string|boolean>} vars
 * @returns {string}
 */
export const buildInputVariablesBlock = (vars) => {
  const lines = [
    '[[ VARIABILI DI INPUT ]]',
    `LINGUA_OUTPUT: ${vars.LINGUA_OUTPUT ?? ''}`,
    `PIATTAFORMA: ${vars.PIATTAFORMA ?? ''}`,
    `TONO: ${vars.TONO ?? ''}`,
    `BYPASS_DATA_CUTTING: ${vars.BYPASS_DATA_CUTTING ? 'TRUE' : 'FALSE'}`,
    `ISTRUZIONI_AGGIUNTIVE: ${vars.ISTRUZIONI_AGGIUNTIVE ?? ''}`,
    `CONTENUTO_PRECEDENTE: ${vars.CONTENUTO_PRECEDENTE ?? ''}`,
    `ARGOMENTO: ${vars.ARGOMENTO ?? ''}`,
  ];
  return lines.join('\n');
};
