/**
 * SERVIZIO: REFINER (F3) - AGGIORNATO CON NUOVA TASSONOMIA (SCENARIO/CONTESTO/SFIDE)
 * Scopo: Analizzare i testi e isolare informazioni nelle tre categorie logiche PRISM.
 */

import dotenv from 'dotenv';
dotenv.config();

/**
 * Funzione principale per raffinare i risultati
 */
export const refineResults = async (topic, rawSources) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  const SHOULD_PROCESS_IMAGES = process.env.PROCESS_IMAGES === 'true'; 
  
  // URL mantenuto come richiesto (Gemini 2.5/2.0 Flash)
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;

  // 1. Costruzione contesto
  const context = rawSources
    .map(s => {
      const imgList = (SHOULD_PROCESS_IMAGES && s.images && s.images.length > 0) 
        ? s.images.join("\n- ") 
        : "NESSUNA IMMAGINE FORNITA.";
      
      return `FONTE [${s.title}] (URL: ${s.url}):\nCONTENUTO TESTUALE:\n${s.content}\n\nURL IMMAGINI:\n- ${imgList}`;
    })
    .join("\n\n---\n\n");

  // Istruzione dinamica per le immagini
  const imageInstruction = SHOULD_PROCESS_IMAGES 
    ? `Analizza gli URL delle immagini forniti. Approva solo grafici o foto con valore informativo reale. Scarta loghi e banner. Crea un 'altText' descrittivo.`
    : `NON elaborare immagini. Restituisci l'array "verifiedImages" come vuoto [].`;

  // 2. Definizione del prompt con nuova tassonomia
  const promptText = `Sei l'analista strategico del sistema PRISM. 
  Il tuo compito è analizzare il contesto grezzo e organizzarlo tassativamente nelle tre categorie logiche definite per l'argomento: "${topic}".
  
  ---
  CONTESTO RECUPERATO DAL WEB:
  ${context}

  ISTRUZIONI DI ELABORAZIONE:
  
  1. CLASSIFICAZIONE LOGICA:
     - [SCENARIO]: Estrai solo dati quantitativi, statistiche, numeri ufficiali, date e metriche economiche/tecniche.
     - [CONTESTO]: Estrai solo analisi qualitative, trend di mercato, visioni d'insieme, evoluzioni normative e prospettive generali.
     - [SFIDE]: Estrai solo criticità, limiti tecnologici, ostacoli burocratici, vulnerabilità e punti di frizione.

  2. REGOLE: Escludi ogni opinione personale, pubblicità o contenuto non verificato.
  
  3. FILTRAGGIO IMMAGINI: ${imageInstruction}
  
  4. RELEVANZA: Se il CONTESTO non contiene info pertinenti su "${topic}", imposta "isContextRelevant" su false.

  RISPONDI RISPETTANDO RIGIDAMENTE LO SCHEMA JSON RICHIESTO.`;

  try {
    console.log(`💎 F3: Raffinamento Tassonomia (Immagini: ${SHOULD_PROCESS_IMAGES ? 'ON' : 'OFF'})`);

    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              isContextRelevant: { type: "BOOLEAN" },
              data: {
                type: "OBJECT",
                properties: {
                  SCENARIO: { type: "STRING", description: "Dati numerici, statistiche e metriche." },
                  CONTESTO: { type: "STRING", description: "Analisi qualitativa, trend e visioni." },
                  SFIDE: { type: "STRING", description: "Criticità, limiti e ostacoli." }
                },
                required: ["SCENARIO", "CONTESTO", "SFIDE"]
              },
              verifiedImages: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    url: { type: "STRING" },
                    altText: { type: "STRING" }
                  },
                  required: ["url", "altText"]
                }
              }
            },
            required: ["isContextRelevant", "data", "verifiedImages"]
          }
        }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ Errore API Google (F3):", result);
      throw new Error(`Google API Error: ${result.error?.message || 'Unknown error'}`);
    }

    const rawText = result.candidates[0].content.parts[0].text;
    const refinedData = JSON.parse(rawText);

    console.log(`✅ F3 Completato. Tassonomia pronta per F4.`);
    return refinedData;

  } catch (error) {
    console.error("❌ Errore critico nel Refiner:", error.message);
    throw error;
  }
};