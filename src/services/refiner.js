/**
 * REFINER (F3) — Sintesi SCENARIO / CONTESTO / SFIDE_OPPORTUNITA
 */

import dotenv from 'dotenv';
dotenv.config();

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const getApiUrl = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

export const refineResults = async (topic, {
  diagnosi = {},
  rawResults = [],
  searchRequired = true,
} = {}) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) throw new Error('GEMINI_API_KEY non configurata.');

  const webContext = rawResults.length > 0
    ? rawResults.map((s) => `[${s.pillar || 'WEB'}] ${s.title} (${s.url}):\n${s.content}`).join('\n\n---\n\n')
    : 'NESSUN PACCHETTO WEB — usa solo INPUT UTENTE per pilastri OK.';

  const sourcesPreview = rawResults
    .slice(0, 5)
    .map(({ title, url }) => ({ title, url }));

  const promptText = `Sei l'analista senior di PRISM. Genera il report finale mappando i dati in SCENARIO, CONTESTO, SFIDE_OPPORTUNITA.

INPUT UTENTE:
"${topic}"

DIAGNOSI GAP (OK = usa input utente al 100% | GAP = usa pacchetti web):
- SCENARIO: ${diagnosi.scenario || 'GAP'}
- CONTESTO: ${diagnosi.context || 'GAP'}
- SFIDE_OPPORTUNITA: ${diagnosi.sfide_opportunita || 'GAP'}

RICERCA WEB RICHIESTA: ${searchRequired}

PACCHETTI WEB:
${webContext}

REGOLE:
- Pilastro 'OK': Usa al 100% l'INPUT UTENTE.
- Pilastro 'GAP': Usa i PACCHETTI WEB corrispondenti per i dati certi.
- SFIDE_OPPORTUNITA: Deve contenere sia criticità che leve di successo. Se il tema è tragico, focalizzati solo sulle strategie di risoluzione.
- Output compressedFacts come array con esattamente 3 stringhe prefissate: "SCENARIO: ...", "CONTESTO: ...", "SFIDE_OPPORTUNITA: ..."

OUTPUT JSON:
{
  "compressedFacts": ["SCENARIO: ...", "CONTESTO: ...", "SFIDE_OPPORTUNITA: ..."],
  "sourcesPreview": [{ "title": "string", "url": "string" }],
  "isContextRelevant": boolean,
  "tables": []
}`;

  console.log('💎 F3: Refiner sintesi...');

  const response = await fetch(getApiUrl(API_KEY.trim()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            compressedFacts: { type: 'ARRAY', items: { type: 'STRING' } },
            sourcesPreview: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: { title: { type: 'STRING' }, url: { type: 'STRING' } },
              },
            },
            isContextRelevant: { type: 'BOOLEAN' },
            tables: { type: 'ARRAY', items: { type: 'OBJECT' } },
          },
          required: ['compressedFacts', 'sourcesPreview', 'isContextRelevant'],
        },
      },
    }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Google API Error (F3): ${result.error?.message || 'Unknown'}`);
  }

  const parsed = JSON.parse(result.candidates[0].content.parts[0].text);

  const output = {
    compressedFacts: parsed.compressedFacts || [],
    sourcesPreview: parsed.sourcesPreview?.length ? parsed.sourcesPreview : sourcesPreview,
    isContextRelevant: parsed.isContextRelevant ?? true,
    tables: parsed.tables || [],
  };

  console.log(`✅ F3 completata: ${output.compressedFacts.length} fatti.`);
  return output;
};
