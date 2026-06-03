/**
 * SERVIZIO: SHAPER (F1) - REST VERSION (STABLE)
 * Scopo: Generare query di ricerca ottimizzate con output JSON garantito.
 */

import dotenv from 'dotenv';
dotenv.config();

export const generateQueries = async (topic) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  
  // 1. CORREZIONE URL: Usiamo gemini-1.5-flash (il 3.1-flash-lite non esiste o non è stabile)
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;

  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;         

  const promptText = `Dato l'argomento "${topic}", genera un array JSON di 3 query di ricerca complementari.
  
    STRUTTURA QUERY:
    1. SCENARIO: Report, statistiche e dati ufficiali ${previousYear}-${currentYear}.
    2. CONTESTO: Analisi qualitative e dinamiche di mercato ${previousYear}-${currentYear}.
    3. SFIDE: Criticità, limiti e dibattiti aperti ${currentYear}.

    REGOLE:
    - Output deve essere ESCLUSIVAMENTE un array di stringhe.
    - Esempio: ["query 1", "query 2", "query 3"]
    - Non aggiungere commenti o introduzioni.`;

  try {
    console.log("🧠 F1: Generazione query strutturate (JSON Mode)...");

    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        // 2. FORZATURA JSON MODE
        generationConfig: {
          responseMimeType: "application/json", // Obbliga l'IA a rispondere in JSON
          responseSchema: {                     // Definisce lo schema atteso
            type: "ARRAY",
            items: { type: "STRING" }
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Errore API Google (F1):", data);
      throw new Error(`Google API Error: ${data.error?.message || 'Unknown error'}`);
    }

    // 3. ESTRAZIONE DIRETTA (Con JSON Mode non servono clean-up di markdown ```json)
    const rawText = data.candidates[0].content.parts[0].text;
    const queries = JSON.parse(rawText);
    
    if (Array.isArray(queries)) {
      console.log("✅ Query generate con successo:", queries);
      return queries;
    } else {
      throw new Error("L'output non è un array valido.");
    }

  } catch (error) {
    console.error("❌ Errore critico nello Shaper (REST):", error.message);
    throw error;
  }
};