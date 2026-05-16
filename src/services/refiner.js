/**
 * SERVIZIO: REFINER (F3) - REST VERSION
 * Scopo: Analizzare i contenuti di Tavily e sintetizzarli via chiamata HTTP diretta.
 */

import dotenv from 'dotenv';

dotenv.config();

/**
 * Funzione principale per raffinare i risultati usando fetch (Bypass SDK)
 * @param {string} topic - L'argomento della ricerca
 * @param {Array} rawSources - I risultati grezzi estratti da Tavily
 */
export const refineResults = async (topic, rawSources) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  // Puntiamo alla v1 stabile: gemini-1.5-flash è il più affidabile per l'estrazione dati
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;

  // 1. Preparazione del contesto dalle fonti
  const context = rawSources
    .map(s => `FONTE [${s.title}]: ${s.content}`)
    .join("\n\n---\n\n");

  // 2. Definizione del prompt
  const promptText = `Sei l'analista dati del sistema PRISM. 
  Il tuo compito è estrarre informazioni chiave e verificate sull'argomento: "${topic}".
  
  CONTESTO RECUPERATO DAL WEB:

  ${context}

  ISTRUZIONI:
  1. Estrai solo fatti concreti, numeri, date, leggi e citazioni rilevanti.
  2. Elimina i duplicati.
  3. Mantieni un tono neutro e oggettivo.
  4. RISPONDI ESCLUSIVAMENTE IN FORMATO JSON (un array di stringhe).
  
  Esempio: ["Fatto 1", "Fatto 2"]`;

  // 3. Esecuzione chiamata REST
  try {
    console.log("💎 F3: Raffinamento dati via REST (Gemini 1.5 Flash)...");

    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: promptText }]
        }]
      })
    });

    const data = await response.json();

    // Gestione errori API
    if (!response.ok) {
      console.error("❌ Errore API Google (F3):", data);
      // Se è un 503, BullMQ gestirà il retry
      throw new Error(`Google API Error: ${data.error?.message || 'Unknown error'}`);
    }

    // 4. Estrazione e pulizia output
    const rawText = data.candidates[0].content.parts[0].text;
    const cleanJson = rawText.replace(/```json|```/g, "").trim();
    
    const facts = JSON.parse(cleanJson);
    console.log(`✅ Fatti estratti con successo: ${facts.length}`);
    
    return facts;

  } catch (error) {
    console.error("❌ Errore critico nel Refiner (REST):", error.message);
    throw error; // Rilanciamo per il Worker
  }
};