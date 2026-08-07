/**
 * REFINER (F3) — Sintesi SCENARIO / CONTESTO / SFIDE_OPPORTUNITA
 *
 * Prende le fonti web (F2) e produce 3 blocchi di testo:
 * - SCENARIO: fatti concreti
 * - CONTESTO: inquadramento
 * - SFIDE_OPPORTUNITA: rischi e opportunità
 *
 * Vincoli:
 * - anti-allucinazione (date/numeri devono essere nelle fonti)
 * - pertinenza all'INPUT UTENTE (scarta fatti veri ma fuori tema)
 */

// Carica variabili d'ambiente da .env
import dotenv from 'dotenv';
// Client Gemini con timeout e retry (vedi utils/geminiClient.js)
import { callGeminiJson } from '../utils/geminiClient.js';
// AppError = errore con etichetta, usato se non restano fatti verificabili
import { AppError } from '../utils/errors.js';
// Inizializza dotenv
dotenv.config();
// Modello Gemini usato per la sintesi F3
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
// Costruisce l'URL dell'endpoint generateContent
const getApiUrl = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

// Regex mesi italiani per il controllo date esplicite
const IT_MONTHS = 'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';

// Mappa parole numeriche italiane → cifre per confronto con le fonti
const IT_NUMBER_WORDS = {
  dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15,
  sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, trenta: 30,
  trentotto: 38, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80,
  novanta: 90, cento: 100,
};

// Ordine fisso dei tre pilastri in output
const PILLAR_ORDER = ['SCENARIO', 'CONTESTO', 'SFIDE_OPPORTUNITA'];

// Collegamento prefisso pilastro → chiave nella diagnosi Shaper
const PILLAR_DIAGNOSI_KEY = {
  SCENARIO: 'scenario',
  CONTESTO: 'context',
  SFIDE_OPPORTUNITA: 'sfide_opportunita',
};

// Normalizza testo per confronti: minuscolo, senza accenti, numeri in cifre
const normalizeForMatch = (text) => {
  // Converte in stringa e lowercase
  let t = String(text ?? '').toLowerCase()
    // Rimuove diacritici
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');
  // Sostituisce parole numeriche con cifre
  for (const [word, num] of Object.entries(IT_NUMBER_WORDS)) {
    t = t.replace(new RegExp(`\\b${word}\\b`, 'g'), String(num));
  }
  // Restituisce testo normalizzato
  return t;
};

// Estrae gli ID sorgente [S1], [S2], … da una frase
const extractCitationIds = (text) => [...text.matchAll(/\[(S\d+)\]/gi)].map((m) => m[1].toUpperCase());

// Estrae date esplicite tipo "15 marzo 2026" dal testo
const extractExplicitDates = (text) => {
  // Pattern giorno + mese + anno opzionale
  const re = new RegExp(`\\b(\\d{1,2})\\s+(${IT_MONTHS})(?:\\s+(\\d{4}))?\\b`, 'gi');
  // Accumulatore date trovate
  const dates = [];
  // Itera tutte le occorrenze
  for (const m of text.matchAll(re)) {
    dates.push({
      day: m[1],
      month: m[2].toLowerCase(),
      year: m[3] || null,
    });
  }
  // Restituisce l'elenco date
  return dates;
};

// Estrae numeri significativi (≥10) dal testo normalizzato
const extractSignificantNumbers = (text) => {
  // Normalizza prima del match numerico
  const normalized = normalizeForMatch(text);
  // Cattura sequenze di almeno 2 cifre, deduplicate
  return [...new Set([...normalized.matchAll(/\b(\d{2,})\b/g)].map((m) => m[1]))];
};

// Verifica che una data esplicita compaia nel testo sorgente normalizzato
const dateInSource = (date, sourceNorm) => {
  // Mese senza accenti
  const month = date.month.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  // Chiave giorno+mese
  const dayMonth = `${date.day} ${month}`;
  // Giorno e mese devono essere presenti
  if (!sourceNorm.includes(dayMonth)) return false;
  // Se c'è l'anno, deve essere presente anch'esso
  if (date.year && !sourceNorm.includes(date.year)) return false;
  // Data verificata
  return true;
};

// True se il pilastro è marcato OK nella diagnosi (nessuna ricerca web richiesta)
const isPillarOk = (prefix, diagnosi) => {
  // Chiave diagnosi corrispondente al prefisso
  const key = PILLAR_DIAGNOSI_KEY[prefix];
  // Confronto case-insensitive con 'OK'
  return key && String(diagnosi[key] ?? '').trim().toUpperCase() === 'OK';
};

// Verifica che ogni frase web citi fonti e contenga solo dati presenti in esse
export const isSentenceGrounded = (sentence, sourceById) => {
  // ID sorgente citati nella frase
  const ids = extractCitationIds(sentence);
  // Senza citazione non è ancorabile al web
  if (ids.length === 0) return false;

  // Testi delle fonti citate
  const sources = ids.map((id) => sourceById[id]).filter(Boolean);
  // Citazioni a ID inesistenti → scarta
  if (sources.length === 0) return false;

  // Testo combinato delle fonti, normalizzato
  const combinedNorm = normalizeForMatch(sources.join(' '));
  // Corpo frase senza tag [Sx]
  const sentenceBody = sentence.replace(/\[(S\d+)\]/gi, '');

  // Ogni data esplicita deve esistere nella fonte
  for (const date of extractExplicitDates(sentenceBody)) {
    if (!dateInSource(date, combinedNorm)) return false;
  }

  // Ogni numero significativo deve esistere nella fonte
  for (const num of extractSignificantNumbers(sentenceBody)) {
    if (!combinedNorm.includes(num)) return false;
  }

  // Frase verificata
  return true;
};

// Filtra frasi non ancorate alle fonti per pilastri GAP
export const sanitizeCompressedFacts = (compressedFacts, rawResults, diagnosi = {}) => {
  // Senza risultati web non c'è nulla da validare
  if (!rawResults.length) return compressedFacts;

  // Mappa sourceId → titolo + contenuto
  const sourceById = Object.fromEntries(
    rawResults.map((s) => [String(s.sourceId).toUpperCase(), `${s.title || ''}\n${s.content || ''}`])
  );

  // Processa ogni blocco pilastro
  return compressedFacts.map((line) => {
    // Separa prefisso (SCENARIO/…) dal corpo
    const m = line.match(/^([A-Z_]+):\s*(.+)$/s);
    // Formato non riconosciuto → passa invariato
    if (!m) return line;

    // Prefisso e testo del blocco
    const [, prefix, body] = m;
    // Pilastro OK: contenuto da input utente, salta validazione web
    if (isPillarOk(prefix, diagnosi)) return line;

    // Suddivide il blocco in frasi
    const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
    // Frasi che superano il controllo
    const kept = [];
    // Frasi scartate
    const dropped = [];

    // Valida frase per frase
    for (const sentence of sentences) {
      if (isSentenceGrounded(sentence, sourceById)) {
        kept.push(sentence);
      } else {
        dropped.push(sentence);
      }
    }

    // Log frasi scartate
    if (dropped.length) {
      console.warn(`⚠️ F3: ${dropped.length} frase/i scartata/e (non ancorata alla fonte):`, dropped);
    }

    // Pilastro GAP senza frasi valide → ometti
    if (kept.length === 0) {
      console.warn(`⚠️ F3: pilastro ${prefix} senza fatti verificabili — blocco omesso.`);
      return null;
    }

    // Ricompone un unico blocco per il pilastro
    return `${prefix}: ${kept.join(' ')}`;
  }).filter(Boolean);
};

// Accorpa eventuali duplicati nello stesso pilastro in un solo blocco per prefisso
export const consolidatePillarBlocks = (compressedFacts) => {
  // Bucket per pilastro: array di corpi testuali
  const buckets = Object.fromEntries(PILLAR_ORDER.map((p) => [p, []]));

  // Distribuisce ogni riga nel bucket corrispondente
  for (const line of compressedFacts) {
    const m = line.match(/^([A-Z_]+):\s*(.+)$/s);
    // Ignora righe malformate
    if (!m) continue;
    const [, prefix, body] = m;
    // Aggiunge il corpo se il prefisso è uno dei tre pilastri
    if (buckets[prefix]) buckets[prefix].push(body.trim());
  }

  // Ricostruisce esattamente 3 blocchi nell'ordine canonico (solo pilastri con contenuto)
  return PILLAR_ORDER
    .filter((p) => buckets[p].length > 0)
    .map((p) => `${p}: ${buckets[p].join(' ')}`);
};

// Entry point F3: sintetizza i tre pilastri da topic + fonti web
export const refineResults = async (topic, {
  diagnosi = {},
  rawResults = [],
  searchRequired = true,
} = {}) => {
  // API key Gemini obbligatoria
  const API_KEY = process.env.GEMINI_API_KEY;
  // Errore se manca la chiave
  if (!API_KEY) throw new Error('GEMINI_API_KEY non configurata.');

  // Serializza i pacchetti web con ID sorgente e pilastro
  const webContext = rawResults.length > 0
    ? rawResults.map((s) => `[ID Sorgente: ${s.sourceId}] [PILASTRO: ${s.pillar || 'WEB'}] ${s.title} (${s.url}):\n${s.content}`).join('\n\n---\n\n')
    : 'NESSUN PACCHETTO WEB — usa solo INPUT UTENTE per pilastri OK.';

  // Anteprima fonti per Firestore (max 5)
  const sourcesPreview = rawResults
    .slice(0, 5)
    .map(({ sourceId, title, url }) => ({ sourceId, title, url }));

  // Prompt di sintesi: generico + ancorato all'argomento di input
  const promptText = `Sei l'analista senior di PRISM. Produci un report strutturato in tre pilastri editoriali.
Estrai SOLO informazioni presenti nelle fonti o nell'input utente. Non inferire, non arricchire, non correggere le fonti.

INPUT UTENTE (ARGOMENTO VINCOLANTE):
"${topic}"

DIAGNOSI GAP (OK = usa input utente al 100% | GAP = usa pacchetti web):
- SCENARIO: ${diagnosi.scenario || 'GAP'}
- CONTESTO: ${diagnosi.context || 'GAP'}
- SFIDE_OPPORTUNITA: ${diagnosi.sfide_opportunita || 'GAP'}

PACCHETTI WEB (obbligatori per pilastri GAP):
${webContext}
---

[PRE-FLIGHT — NON STAMPARE]
1) Estrai il NUCLEO TEMATICO dell'INPUT UTENTE:
   - soggetto specifico + predicato/tesi + ambito d'uso specifico.
2) Distingui NUCLEO vs DOMINIO-PADRE:
   - NUCLEO = ciò che l'utente chiede davvero.
   - DOMINIO-PADRE = categoria più ampia (contiguità tematica).
3) Nei pilastri ammetti SOLO fatti sul NUCLEO.
   Fatti sul solo DOMINIO-PADRE = FUORI TEMA → scarta.

Esempio di principio (qualsiasi argomento):
se l'input chiede un uso/caso specifico, NON riempire i pilastri con limiti generici del dominio tecnico o con framework enterprise contigui, salvo che la fonte li colleghi ESPLICITAMENTE a quel caso d'uso.

[PERTINENZA VERTICALE — HARD FAIL]
Un fatto è AMMESSO solo se supera TUTTI i test:
A) È presente in fonte (o input) — document-bound.
B) Aiuta a rispondere / sostenere / chiarire il NUCLEO dell'INPUT.
C) Resterebbe inutile o fuorviante se l'utente avesse chiesto un altro tema dello stesso dominio-padre.
D) Non è un riempitivo "interessante ma laterale".

Se un fatto fallisce anche uno solo di A–D → NON includerlo.

Vietato (salvo richiesta esplicita nell'input):
- limiti generici di capacità di un dominio tecnico non verticalizzati sul caso d'uso dell'input;
- framework di adozione/orchestrazione/processi enterprise non legati al nucleo;
- macro-trend, geopolitica, benchmark contigui non collegati al nucleo;
- esempi aneddotici fuori perimetro (anche se citabili).

[STRUTTURA OUTPUT — TASSATIVA]
- compressedFacts: ESATTAMENTE 3 stringhe, ordine fisso:
  1. "SCENARIO: …"
  2. "CONTESTO: …"
  3. "SFIDE_OPPORTUNITA: …"
- Ogni stringa = UN paragrafo continuo (no elenco, no prefissi duplicati).

[REGOLE PER PILASTRO — TUTTI E TRE SUL NUCLEO]
- SCENARIO: prove/fatti concreti che sostengono la tesi o il problema ESPRESSO nell'input.
  Domanda-guida: "Quali evidenze dimostrano proprio QUESTO punto?"
- CONTESTO: inquadramento dello stesso nucleo (perché conta in quel perimetro specifico).
  Domanda-guida: "In che cornice ha senso QUESTO argomento (non il dominio-padre)?"
- SFIDE_OPPORTUNITA: criticità/leve operative dello stesso nucleo.
  Domanda-guida: "Quali rischi/leve emergono da QUESTO problema?"

Se SCENARIO o CONTESTO non hanno fatti verticali nelle fonti → prefisso + testo vuoto.
NON compensare con materiale del dominio-padre.
isContextRelevant = false se le fonti utili sul nucleo sono minoritarie.

FEDELTÀ ALLE FONTI:
- Ogni dato web termina con citazione [Sx] prima del punto.
- Non inventare date/numeri/nomi/cause assenti.
- Non convertire tempi relativi in date assolute.
- Mantieni certezza originale (condizionali, stime, attribuzioni).
- Non fondere in una frase dati di fonti diverse.
- Ignora promo/banner/non editoriale.

TRACCIABILITÀ:
- Web: [Sx] obbligatorio.
- Input utente (pilastro OK): nessun [Sx].

OUTPUT JSON:
{
  "compressedFacts": [
    "SCENARIO: [unico blocco paragrafo]",
    "CONTESTO: [unico blocco paragrafo]",
    "SFIDE_OPPORTUNITA: [unico blocco paragrafo]"
  ],
  "sourcesPreview": [{ "sourceId": "S1", "title": "...", "url": "..." }],
  "isContextRelevant": boolean
}`;

  // Log avvio fase F3
  console.log('💎 F3: Refiner sintesi...');

  // Chiamata API Gemini in JSON mode con retry (stesso client dello Shaper)
  const parsed = await callGeminiJson({
    url: getApiUrl(API_KEY.trim()),
    step: 'F3',
    body: {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            compressedFacts: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              minItems: 3,
              maxItems: 3,
            },
            sourcesPreview: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  sourceId: { type: 'STRING' },
                  title: { type: 'STRING' },
                  url: { type: 'STRING' },
                },
              },
            },
            isContextRelevant: { type: 'BOOLEAN' },
            tables: { type: 'ARRAY', items: { type: 'OBJECT' } },
          },
          required: ['compressedFacts', 'sourcesPreview', 'isContextRelevant'],
        },
      },
    },
  });

  // Validazione anti-allucinazione (solo se ci sono fonti web)
  const sanitized = searchRequired && rawResults.length > 0
    ? sanitizeCompressedFacts(parsed.compressedFacts || [], rawResults, diagnosi)
    : (parsed.compressedFacts || []);

  // Accorpamento in 3 blocchi unici ordinati
  const compressedFacts = consolidatePillarBlocks(sanitized);

  // Se c'erano GAP ma nessun fatto supera la validazione → errore chiaro, non output vuoto silenzioso
  if (searchRequired && rawResults.length > 0) {
    const gapKeys = ['scenario', 'context', 'sfide_opportunita'].filter(
      (k) => String(diagnosi[k] ?? '').trim().toUpperCase() === 'GAP'
    );
    if (gapKeys.length > 0 && compressedFacts.length === 0) {
      throw new AppError('Refiner: nessun fatto verificabile dalle fonti web per i pilastri GAP', {
        code: 'REFINER_EMPTY',
        retryable: false,
        step: 'refiner',
      });
    }
  }

  // Oggetto output verso Redis/Firestore
  const output = {
    compressedFacts,
    sourcesPreview: parsed.sourcesPreview?.length ? parsed.sourcesPreview : sourcesPreview,
    isContextRelevant: parsed.isContextRelevant ?? true,
    tables: parsed.tables || [],
  };

  // Log riepilogo
  console.log(`✅ F3 completata: ${output.compressedFacts.length} blocchi pilastro.`);
  // Log dettaglio per ogni blocco
  for (const fact of output.compressedFacts) {
    console.log(`   ${fact}`);
  }
  // Restituisce il refiner output
  return output;
};
