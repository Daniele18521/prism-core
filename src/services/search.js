import { tavily } from "@tavily/core";
import dotenv from 'dotenv';

// Carica le variabili d'ambiente dal file .env
dotenv.config();

// Inizializza il client Tavily con la chiave API presente nelle variabili d'ambiente
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

/**
 * Esegue una ricerca web avanzata sfruttando Tavily, catturando le immagini globali 
 * restituite dall'API e associandole alle fonti per il modulo di raffinamento (F3).
 * * @param {Array<string>} queries - Elenco di query ottimizzate generate da F1
 * @returns {Object} Oggetto contenente le fonti arricchite con testi e array di immagini nativi
 */
export const performWebSearch = async (queries) => {
  console.log("🌐 Ricerca avanzata in corso su Tavily (Integrazione Immagini per Refiner ATTIVA)...");
  
  try {
    // Mappa le query in un array di promesse per eseguirle in parallelo
    const searchPromises = queries.map(query => 
      tvly.search(query, {
        searchDepth: "advanced",   // Ricerca profonda per massima autorevolezza
        maxResults: 3,             // Limita a 3 risultati testuali per query per non intasare i token
        includeAnswer: false,      // Disattiva la risposta testuale generica (lavoriamo sui dati grezzi)
        includeImages: true,       // ABILITATO: Recupera le immagini multimediali trovate nei motori di ricerca
        includeRawContent: false   // Disattivato l'HTML grezzo per ottimizzare banda e memoria RAM
      })
    );

    // Attende la risoluzione di tutte le ricerche in parallelo
    const results = await Promise.all(searchPromises);
    
    // Mappatura delle fonti e iniezione delle immagini
    const mappedSources = results.flatMap(res => {
      
      // CRITICO: Tavily deposita le immagini alla radice della risposta della query ('res.images')
      // e non all'interno dei singoli oggetti dei risultati ('source.images').
      const queryImages = res.images || [];
      
      // Normalizza l'output: estrae solo la stringa dell'URL sia se Tavily restituisce un oggetto che una stringa pura
      const cleanQueryImages = queryImages.map(img => typeof img === 'object' ? img.url : img);

      // Cicla sui risultati testuali emersi da questa specifica query
      return res.results.map(source => {
        return {
          title: source.title,
          url: source.url,
          content: source.content ? source.content.substring(0, 4000) : "", // Protezione della stringa a 4000 caratteri per i limiti di contesto
          score: source.score,
          
          // Assegna il parco immagini rilevato per questa query alla fonte.
          // In questo modo Gemini (F3) riceverà gli URL multimediali contestuali a questo blocco di dati.
          images: cleanQueryImages 
        };
      });
    });

    // Calcolo di controllo per i log (somma la lunghezza degli array immagini di ciascuna fonte)
    const totalImagesFound = mappedSources.reduce((acc, curr) => acc + (curr.images ? curr.images.length : 0), 0);

    console.log(`✅ F2 Completato: ${mappedSources.length} fonti testuali estratte contenenti un totale di ${totalImagesFound} immagini potenziali.`);

    // Ritorna le fonti strutturate pronte per essere passate al Refiner (F3) via Firestore o memoria dello State Machine
    return {
      sources: mappedSources
    };

  } catch (error) {
    console.error("❌ Errore durante l'esecuzione di performWebSearch (F2):", error);
    throw error;
  }
};