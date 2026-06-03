/**
 * SERVIZIO: GENERATOR (F4) - PROFILE-AWARE DYNAMIC ENGINE [PAY-AS-YOU-GO & PARSER OPTIMIZED]
 * Scopo: Generazione Multi-Pass con estrazione testuale blindata e diagnostica orientata all'output dell'LLM.
 * MODALITÀ: Switch tra LIVE (Gemini) e MOCK (Simulazione) via .env
 */

import dotenv from 'dotenv';
import redis from '../utils/redis.js';

dotenv.config();

// SWITCH: Legge la variabile d'ambiente. Se "true", attiva il MOCK mode.
const USE_MOCK = process.env.USE_MOCK_GENERATOR === 'true';

export const generateTones = async (input, verifiedFacts, sourcesPreview, verifiedImages = [], verifiedTables = []) => {
  const targetPlatform = input.platform.toLowerCase();
  const userProfile = (input.profile || 'basic').toLowerCase();

  console.log(`🎨 Fase 4: Esecuzione ${USE_MOCK ? '[MOCK MODE]' : '[LIVE MODE]'} per Profilo [${userProfile.toUpperCase()}] su [${targetPlatform.toUpperCase()}]...`);

  const API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
  if (!USE_MOCK && !API_KEY) {
    console.error("❌ [CRITICO] GEMINI_API_KEY non configurata per modalità LIVE!");
    throw new Error("Mancano le credenziali API.");
  }

  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
  const fontiTestuali = sourcesPreview.length > 0 ? sourcesPreview.map(s => `FONTE: ${s.title} [URL: ${s.url}]`).join("\n") : "NULL";

  const finalTones = {};
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    const [profileAllowedTonesRaw, coreRules, epistemeRules, platformRules] = await Promise.all([
      redis.hget('prism:config:profiles', userProfile),
      redis.get('prism:config:core'),
      redis.get('prism:config:episteme'),
      redis.hget('prism:config:platforms', targetPlatform)
    ]);

    if (!coreRules || !platformRules || !profileAllowedTonesRaw) {
      throw new Error("Errore critico: Configurazione incompleta su Redis.");
    }

    let allowedTones = profileAllowedTonesRaw.split(',').map(t => t.trim());

    if (input.singleToneTarget) {
      if (allowedTones.includes(input.singleToneTarget)) allowedTones = [input.singleToneTarget];
      else throw new Error(`Profilo non autorizzato per il tono: ${input.singleToneTarget}`);
    }

    for (const currentTone of allowedTones) {
      const toneTemplate = await redis.hget('prism:config:tones', currentTone);
      if (!toneTemplate) continue;

      // PROMPT COMPLETO ORIGINALE
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

        [[ DATI DI INPUT ]]
        ARGOMENTO: "${input.topic || 'Nessun argomento'}"
        FONTI DISPONIBILI: "${(verifiedFacts && verifiedFacts.length > 0) ? verifiedFacts.join(" | ") : 'Nessun fatto'} \n\n ${fontiTestuali}"
        LINGUA_OUTPUT: "${input.language || 'it'}"
      
        GENERA L'OUTPUT RISPETTANDO I DELIMITATORI <<< >>>. NON AGGIUNGERE ALTRO PRIMA O DOPO I DELIMITATORI. COMPLETA TUTTI I DISCORSI.
      `;

      // STAMPA SEMPRE IL PROMPT (Diagnostica)
      console.log(`\n--- PROMPT INPUT PER ${currentTone} ---\n${singlePrompt}\n------------------------------------------\n`);

      let extractedText = "";
      let authorityMode = "DOCUMENT-BOUND MODE";

      if (USE_MOCK) {
        // --- LOGICA MOCK: Restituisce un contenuto simulato ma correttamente formattato ---
        console.log(`🧪 [MOCK] Simulazione completata per ${currentTone}`);
        extractedText = `Contenuto generato in simulazione per il tono ${currentTone}. <<<START_TONE>>>Questo è il testo del post mockato riguardante: ${input.topic}<<<END_TONE>>>`;
        authorityMode = "MOCK-GENERATED";
      } else {
        // --- LOGICA LIVE: Chiamata reale a Gemini ---
        const response = await fetch(URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: singlePrompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
          })
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        
        // PARSER ORIGINALE
        const startTag = "<<<START_TONE>>>";
        const endTag = "<<<END_TONE>>>";
        let startIndex = rawText.indexOf(startTag);
        let endIndex = rawText.indexOf(endTag);
        
        extractedText = (startIndex !== -1 && endIndex !== -1) 
          ? rawText.substring(startIndex + startTag.length, endIndex).trim() 
          : rawText.trim();
      }

      finalTones[currentTone] = { text: extractedText, authority: authorityMode };
      
      if (!USE_MOCK) await delay(2000);
    }

    return finalTones;
  } catch (error) {
    console.error("❌ Errore:", error.message);
    throw error;
  }
};