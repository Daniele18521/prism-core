import { tavily } from "@tavily/core";
import dotenv from 'dotenv';

dotenv.config();

// Inizializziamo il client con la chiave del tuo .env
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

export const performWebSearch = async (queries) => {
  console.log("🌐 Ricerca in corso su Tavily...");
  
  // Eseguiamo le ricerche in parallelo per guadagnare tempo
  const searchPromises = queries.map(query => 
    tvly.search(query, {
      searchDepth: "advanced", // Più profonda per trovare dati tecnici
      maxResults: 3,           // Prendiamo i top 3 per ogni query (totale 9 fonti)
      includeAnswer: false     // Ci servono i contenuti grezzi, non il riassunto di Tavily
    })
  );

  const results = await Promise.all(searchPromises);
  
  // Uniamo tutti i risultati in un unico array di "fonti"
  return results.flatMap(res => res.results.map(source => ({
    title: source.title,
    url: source.url,
    content: source.content, // Questo è il testo che Gemini leggerà dopo
    score: source.score      // Affidabilità della fonte
  })));
};