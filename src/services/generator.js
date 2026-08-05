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
const CAROUSEL_SCHEMA_VERSION = '1.0';
const CAROUSEL_ROLES = new Set(['hook', 'context', 'problem', 'proof', 'method', 'desire', 'cta']);
const CAROUSEL_EMPHASIS = new Set(['headline', 'metric', 'cta']);
const CAROUSEL_TARGETS = new Set(['linkedin', 'instagram']);
const CAROUSEL_ASPECTS = new Set(['1:1', '4:5']);

/** Mappa piattaforma normalizzata al target carosello atteso */
const platformToCarouselTarget = (platformLabel = '') => {
  const raw = String(platformLabel).toLowerCase();
  return raw === 'instagram' ? 'instagram' : 'linkedin';
};

/**
 * Modalità output: testo classico o carosello JSON.
 * Default text per retrocompatibilità API.
 * @param {object} input
 * @returns {'text'|'carousel'}
 */
const resolveOutputFormat = (input = {}) => {
  const raw = String(input.outputFormat || input.formatoOutput || 'text')
    .trim()
    .toLowerCase();
  return raw === 'carousel' || raw === 'carosello' ? 'carousel' : 'text';
};

/** Estrae un blocco JSON anche se Gemini aggiunge testo/accessori */
const extractJsonObject = (rawText = '') => {
  const text = String(rawText || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
};

/** Converte la lingua in minuscolo stabile (es. Italiano -> italiano) */
const normalizeLanguageValue = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase();

/**
 * Valida in modo deterministico il Carousel Spec JSON.
 * Non usa dipendenze esterne: controlli hard sui campi richiesti.
 * @returns {{ok:boolean, errors:string[]}}
 */
const validateCarouselSpec = (spec, { expectedTone, expectedLanguage, expectedTarget } = {}) => {
  const errors = [];
  const isObj = spec && typeof spec === 'object' && !Array.isArray(spec);
  if (!isObj) return { ok: false, errors: ['Root non è un oggetto JSON.'] };

  const requiredRoot = [
    'schema_version',
    'platform',
    'targets',
    'aspect_ratio',
    'tone',
    'language',
    'topic',
    'slide_count',
    'slides',
    'hashtags',
  ];
  for (const k of requiredRoot) {
    if (!(k in spec)) errors.push(`Campo root mancante: ${k}`);
  }

  if (spec.schema_version !== CAROUSEL_SCHEMA_VERSION) {
    errors.push(`schema_version deve essere "${CAROUSEL_SCHEMA_VERSION}"`);
  }
  if (spec.platform !== 'carosello') {
    errors.push('platform deve essere "carosello"');
  }
  if (!Array.isArray(spec.targets) || spec.targets.length < 1 || spec.targets.length > 2) {
    errors.push('targets deve essere array con 1 o 2 valori');
  } else {
    const dedup = new Set(spec.targets);
    if (dedup.size !== spec.targets.length) errors.push('targets contiene duplicati');
    for (const t of spec.targets) {
      if (!CAROUSEL_TARGETS.has(String(t))) errors.push(`target non valido: ${t}`);
    }
    if (expectedTarget && !spec.targets.includes(expectedTarget)) {
      errors.push(`targets deve includere il target della piattaforma: ${expectedTarget}`);
    }
  }
  if (!CAROUSEL_ASPECTS.has(String(spec.aspect_ratio))) {
    errors.push('aspect_ratio deve essere "1:1" o "4:5"');
  }
  if (typeof spec.tone !== 'string' || !spec.tone.trim()) {
    errors.push('tone deve essere stringa non vuota');
  } else if (expectedTone && spec.tone !== expectedTone) {
    errors.push(`tone deve essere ${expectedTone}`);
  }
  if (typeof spec.language !== 'string' || !spec.language.trim()) {
    errors.push('language deve essere stringa non vuota');
  } else if (spec.language !== normalizeLanguageValue(spec.language)) {
    errors.push('language deve essere in minuscolo');
  } else if (expectedLanguage && spec.language !== expectedLanguage) {
    errors.push(`language deve essere ${expectedLanguage}`);
  }
  if (typeof spec.topic !== 'string' || spec.topic.trim().length < 3) {
    errors.push('topic troppo corto o mancante');
  }
  if (!Number.isInteger(spec.slide_count) || spec.slide_count < 5 || spec.slide_count > 10) {
    errors.push('slide_count deve essere intero tra 5 e 10');
  }
  if (!Array.isArray(spec.slides)) {
    errors.push('slides deve essere un array');
  } else {
    if (spec.slides.length !== spec.slide_count) {
      errors.push('slide_count deve coincidere con slides.length');
    }
    for (let i = 0; i < spec.slides.length; i++) {
      const s = spec.slides[i];
      const path = `slides[${i}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        errors.push(`${path} non è un oggetto`);
        continue;
      }
      const requiredSlide = ['index', 'role', 'headline', 'body', 'metric', 'visual_hint', 'cta', 'emphasis'];
      for (const k of requiredSlide) {
        if (!(k in s)) errors.push(`${path}.${k} mancante`);
      }
      if (s.index !== i + 1) errors.push(`${path}.index deve essere ${i + 1}`);
      if (!CAROUSEL_ROLES.has(String(s.role))) errors.push(`${path}.role non valido`);
      if (typeof s.headline !== 'string' || s.headline.length < 3 || s.headline.length > 60) {
        errors.push(`${path}.headline fuori limite (3..60)`);
      }
      if (typeof s.body !== 'string' || s.body.length > 140) {
        errors.push(`${path}.body fuori limite (<=140)`);
      }
      if (typeof s.visual_hint !== 'string' || s.visual_hint.length > 80) {
        errors.push(`${path}.visual_hint fuori limite (<=80)`);
      }
      if (!CAROUSEL_EMPHASIS.has(String(s.emphasis))) {
        errors.push(`${path}.emphasis non valido`);
      }
      if (s.metric !== null) {
        const m = s.metric;
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
          errors.push(`${path}.metric deve essere null o oggetto`);
        } else {
          if (typeof m.value !== 'string' || !m.value.trim() || m.value.length > 40) {
            errors.push(`${path}.metric.value non valido`);
          }
          if (typeof m.label !== 'string' || !m.label.trim() || m.label.length > 140) {
            errors.push(`${path}.metric.label non valido`);
          }
          if (m.implication != null && (typeof m.implication !== 'string' || m.implication.length > 80)) {
            errors.push(`${path}.metric.implication fuori limite (<=80)`);
          }
        }
      }
      if (s.cta !== null && (typeof s.cta !== 'string' || s.cta.length > 60)) {
        errors.push(`${path}.cta deve essere null o string <=60`);
      }
      // Slide 1 sempre hook, ultima sempre cta
      if (i === 0 && s.role !== 'hook') errors.push('slides[0].role deve essere "hook"');
      if (i === spec.slides.length - 1 && s.role !== 'cta') {
        errors.push(`slides[${i}].role deve essere "cta"`);
      }
      // Solo ultima slide può avere cta valorizzata
      if (i !== spec.slides.length - 1 && s.cta !== null) {
        errors.push(`${path}.cta deve essere null fuori dall'ultima slide`);
      }
    }
  }
  if (!Array.isArray(spec.hashtags) || spec.hashtags.length < 3 || spec.hashtags.length > 5) {
    errors.push('hashtags deve avere 3..5 elementi');
  } else {
    for (let i = 0; i < spec.hashtags.length; i++) {
      const h = spec.hashtags[i];
      if (typeof h !== 'string' || !/^[a-z0-9_]{2,40}$/.test(h)) {
        errors.push(`hashtags[${i}] non valido (solo minuscolo/numero/underscore)`);
      }
    }
  }
  if (spec.notes_for_design != null && (typeof spec.notes_for_design !== 'string' || spec.notes_for_design.length > 180)) {
    errors.push('notes_for_design fuori limite (<=180)');
  }

  return { ok: errors.length === 0, errors };
};

/** Parse + validazione hard carosello; lancia AppError dettagliato */
const parseAndValidateCarouselSpec = (rawText, ctx) => {
  const candidate = extractJsonObject(rawText);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new AppError('Output carosello non valido: JSON non parsabile.', {
      code: 'CAROUSEL_JSON_INVALID',
      retryable: true,
      step: 'generation',
    });
  }
  const validation = validateCarouselSpec(parsed, ctx);
  if (!validation.ok) {
    throw new AppError(
      `Output carosello non valido: ${validation.errors.slice(0, 6).join(' | ')}`,
      {
        code: 'CAROUSEL_SCHEMA_INVALID',
        retryable: true,
        step: 'generation',
      },
    );
  }
  return parsed;
};

/**
 * Helper riusabile da worker/API: valida il testo carosello e restituisce JSON canonicale.
 * @param {string} rawText
 * @param {{ expectedTone?: string, expectedLanguage?: string, expectedTarget?: string }} ctx
 * @returns {string} JSON string validato
 */
export const validateCarouselOutputText = (rawText, ctx = {}) => {
  const parsed = parseAndValidateCarouselSpec(rawText, ctx);
  return JSON.stringify(parsed);
};

/** Chiama Gemini e restituisce il testo grezzo della prima candidate */
const callGeminiRawText = async (url, systemInstruction, userPrompt) => {
  const response = await fetch(url, {
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
  return String(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
};

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
  outputFormat = 'text',
  language,
  topic,
  instructions = '',
  previousContent = '',
  bypassDataCutting = false,
  compressedFacts = [],
}) => {
  const platformLabel = normalizePlatform(platform);
  const isCarousel = outputFormat === 'carousel';
  // Per il formato carosello usiamo il prompt piattaforma "carosello",
  // mentre PIATTAFORMA resta il target reale (LinkedIn/Instagram).
  const promptPlatformLabel = isCarousel ? 'Carosello' : platformLabel;
  const { system, userParts } = await loadComposedPromptFromFirestore({
    toneKey,
    platform: promptPlatformLabel,
  });

  const vars = {
    LINGUA_OUTPUT: language || 'italiano',
    PIATTAFORMA: platformLabel,
    FORMATO_OUTPUT: outputFormat,
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

${isCarousel
    ? `⚠️ REQUISITO DI CONTENIMENTO TASSATIVO (HARD CONSTRAINT):
Restituisci SOLO JSON valido (schema carousel spec). Niente markdown. Niente code fence.
Niente testo prima o dopo il JSON.`
    : `⚠️ REQUISITO DI CONTENIMENTO TASSATIVO (HARD CONSTRAINT):
NON rispondere in formato JSON o XML.
VIETATO racchiudere i marcatori strutturali all'interno di blocchi di codice Markdown (NON usare i tripli backtick \`\`\`).
Stampa il testo libero del post direttamente ed esclusivamente all'interno dei delimitatori esatti:

<<<START_TONE>>>
(Inserisci qui l'intero contenuto del post completo, non interromperlo mai a metà)
<<<END_TONE>>>

GENERA L'OUTPUT RISPETTANDO I DELIMITATORI <<< >>>. NON AGGIUNGERE ALTRO PRIMA O DOPO I DELIMITATORI.`}
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
  const outputFormat = resolveOutputFormat(input);
  const isCarousel = outputFormat === 'carousel';

  const bypassDataCutting =
    typeof input.bypassDataCutting === 'boolean'
      ? input.bypassDataCutting
      : resolveBypassDataCutting(input.shaping);

  console.log(
    `🎨 F4: Generazione tono [${toneKey}] | Piattaforma [${targetPlatform}] | formato=${outputFormat} | bypass=${bypassDataCutting} | ${USE_MOCK ? 'MOCK' : 'LIVE'}`,
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
      outputFormat,
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
        text: isCarousel
          ? JSON.stringify({
            schema_version: '1.0',
            platform: 'carosello',
            targets: [String(targetPlatform || 'LinkedIn').toLowerCase() === 'instagram' ? 'instagram' : 'linkedin'],
            aspect_ratio: '4:5',
            tone: toneKey,
            language: String(input.language || 'italiano').toLowerCase(),
            topic: input.topic || 'n/d',
            slide_count: 5,
            slides: [
              { index: 1, role: 'hook', headline: 'Hook mock', body: '', metric: null, visual_hint: '', cta: null, emphasis: 'headline' },
              { index: 2, role: 'context', headline: 'Context mock', body: 'Contesto mock', metric: null, visual_hint: '', cta: null, emphasis: 'headline' },
              { index: 3, role: 'proof', headline: 'Proof mock', body: 'Prova mock', metric: null, visual_hint: '', cta: null, emphasis: 'headline' },
              { index: 4, role: 'method', headline: 'Method mock', body: 'Metodo mock', metric: null, visual_hint: '', cta: null, emphasis: 'headline' },
              { index: 5, role: 'cta', headline: 'CTA mock', body: 'Azione mock', metric: null, visual_hint: '', cta: 'Agisci ora', emphasis: 'cta' },
            ],
            hashtags: ['mock', 'prism', 'carousel'],
          })
          : `Contenuto mock per ${toneKey} su: ${input.topic || 'n/d'}`,
        authority: 'MOCK-GENERATED',
        toneKey,
      };
    }

    const rawText = await callGeminiRawText(URL, systemInstruction, userPrompt);
    if (!isCarousel) {
      const text = extractToneText(rawText);
      return { text, authority: 'DOCUMENT-BOUND MODE', toneKey };
    }

    // Carosello: validazione hard + 1 retry di auto-riparazione schema/json.
    const expectedTarget = platformToCarouselTarget(targetPlatform);
    const expectedLanguage = normalizeLanguageValue(input.language || 'italiano');
    try {
      const parsed = parseAndValidateCarouselSpec(rawText, {
        expectedTone: toneKey,
        expectedLanguage,
        expectedTarget,
      });
      return { text: JSON.stringify(parsed), authority: 'DOCUMENT-BOUND MODE', toneKey };
    } catch (firstErr) {
      console.warn(`⚠️ Carosello non valido al primo tentativo, provo auto-repair: ${firstErr.message}`);
      const repairPrompt = `
Correggi l'output seguente in JSON valido, senza aggiungere testo fuori dal JSON.
Mantieni invariati contenuto, tono e target, correggendo solo formato/schema.

OUTPUT_DA_CORREGGERE:
${rawText}
`.trim();
      const repairedRaw = await callGeminiRawText(URL, systemInstruction, repairPrompt);
      const repaired = parseAndValidateCarouselSpec(repairedRaw, {
        expectedTone: toneKey,
        expectedLanguage,
        expectedTarget,
      });
      return { text: JSON.stringify(repaired), authority: 'DOCUMENT-BOUND MODE', toneKey };
    }
  } catch (error) {
    console.error('❌ Errore Generator:', error.message);
    throw error;
  }
};
