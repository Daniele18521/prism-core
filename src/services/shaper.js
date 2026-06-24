/**
 * SHAPER & GATEKEEPER (F1) — Gemini JSON Mode
 */

import dotenv from 'dotenv';
dotenv.config();

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const getApiUrl = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

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
        provocatore: { type: 'OBJECT', properties: { status: { type: 'STRING' }, lock_reason: { type: 'STRING' } } },
        confidente: { type: 'OBJECT', properties: { status: { type: 'STRING' }, lock_reason: { type: 'STRING' } } },
        sferzante: { type: 'OBJECT', properties: { status: { type: 'STRING' }, lock_reason: { type: 'STRING' } } },
        visionario: { type: 'OBJECT', properties: { status: { type: 'STRING' }, lock_reason: { type: 'STRING' } } },
        metodologico: { type: 'OBJECT', properties: { status: { type: 'STRING' }, lock_reason: { type: 'STRING' } } },
        narratore: { type: 'OBJECT', properties: { status: { type: 'STRING' }, lock_reason: { type: 'STRING' } } },
      },
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

export const runShaperGatekeeper = async (topic) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) throw new Error('GEMINI_API_KEY non configurata.');

  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;

  const promptText = `Agisci come il Direttore Editoriale di PRISM.
INPUT UTENTE: "${topic}"

VINCOLO TEMPORALE TASSATIVO:
Anno Corrente: ${currentYear}
Anno Precedente: ${previousYear}
Ogni query generata nel 'plan' deve obbligatoriamente contenere almeno uno di questi due anni.

1. SAFETY CHECK: Se l'input contiene diffamazione, odio, pornografia o violenza, imposta is_blocked: true e un block_message professionale.

2. DIAGNOSI DEI GAP: Valuta i 3 pilastri (SCENARIO, CONTESTO, SFIDE_OPPORTUNITA).
Se l'input utente li contiene già in modo solido, segna 'OK' e imposta search_required: false.
Se mancano, segna 'GAP' e genera una query di ricerca specifica includendo l'anno ${currentYear} o ${previousYear}.

3. MATRICE DI IDONEITÀ NUOVI TONI (chiavi: provocatore, confidente, sferzante, visionario, metodologico, narratore):
- provocatore (Challenge): OFF se lutti, disastri naturali o tragedie umane. Reason: 'Richiesto rispetto solenne'.
- confidente (Empathy): Sempre ON (fallback universale).
- sferzante (Punchy): OFF se sofferenza, violenza o crisi umanitarie. Reason: 'Incompatibile con l'ironia'.
- visionario (Leadership): OFF se tema puramente storiografico/archeologico senza legami futuri. Reason: 'Tema puramente storico'.
- metodologico (Action): OFF se tema astratto/artistico/filosofico senza problema pratico. Reason: 'Nessuna leva metodologica'.
- narratore (Storytelling): Sempre ON.

OUTPUT JSON RIGIDO conforme allo schema.`;

  console.log('🧠 F1: Shaper & Gatekeeper...');

  const response = await fetch(getApiUrl(API_KEY.trim()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SHAPER_SCHEMA,
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google API Error (F1): ${data.error?.message || 'Unknown'}`);
  }

  const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
  console.log(`✅ F1 completata. blocked=${parsed.is_blocked}, search_required=${parsed.search_required}`);
  return parsed;
};

/** @deprecated */
export const generateQueries = async (topic) => {
  const out = await runShaperGatekeeper(topic);
  return (out.plan || []).map((p) => p.query);
};
