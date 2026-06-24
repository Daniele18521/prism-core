/**
 * SERVIZIO: GENERATOR (F4) - PROFILE-AWARE DYNAMIC ENGINE
 * Input: compressedFacts + sourcesPreview (schema Firestore unificato).
 */

import dotenv from 'dotenv';
import redis from '../utils/redis.js';
import { TONE_IDS } from './stateManager.js';

dotenv.config();

const USE_MOCK = process.env.USE_MOCK_GENERATOR === 'true';

export const generateTones = async (input, compressedFacts = [], sourcesPreview = [], tables = []) => {
  const targetPlatform = (input.platform || 'general').toLowerCase();
  const userProfile = (input.profile || 'basic').toLowerCase();

  console.log(`🎨 F4: Esecuzione ${USE_MOCK ? '[MOCK]' : '[LIVE]'} | Profilo [${userProfile.toUpperCase()}] | [${targetPlatform.toUpperCase()}]`);

  const API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
  if (!USE_MOCK && !API_KEY) {
    console.error("❌ [CRITICO] GEMINI_API_KEY non configurata!");
    throw new Error("Mancano le credenziali API.");
  }

  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;
  const fontiTestuali = sourcesPreview.length > 0
    ? sourcesPreview.map((s) => `FONTE: ${s.title} [URL: ${s.url}]`).join("\n")
    : "NULL";
  const fattiComprimibili = compressedFacts.length > 0
    ? compressedFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "Nessun dato strutturato disponibile.";
  const tabelleCtx = tables.length > 0 ? JSON.stringify(tables) : "Nessuna tabella.";

  const instructionsBlock = input.instructions?.trim()
    ? `\n[[ ISTRUZIONI DI RIGENERAZIONE ]]\n${input.instructions.trim()}\n`
    : '';

  const finalTones = {};
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const [profileAllowedTonesRaw, coreRules, epistemeRules, platformRules] = await Promise.all([
      redis.hget('prism:config:profiles', userProfile),
      redis.get('prism:config:core'),
      redis.get('prism:config:episteme'),
      redis.hget('prism:config:platforms', targetPlatform),
    ]);

    if (!coreRules || !platformRules || !profileAllowedTonesRaw) {
      throw new Error("Configurazione incompleta su Redis.");
    }

    let allowedTones = input.allowedTones?.length
      ? input.allowedTones.filter((t) => TONE_IDS.includes(t))
      : profileAllowedTonesRaw.split(',').map((t) => t.trim());

    if (input.singleToneTarget) {
      if (allowedTones.includes(input.singleToneTarget)) {
        allowedTones = [input.singleToneTarget];
      } else {
        throw new Error(`Profilo non autorizzato per il tono: ${input.singleToneTarget}`);
      }
    }

    for (const currentTone of allowedTones) {
      const toneTemplate = await redis.hget('prism:config:tones', currentTone);
      if (!toneTemplate) continue;

      const singlePrompt = `
        ${coreRules || ''}
        ${epistemeRules || ''}
        ${platformRules || ''}

        [[ REGOLE SPECIFICHE PER IL TONO CORRENTE ]]
        ${toneTemplate}
        
        ⚠️ REQUISITO DI CONTENIMENTO TASSATIVO (HARD CONSTRAINT):
        NON rispondere in formato JSON o XML.
        VIETATO racchiudere i marcatori strutturali all'interno di blocchi di codice Markdown (NON usare i tripli backtick \`\`\`).
        Stampa il testo libero del post direttamente ed esclusivamente all'interno dei delimitatori esatti:

        <<<START_TONE>>>
        (Inserisci qui l'intero contenuto del post completo, non interromperlo mai a metà)
        <<<END_TONE>>>

        [[ DATI DI INPUT STRUTTURATI (REFINED) ]]
        FATTI COMPRESSI:
        ${fattiComprimibili}

        TABELLE DI RIFERIMENTO:
        ${tabelleCtx}

        [[ DATI DI INPUT ]]
        ARGOMENTO: "${input.topic || 'Nessun argomento'}"
        RIFERIMENTI FONTI: ${fontiTestuali}
        LINGUA_OUTPUT: "${input.language || 'it'}"
        ${instructionsBlock}
        GENERA L'OUTPUT RISPETTANDO I DELIMITATORI <<< >>>. NON AGGIUNGERE ALTRO PRIMA O DOPO I DELIMITATORI. COMPLETA TUTTI I DISCORSI.
      `;

      console.log(`\n--- PROMPT INPUT PER ${currentTone} ---\n${singlePrompt}\n------------------------------------------\n`);

      let extractedText = "";
      let authorityMode = "DOCUMENT-BOUND MODE";

      if (USE_MOCK) {
        console.log(`🧪 [MOCK] Simulazione completata per ${currentTone}`);
        extractedText = `Contenuto mock per ${currentTone} su: ${input.topic}. <<<START_TONE>>>Testo simulato riguardante ${input.topic}<<<END_TONE>>>`;
        authorityMode = "MOCK-GENERATED";
      } else {
        const response = await fetch(URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: singlePrompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
          }),
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        const startTag = "<<<START_TONE>>>";
        const endTag = "<<<END_TONE>>>";
        const startIndex = rawText.indexOf(startTag);
        const endIndex = rawText.indexOf(endTag);

        extractedText = (startIndex !== -1 && endIndex !== -1)
          ? rawText.substring(startIndex + startTag.length, endIndex).trim()
          : rawText.trim();
      }

      finalTones[currentTone] = { text: extractedText, authority: authorityMode };

      if (!USE_MOCK) await delay(2000);
    }

    return finalTones;
  } catch (error) {
    console.error("❌ Errore Generator:", error.message);
    throw error;
  }
};
