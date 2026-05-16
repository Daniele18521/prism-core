/**
 * SERVIZIO: GENERATOR (F4) - PROFILE-AWARE DYNAMIC ENGINE
 * Scopo: Generazione Multi-Pass con controllo accessi nativo tramite tabella profili su Redis.
 * Vantaggi: Gestione commerciale (Basic/Pro/Enterprise) 100% delegata al Database.
 */

import dotenv from 'dotenv';
import redis from '../utils/redis.js';

dotenv.config();

export const generateTones = async (input, verifiedFacts, sourcesPreview) => {
  // Recuperiamo la piattaforma e il profilo dell'utente dall'input
  const targetPlatform = input.platform.toLowerCase();
  const userProfile = (input.profile || 'basic').toLowerCase(); // Default di sicurezza su 'basic'

  console.log(`🎨 Fase 4: Esecuzione motore autorizzato per Profilo [${userProfile.toUpperCase()}] su [${targetPlatform.toUpperCase()}]...`);

  const API_KEY = process.env.GEMINI_API_KEY;
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;

  const fontiTestuali = sourcesPreview.length > 0 
    ? sourcesPreview.map(s => `FONTE: ${s.title} [URL: ${s.url}]`).join("\n")
    : "NULL";

  const finalTones = {};

  try {
    // 1. RECUPERO REGOLE AMBIENTE + CONFIGURAZIONE DEL PROFILO UTENTE DA REDIS
    const [profileAllowedTonesRaw, coreRules, epistemeRules, platformRules] = await Promise.all([
      redis.hget('prism:config:profiles', userProfile), // 👈 Interroga la tabella dei profili
      redis.get('prism:config:core'),
      redis.get('prism:config:episteme'),
      redis.hget('prism:config:platforms', targetPlatform)
    ]);

    if (!coreRules || !platformRules) {
      throw new Error(`Errore critico: Configurazione Core o Piattaforma (${targetPlatform}) assente su Redis.`);
    }

    if (!profileAllowedTonesRaw) {
      console.warn(`⚠️ Profilo '${userProfile}' non censito nella tabella profili di Redis. Blocco cautelativo.`);
      return finalTones;
    }

    // Trasformiamo la stringa dei toni abilitati (es: "tone_1,tone_2") in un array pulito
    const allowedTones = profileAllowedTonesRaw.split(',').map(t => t.trim());
    console.log(`🔒 Il profilo [${userProfile.toUpperCase()}] ha diritto a ${allowedTones.length} toni: [${allowedTones.join(', ')}]`);

    // 2. CICLO DI GENERAZIONE SULLE CHIAVI AUTORIZZATE DAL PROFILO
    for (const currentTone of allowedTones) {
      console.log(`✍️ Elaborazione modulo autorizzato da Tabella: ${currentTone}...`);

      // Recuperiamo il template del tono solo se l'utente è abilitato
      const toneTemplate = await redis.hget('prism:config:tones', currentTone);
      if (!toneTemplate) {
        console.warn(`⚠️ Template per ${currentTone} abilitato nel profilo ma assente nei moduli toni di Redis. Salto.`);
        continue;
      }

      // 3. ASSEMBLAGGIO DEL MASTER PROMPT (Invariato)
      const passPrompt = `
        ${coreRules}
        ${epistemeRules}
        ${platformRules}

        [[ INFORMAZIONI SPECIFICHE DEL TONO CORRENTE ]]
        ${toneTemplate}
        
        ⚠️ REQUISITO DI CONTENIMENTO TASSATIVO:
        NON rispondere in formato JSON. Rispondi con testo libero racchiuso nei delimitatori:

        <<<START_TONE>>>
        (Inserisci qui l'intero contenuto del post)
        <<<END_TONE>>>

        [[ DATI DI INPUT ]]
        ARGOMENTO: "${input.topic}"
        FONTI DISPONIBILI: "${verifiedFacts.join(" | ")} \n\n ${fontiTestuali}"
        LINGUA_OUTPUT: "${input.language}"
        
        GENERA L'OUTPUT RISPETTANDO I DELIMITATORI <<< >>>. NON AGGIUNGERE ALTRO.
      `;

      // 4. CHIAMATA API GEMINI
      const response = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: passPrompt }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 4096,
            topP: 0.95
          }
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.error(`🔴 Errore HTTP raw dall'API per ${currentTone}:`, errData);
        throw new Error(`Google API HTTP Error status: ${response.status}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!rawText) throw new Error(`I candidati dell'API hanno restituito un payload vuoto per ${currentTone}`);

      // 5. ESTRAZIONE CHIRURGICA CON REGEX
      const toneRegex = /<<<START_TONE>>>([\s\S]*?)<<<END_TONE>>>/;
      const toneMatch = rawText.match(toneRegex);

      if (!toneMatch) {
        throw new Error(`Impossibile trovare i marcatori <<<START_TONE>>> per il blocco ${currentTone}`);
      }

      finalTones[currentTone] = {
        text: toneMatch[1].trim(),
        authority: "DOCUMENT-BOUND MODE"
      };
    }

    console.log(`✅ Successo: Estratti ${Object.keys(finalTones).length} moduli autorizzati dal profilo.`);
    return finalTones;

  } catch (error) {
    console.error("❌ Errore critico nel Generator Modulare a Profili:", error.message);
    throw error; 
  }
};