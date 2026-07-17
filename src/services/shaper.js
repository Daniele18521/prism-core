/**
 * SHAPER & GATEKEEPER (F1) — Gemini JSON Mode
 *
 * F1 analizza il topic dell'utente e decide:
 * - se bloccare l'input (contenuti non ammessi)
 * - quali pilastri hanno GAP (servono ricerche web)
 * - quali toni editoriali sono ON/OFF
 */

import dotenv from 'dotenv';
// Client condiviso: timeout 60s + retry automatico se Google non risponde
import { callGeminiJson } from '../utils/geminiClient.js';
// Regole hard sui toni: Gemini propone, il gatekeeper decide (default ON)
import { enforceToneSuitability } from '../utils/toneGatekeeper.js';
dotenv.config();

// Modello AI usato in F1 (leggero e veloce)
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
// Costruisce l'URL completo dell'API Google passando la chiave
const getApiUrl = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

// I 6 toni editoriali che lo Shaper deve valutare (ON/OFF)
const TONE_IDS = ['provocatore', 'confidente', 'sferzante', 'visionario', 'metodologico', 'narratore'];

// Schema JSON per ogni tono: solo ON/OFF + motivo blocco
const toneSchemaEntry = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING', enum: ['ON', 'OFF'] },
    lock_reason: { type: 'STRING' },
  },
  required: ['status', 'lock_reason'],
};

// Schema completo risposta F1 — Gemini è obbligato a rispettarlo (JSON mode)
const SHAPER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_blocked: { type: 'BOOLEAN' },
    block_message: { type: 'STRING' },
    diagnosi: {
      type: 'OBJECT',
      properties: {
        scenario: { type: 'STRING' },
        context: { type: 'STRING' },
        sfide_opportunita: { type: 'STRING' },
      },
      required: ['scenario', 'context', 'sfide_opportunita'],
    },
    search_required: { type: 'BOOLEAN' },
    tone_suitability: {
      type: 'OBJECT',
      properties: {
        provocatore: toneSchemaEntry,
        confidente: toneSchemaEntry,
        sferzante: toneSchemaEntry,
        visionario: toneSchemaEntry,
        metodologico: toneSchemaEntry,
        narratore: toneSchemaEntry,
      },
      required: TONE_IDS,
    },
    plan: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          pillar: { type: 'STRING' },
          query: { type: 'STRING' },
        },
        required: ['pillar', 'query'],
      },
    },
  },
  required: ['is_blocked', 'block_message', 'diagnosi', 'search_required', 'tone_suitability', 'plan'],
};

// Collegamento chiave diagnosi interna → etichetta pilastro in output
const PILLAR_FIELDS = [
  { key: 'scenario', label: 'SCENARIO' },
  { key: 'context', label: 'CONTESTO' },
  { key: 'sfide_opportunita', label: 'SFIDE_OPPORTUNITA' },
];

// True se il valore diagnosi è "GAP" (manca informazione → serve ricerca web)
const isGap = (value) => String(value ?? '').trim().toUpperCase() === 'GAP';

/**
 * Ripara status/lock_reason quando Gemini li mescola in un unico campo.
 * Es. status: "OFFMotivo..." invece di status:"OFF" + lock_reason:"Motivo..."
 */
export const normalizeToneEntry = (entry = {}) => {
  let statusRaw = String(entry.status ?? '').trim();
  let lockReason = String(entry.lock_reason ?? entry.reason ?? '').trim();

  const lockReasonSplit = statusRaw.split(/,\s*lock_reason\s*:\s*/i);
  if (lockReasonSplit.length > 1) {
    statusRaw = lockReasonSplit[0].trim();
    if (!lockReason) lockReason = lockReasonSplit.slice(1).join(', lock_reason: ').trim();
  }

  const statusMatch = statusRaw.match(/^(ON|OFF)/i);
  let status = 'OFF';
  if (statusMatch) {
    status = statusMatch[1].toUpperCase();
    const trailing = statusRaw.slice(statusMatch[0].length).replace(/^[\s,;:–—-]+/, '').trim();
    if (trailing && !lockReason) lockReason = trailing;
  } else if (/^ON/i.test(statusRaw)) {
    status = 'ON';
  }

  lockReason = lockReason.replace(/,\s*lock_reason\s*:?\s*$/i, '').trim();

  return {
    status,
    lock_reason: status === 'ON' ? '' : lockReason,
  };
};

/** Normalizza tutti e 6 i toni dopo la risposta Gemini */
export const normalizeToneSuitability = (toneSuitability = {}) => {
  const normalized = {};
  for (const id of TONE_IDS) {
    normalized[id] = normalizeToneEntry(toneSuitability[id]);
  }
  return normalized;
};

/**
 * Corregge output Shaper quando Gemini ignora le regole:
 * - search_required true solo se c'è almeno un GAP
 * - plan vuoto se tutti OK
 * - plan solo per pilastri GAP
 * - toni ON/OFF con gatekeeper deterministico (topic obbligatorio per i toni)
 *
 * @param {object} parsed — JSON grezzo da Gemini
 * @param {string} [topic=''] — testo input (topic o estratto F0); serve al gatekeeper toni
 */
export const normalizeShaperOutput = (parsed, topic = '') => {
  const diagnosi = parsed.diagnosi || {};
  const gapPillars = PILLAR_FIELDS.filter(({ key }) => isGap(diagnosi[key]));
  const search_required = gapPillars.length > 0;

  let plan = [];
  if (search_required) {
    const gapLabels = new Set(gapPillars.map(({ label }) => label));
    const rawPlan = Array.isArray(parsed.plan) ? parsed.plan : [];
    plan = rawPlan.filter(({ pillar }) => gapLabels.has(String(pillar ?? '').trim().toUpperCase()));
    if (plan.length === 0 && rawPlan.length > 0) {
      plan = rawPlan.slice(0, gapPillars.length);
    }
  }

  // Prima ripara formato ON/OFF, poi applica regole hard (Gemini non ha l'ultima parola)
  const tonesFromModel = normalizeToneSuitability(parsed.tone_suitability);
  const tone_suitability = enforceToneSuitability(topic, tonesFromModel);

  return {
    ...parsed,
    diagnosi,
    search_required,
    plan,
    tone_suitability,
  };
};

/** Entry point F1 — analizza topic utente e restituisce diagnosi + plan + toni */
export const runShaperGatekeeper = async (topic) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) throw new Error('GEMINI_API_KEY non configurata.');

  // Anni usati nelle query web (vincolo temporale nel prompt)
  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;

  // Prompt inviato a Gemini con tutte le regole editoriali
  const promptText = `Agisci come il Direttore Editoriale di PRISM.
INPUT UTENTE: "${topic}"

VINCOLO TEMPORALE TASSATIVO:
Anno Corrente: ${currentYear}
Anno Precedente: ${previousYear}
Ogni query generata nel 'plan' deve obbligatoriamente contenere almeno uno di questi due anni.

1. SAFETY CHECK: Se l'input contiene diffamazione, odio, pornografia o violenza, imposta is_blocked: true e un block_message professionale.

2. DIAGNOSI DEI GAP: Valuta i 3 pilastri (SCENARIO, CONTESTO, SFIDE_OPPORTUNITA).
Se l'input utente li contiene già in modo solido, segna 'OK'.
Se mancano, segna 'GAP'.
- Se TUTTI i pilastri sono 'OK': search_required DEVE essere false e plan DEVE essere [] (array vuoto, nessuna query).
- Se almeno un pilastro è 'GAP': search_required DEVE essere true e plan contiene UNA voce per ogni pilastro 'GAP' (mai per quelli 'OK').
- Ogni voce di plan deve avere pillar uguale esattamente a SCENARIO, CONTESTO o SFIDE_OPPORTUNITA (non titoli descrittivi).
- Ogni query deve includere l'anno ${currentYear} o ${previousYear}.

3. MATRICE DI IDONEITÀ TONI (chiavi: provocatore, confidente, sferzante, visionario, metodologico, narratore).
Per ogni tono imposta un oggetto { "status": "ON"|"OFF", "lock_reason": "..." }.
REGOLE TASSATIVE:
- status contiene SOLO "ON" o "OFF" (nessun altro testo, mai concatenare il motivo).
- lock_reason è "" (stringa vuota) se status è "ON".
- lock_reason è una frase breve (max 120 caratteri) se status è "OFF".
- DEFAULT: ogni tono è ON. Preferisci ON in caso di dubbio.
- confidente e narratore: sempre ON.
- provocatore e sferzante OFF insieme su: lutto/funerali/vittime di tragedia OPPURE guerra/genocidio/crisi umanitaria/violenza su civili.
- visionario OFF solo tema puramente storico/archeologico senza attualità (lock_reason: "Tema puramente storico").
- metodologico OFF solo tema astratto senza problema pratico (lock_reason: "Nessuna leva metodologica").
- Politica, business, tech, scienza, attualità: TUTTI i toni ON.

OUTPUT JSON RIGIDO conforme allo schema.`;

  console.log('🧠 F1: Shaper & Gatekeeper...');

  // callGeminiJson sostituisce fetch() diretto: gestisce timeout, retry e parsing sicuro
  // topic passato a normalize → gatekeeper toni corregge falsi OFF di Gemini
  const parsed = normalizeShaperOutput(
    await callGeminiJson({
      url: getApiUrl(API_KEY.trim()),
      step: 'F1',
      body: {
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SHAPER_SCHEMA,
        },
      },
    }),
    topic,
  );
  const { diagnosi, plan = [], search_required, tone_suitability } = parsed;

  // Log toni finali (dopo gatekeeper) per debug UI/switch
  const tonesSummary = TONE_IDS.map(
    (id) => `${id}=${tone_suitability?.[id]?.status || 'OFF'}`,
  ).join(', ');
  console.log(`🎛️ Toni finali: ${tonesSummary}`);

  // Log diagnosi per debug in console
  console.log('📋 Diagnosi pilastri:', {
    SCENARIO: diagnosi?.scenario ?? 'GAP',
    CONTESTO: diagnosi?.context ?? 'GAP',
    SFIDE_OPPORTUNITA: diagnosi?.sfide_opportunita ?? 'GAP',
  });

  if (search_required && plan.length > 0) {
    console.log(`🔍 Query create (${plan.length} GAP):`);
    for (const { pillar, query } of plan) {
      console.log(`   • [${pillar}] ${query}`);
    }
  } else {
    console.log('✅ Nessuna query creata: nessun GAP rilevato.');
  }

  console.log(`✅ F1 completata. blocked=${parsed.is_blocked}, search_required=${search_required}`);
  return parsed;
};

/** @deprecated — usa runShaperGatekeeper; estrae solo le stringhe query */
export const generateQueries = async (topic) => {
  const out = await runShaperGatekeeper(topic);
  if (!out.search_required) return [];
  return (out.plan || []).map((p) => p.query);
};