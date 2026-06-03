/**
 * SERVIZIO: REFINER (F3) - REST VERSION OTTIMIZZATA PER CONTENUTO E MEDIA
 * Scopo: Analizzare i testi e isolare informazioni, fatti chiave e validare immagini via chiamata HTTP diretta.
 */

// Importa la libreria dotenv per caricare le variabili d'ambiente dal file .env
import dotenv from 'dotenv';

// Inizializza la configurazione di dotenv per rendere disponibili le variabili via process.env
dotenv.config();

/**
 * Funzione principale per raffinare i risultati, filtrare i fatti e pulire le immagini
 * @param {string} topic - L'argomento o la keyword principale della ricerca
 * @param {Array} rawSources - I risultati grezzi estratti dalle API di Tavily (F2)
 * @returns {Object} Oggetto JSON validato
 */
export const refineResults = async (topic, rawSources) => {
  // Recupera la chiave API e il flag per le immagini
  const API_KEY = process.env.GEMINI_API_KEY;
  const SHOULD_PROCESS_IMAGES = process.env.PROCESS_IMAGES === 'true'; // Legge il flag dal .env
  
  // Endpoint REST (mantenuto esattamente come nel tuo codice originale)
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${API_KEY}`;

  // 1. Costruisce la stringa di contesto (Logica condizionale per risparmio token)
  const context = rawSources
    .map(s => {
      // Se il flag è attivo estraiamo le immagini, altrimenti passiamo una stringa vuota
      const imgList = (SHOULD_PROCESS_IMAGES && s.images && s.images.length > 0) 
        ? s.images.join("\n- ") 
        : "NESSUNA IMMAGINE FORNITA (NON ELABORARE).";
      
      return `FONTE [${s.title}] (URL: ${s.url}):\nCONTENUTO TESTUALE:\n${s.content}\n\nURL IMMAGINI DI QUESTA PAGINA:\n- ${imgList}`;
    })
    .join("\n\n---\n\n");

  // Istruzione dinamica per le immagini basata sul flag
  const imageInstruction = SHOULD_PROCESS_IMAGES 
    ? `Analizza gli URL delle immagini forniti. Approva solo immagini con valore informativo reale (grafici, infografiche, foto evento). Scarta loghi, icone social e banner. Crea un 'altText' descrittivo.`
    : `NON elaborare immagini. Restituisci l'array "verifiedImages" come array vuoto [].`;

  // 2. Definizione del prompt mirato (mantenuta la tua struttura originale)
  const promptText = `Sei l'analista dati e iconografo deterministico del sistema PRISM. 
  Il tuo compito è estrarre informazioni chiave verificate, dati oggettivi e selezionare ESCLUSIVAMENTE immagini coerenti sull'argomento: "${topic}".
  
  ---
  CONTESTO RECUPERATO DAL WEB (DA ANALIZZARE SCRUPOLOSAMENTE):
  ${context}

  ISTRUZIONI DI ELABORAZIONE:
  
  1. VERIFIED FACTS & METRICS: Estrai fatti concreti, numeri, statistiche, date o definizioni ufficiali direttamente supportati dal contesto. Escludi opinioni, congetture e pubblicità.
  
  2. FILTRAGGIO SEMANTICO IMMAGINI: ${imageInstruction}
  
  3. Se il CONTESTO RECUPERATO non contiene informazioni pertinenti, sufficienti o veritiere sull'argomento "${topic}", imposta "isContextRelevant" su false, lascia gli array vuoti e NON inventare informazioni per nessuna ragione.
  
  RISPONDI RISPETTANDO RIGIDAMENTE LO SCHEMA JSON RICHIESTO.`;

  // 3. Apertura del blocco try-catch
  try {
    console.log(`💎 F3: Raffinamento in corso... (Processamento Immagini: ${SHOULD_PROCESS_IMAGES ? 'ATTIVO' : 'DISATTIVATO'})`);

    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: promptText }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              isContextRelevant: { type: "BOOLEAN" },
              verifiedFacts: { type: "ARRAY", items: { type: "STRING" } },
              extractedMetrics: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    label: { type: "STRING" },
                    value: { type: "STRING" }
                  },
                  required: ["label", "value"]
                }
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
            required: ["isContextRelevant", "verifiedFacts", "extractedMetrics", "verifiedImages"]
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Errore API Google (F3):", data);
      throw new Error(`Google API Error: ${data.error?.message || 'Unknown error'}`);
    }

    const rawText = data.candidates[0].content.parts[0].text;
    const refinedData = JSON.parse(rawText);

    console.log(`✅ F3 Completato con Successo. Immagini verificate: ${refinedData.verifiedImages.length}`);
    
    return refinedData;

  } catch (error) {
    console.error("❌ Errore critico nel Refiner (REST):", error.message);
    throw error;
  }
};