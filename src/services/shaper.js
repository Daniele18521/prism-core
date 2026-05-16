/**
 * SERVIZIO: SHAPER (F1) - REST VERSION
 * Scopo: Generare query di ricerca ottimizzate bypassando l'SDK ufficiale.
 */

import dotenv from 'dotenv';

dotenv.config(); // Carica la configurazione dal file .env

/**
 * Genera query di ricerca ottimizzate partendo dal topic dell'utente.
 * Utilizza chiamate REST dirette per massima stabilità.
 */
export const generateQueries = async (topic) => {
  const API_KEY = process.env.GEMINI_API_KEY;
  // Endpoint stabile v1 con modello 1.5-flash
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`;

  // 1. Definizione del prompt per l'IA
  const promptText = `Sei un esperto ricercatore web e analista di informazioni. 
  Dato l'argomento "${topic}", genera 3 query di ricerca specifiche ed efficaci.
  
  OBIETTIVO DELLE QUERY:
  - Trovare dati recenti e statistiche aggiornate al 2025/2026.
  - Isolare report ufficiali, leggi o documenti istituzionali.
  - Individuare punti di vista critici o ostacoli sistemici.

  RISPONDI ESCLUSIVAMENTE IN FORMATO JSON (un array di stringhe). 
  Esempio: ["query 1", "query 2", "query 3"]`;

  // 2. Esecuzione chiamata REST
  try {
    console.log("🧠 F1: Generazione query via REST (Gemini 1.5 Flash)...");

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

    // Gestione errori della risposta
    if (!response.ok) {
      console.error("❌ Errore API Google (F1):", data);
      throw new Error(`Google API Error: ${data.error?.message || 'Unknown error'}`);
    }

    // 3. Estrazione e pulizia del JSON
    const rawText = data.candidates[0].content.parts[0].text;
    const cleanJson = rawText.replace(/```json|```/g, "").trim();
    
    const queries = JSON.parse(cleanJson);
    console.log("✅ Query generate con successo:", queries);
    
    return queries;

  } catch (error) {
    console.error("❌ Errore critico nello Shaper (REST):", error.message);
    throw error; // Rilanciamo l'errore per il Worker
  }
};