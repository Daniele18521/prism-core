/**
 * GENERATOR (F4) — genera il testo di UN singolo tono editoriale.
 *
 * Nel flusso PRISM:
 * F0 URL → F1 Shaper → F2 Search → F3 Refiner → F4 questo file.
 *
 * Recupera da Firestore (schema Prompt) e li usa così:
 * 1. System Instructions (Prompt/config.system_instructions) → Gemini systemInstruction
 * 2. Tono (Prompt/config/Toni/{tono}) → parte del prompt utente
 * 3. Piattaforma (Prompt/config/Piattaforma/{piattaforma}) → parte del prompt utente
 * Poi aggiunge variabili di input + i 3 pilastri (SCENARIO/CONTESTO/SFIDE).
 *
 * Genera SOLO il tono passato in input (nessun ciclo su più toni).
 * Output: testo tra <<<START_TONE>>> e <<<END_TONE>>>.
 */

import dotenv from 'dotenv';
// Carica prompt da Firestore + helper variabili
import {
  loadComposedPromptFromFirestore,
  applyPromptPlaceholders,
  buildInputVariablesBlock,
  resolveBypassDataCutting,
  platformToDocId,
} from './promptLoader.js';
// Lista toni validi + normalizza piattaforma
import { TONE_IDS, normalizePlatform } from './stateManager.js';
import { AppError } from '../utils/errors.js';

dotenv.config();

// Se true, non chiama Gemini: restituisce testo finto (sviluppo senza spendere API)
const USE_MOCK = process.env.USE_MOCK_GENERATOR === 'true';

/**
 * Estrae il testo tra i delimitatori START/END dalla risposta grezza di Gemini.
 * @param {string} rawText
 * @returns {string}
 */
const extractToneText = (rawText) => {
  const startTag = '<<<START_TONE>>>';
  const endTag = '<<<END_TONE>>>';
  const startIndex = rawText.indexOf(startTag);
  const endIndex = rawText.indexOf(endTag);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return rawText.substring(startIndex + startTag.length, endIndex).trim();
  }
  return String(rawText || '').trim();
};

/**
 * Formatta i compressedFacts del Refiner come i 3 pilastri editoriali.
 * @param {string[]} compressedFacts
 * @returns {string}
 */
const formatPillarsBlock = (compressedFacts = []) => {
  const labels = ['SCENARIO', 'CONTESTO', 'SFIDE_OPPORTUNITA'];
  const byPillar = Object.fromEntries(labels.map((l) => [l, '']));

  for (const line of compressedFacts) {
    const m = String(line ?? '').match(/^([A-Z_]+):\s*(.+)$/s);
    if (!m) continue;
    const [, prefix, body] = m;
    if (byPillar[prefix] !== undefined) {
      byPillar[prefix] = body.trim();
    }
  }

  if (labels.every((l) => !byPillar[l]) && compressedFacts.length > 0) {
    compressedFacts.slice(0, 3).forEach((line, i) => {
      byPillar[labels[i]] = String(line ?? '').trim();
    });
  }

  return labels
    .map((label) => `${label}:\n${byPillar[label] || '(non disponibile)'}`)
    .join('\n\n');
};

/**
 * Risolve il tono da generare dall'input (un solo tono obbligatorio).
 * Accetta: toneKey | tono | singleToneTarget
 * @param {object} input
 * @returns {string}
 */
const resolveToneKey = (input = {}) => {
  const raw = input.toneKey || input.tono || input.singleToneTarget || '';
  const tone = String(raw).trim().toLowerCase();
  if (!tone || !TONE_IDS.includes(tone)) {
    throw new AppError(`Tono non valido o mancante: ${raw || '(vuoto)'}`, {
      code: 'TONE_UNKNOWN',
      retryable: false,
      step: 'generation',
    });
  }
  return tone;
};

/**
 * Assembla systemInstruction + prompt utente per UN tono.
 * @returns {Promise<{ systemInstruction: string, userPrompt: string }>}
 */
export const buildToneGenerationPrompt = async ({
  toneKey,
  platform,
  language,
  topic,
  instructions = '',
  previousContent = '',
  bypassDataCutting = false,
  compressedFacts = [],
}) => {
  const platformLabel = normalizePlatform(platform);
  const { system, userParts } = await loadComposedPromptFromFirestore({
    toneKey,
    platform: platformLabel,
  });

  const vars = {
    LINGUA_OUTPUT: language || 'italiano',
    PIATTAFORMA: platformLabel,
    TONO: toneKey,
    BYPASS_DATA_CUTTING: bypassDataCutting ? 'TRUE' : 'FALSE',
    ISTRUZIONI_AGGIUNTIVE: instructions || '',
    CONTENUTO_PRECEDENTE: previousContent || '',
    ARGOMENTO: topic || '',
  };

  const systemInstruction = applyPromptPlaceholders(system, {
    ...vars,
    BYPASS_DATA_CUTTING: vars.BYPASS_DATA_CUTTING,
  });

  const userTemplates = applyPromptPlaceholders(userParts, {
    ...vars,
    BYPASS_DATA_CUTTING: vars.BYPASS_DATA_CUTTING,
  });

  const pillarsBlock = formatPillarsBlock(compressedFacts);

  const userPrompt = `
${userTemplates}

${buildInputVariablesBlock({
  ...vars,
  BYPASS_DATA_CUTTING: bypassDataCutting,
})}

[[ PILASTRI EDITORIALI (REFINER) ]]
${pillarsBlock}

⚠️ REQUISITO DI CONTENIMENTO TASSATIVO (HARD CONSTRAINT):
NON rispondere in formato JSON o XML.
VIETATO racchiudere i marcatori strutturali all'interno di blocchi di codice Markdown (NON usare i tripli backtick \`\`\`).
Stampa il testo libero del post direttamente ed esclusivamente all'interno dei delimitatori esatti:

<<<START_TONE>>>
(Inserisci qui l'intero contenuto del post completo, non interromperlo mai a metà)
<<<END_TONE>>>

GENERA L'OUTPUT RISPETTANDO I DELIMITATORI <<< >>>. NON AGGIUNGERE ALTRO PRIMA O DOPO I DELIMITATORI.
`.trim();

  return { systemInstruction, userPrompt };
};

/**
 * Genera il testo di UN solo tono (quello passato in input).
 *
 * BYPASS_DATA_CUTTING:
 * - TRUE  se search_required=false (dati già forniti dall'utente → non tagliare)
 * - FALSE se search_required=true  (dati da search → poche Hero Metrics, resto in regen)
 *
 * @param {object} input — toneKey/tono obbligatorio, platform, language, topic,
 *   instructions, previousContent, bypassDataCutting, shaping
 * @param {string[]} compressedFacts — blocchi SCENARIO/CONTESTO/SFIDE dal Refiner
 * @returns {Promise<{ text: string, authority: string, toneKey: string }>}
 */
export const generateTones = async (input, compressedFacts = []) => {
  const toneKey = resolveToneKey(input);
  const targetPlatform = normalizePlatform(input.platform || 'general');

  const bypassDataCutting =
    typeof input.bypassDataCutting === 'boolean'
      ? input.bypassDataCutting
      : resolveBypassDataCutting(input.shaping);

  console.log(
    `🎨 F4: Generazione tono [${toneKey}] | Piattaforma [${targetPlatform}] | bypass=${bypassDataCutting} | ${USE_MOCK ? 'MOCK' : 'LIVE'}`,
  );

  const API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
  if (!USE_MOCK && !API_KEY) {
    throw new AppError('Mancano le credenziali API (GEMINI_API_KEY).', {
      code: 'GEMINI_KEY_MISSING',
      retryable: false,
      step: 'generation',
    });
  }

  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;

  try {
    const { systemInstruction, userPrompt } = await buildToneGenerationPrompt({
      toneKey,
      platform: targetPlatform,
      language: input.language || 'italiano',
      topic: input.topic || '',
      instructions: input.instructions || '',
      previousContent: input.previousContent || '',
      bypassDataCutting,
      compressedFacts,
    });

    console.log(
      `\n--- SYSTEM INSTRUCTION (${toneKey}) ---\n${systemInstruction.slice(0, 400)}...\n` +
      `--- USER PROMPT (${platformToDocId(targetPlatform)}) ---\n${userPrompt.slice(0, 600)}...\n------------------------------------------\n`,
    );

    if (USE_MOCK) {
      console.log(`🧪 [MOCK] Simulazione completata per ${toneKey}`);
      return {
        text: `Contenuto mock per ${toneKey} su: ${input.topic || 'n/d'}`,
        authority: 'MOCK-GENERATED',
        toneKey,
      };
    }

    // systemInstruction separato; temperature 0.8
    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
      }),
    });

    if (!response.ok) {
      throw new AppError(`HTTP Error Gemini: ${response.status}`, {
        code: 'GEMINI_HTTP',
        retryable: response.status === 429 || response.status >= 500,
        step: 'generation',
      });
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const text = extractToneText(rawText);

    return { text, authority: 'DOCUMENT-BOUND MODE', toneKey };
  } catch (error) {
    console.error('❌ Errore Generator:', error.message);
    throw error;
  }
};
