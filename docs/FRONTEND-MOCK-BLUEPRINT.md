# Blueprint mock frontend PRISM

Documento per generare mock lato frontend che simulano backend + persistenza Firestore **senza** chiamare API/worker reali.

Obiettivi mock:
- creare in modo **random** i 3 pilastri (`SCENARIO` / `CONTESTO` / `SFIDE_OPPORTUNITA`)
- generare in modo **random** i testi dei toni
- **persistere** su Firestore con lo stesso contratto del backend (`contents/{jobId}`)
- **abilitare/disabilitare** i mock via variabile `.env`
- **marcare** ogni job/test mock con `mock` nell’ID (distinguibile dai job reali)

---

## 0. Feature flag `.env` + ID mock

### 0.1 Variabile ambiente

Nel `.env` del **frontend** (Vite / Next / ecc.):

```env
# true | 1 | yes → usa mock (niente chiamate backend reali)
# false | 0 | assente → flusso reale verso API PRISM
VITE_PRISM_USE_MOCK=true
```

Nomi accettati (scegline **uno** e documentalo nel FE; preferito Vite):

| Stack | Variabile consigliata |
|-------|------------------------|
| Vite | `VITE_PRISM_USE_MOCK` |
| Next.js | `NEXT_PUBLIC_PRISM_USE_MOCK` |
| Generico | `PRISM_USE_MOCK` (solo se letturale server-side) |

**Regola di parsing:**
```ts
function isPrismMockEnabled(): boolean {
  const v = (import.meta.env.VITE_PRISM_USE_MOCK ?? "").toString().trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
```

**Comportamento:**
- `isPrismMockEnabled() === true` → tutte le chiamate `prepare-shaping` / `jobs/status` / `regenerate-tone-surgical` passano dal layer mock
- `false` → fetch reale al backend; **vietato** generare jobId con prefisso mock

Non mischiare: se il mock è OFF, nessun documento `contents` deve essere creato dal client mock.

### 0.2 Convenzione ID job (obbligatoria)

Ogni job creato in modalità mock **deve** contenere la stringa `mock` nell’ID, così in Firestore/console si distinguono subito dai job reali.

**Formato obbligatorio:**
```text
mock_<uuid>
```

Esempi validi:
- `mock_3f8a2c1e-9b4d-4e2a-8c7f-1a2b3c4d5e6f`
- `mock_171a9c2b...`

**Helper:**
```ts
function createMockJobId(): string {
  return `mock_${crypto.randomUUID()}`;
}

function isMockJobId(jobId: string): boolean {
  return String(jobId ?? "").toLowerCase().startsWith("mock_");
}
```

**Regole:**
1. `prepare-shaping` (mock) → `jobId = createMockJobId()`; document id Firestore = stesso `jobId`
2. Campo `contents/{jobId}.jobId` = stesso valore (coerente col backend)
3. Opzionale ma consigliato: campo booleano `isMock: true` sul documento (filtri UI/admin)
4. Regen mock: opera **solo** su `jobId` che passano `isMockJobId`; se arriva un id reale con mock ON → errore esplicito o no-op documentato
5. Cleanup: si possono cancellare in massa i doc con `jobId` che inizia per `mock_` / `isMock == true`

---

## 1. Contratto HTTP usato dal frontend

Base URL tipica: `http://localhost:3001` (o env).

| Metodo | Path | Ruolo |
|--------|------|--------|
| `POST` | `/api/prepare-shaping` | Avvia analisi F0→F3 (**nessun testo tono**) |
| `GET` | `/jobs/status/:userId/:jobId` | Polling stato + pilastri + toni ON/OFF |
| `POST` | `/api/regenerate-tone-surgical` | Genera/rigenera **un solo** tono |
| `GET` | `/health` | Liveness (opzionale in mock) |
| `GET` | `/ready` | Readiness Redis (opzionale in mock) |

### 1.1 `POST /api/prepare-shaping`

**Request body**
```json
{
  "userId": "string (obbligatorio)",
  "companyId": "string (obbligatorio)",
  "topic": "string (obbligatorio) — testo libero o URL",
  "platform": "linkedin | facebook | x | general (opzionale)",
  "language": "italiano (default) | inglese | ..."
}
```

**Response 200**
```json
{ "success": true, "jobId": "mock_<uuid>" }
```

**Errori**
- `400` — `{ "error": "Missing userId, companyId or topic" }`
- `500` — `{ "error": "Internal Server Error", "requestId": "..." }`

**Comportamento reale:** crea job Redis + accoda worker. Il frontend poi fa polling.

**Comportamento mock suggerito** (solo se `VITE_PRISM_USE_MOCK` attivo):
1. Genera `jobId = createMockJobId()` → sempre con prefisso `mock_`
2. (Opzionale) simula progressi intermedi in memoria per il polling
3. Dopo 1–3s (o step simulati) scrive su Firestore `contents/{jobId}` con `status: "completed"`, pilastri random, `isMock: true`
4. Restituisce subito `{ success: true, jobId }` come l’API reale

---

### 1.2 `GET /jobs/status/:userId/:jobId`

**Response 200 — in corso / completato**
```json
{
  "success": true,
  "data": {
    "jobId": "...",
    "status": "pending | ingesting | running | generating | completed | failed | blocked",
    "topic": "...",
    "originalInput": "...",
    "inputType": "text | url",
    "sourceMeta": null,
    "platform": "LinkedIn | Facebook | X",
    "language": "italiano",
    "action": "shaping_only | standard | regen_tone",
    "workerState": {
      "currentStep": "content_ingest | query_shaping | tavily_search | refiner | generation | done",
      "step": "done",
      "progress": 0.0,
      "retryCount": 0,
      "updatedAt": "ISO-8601"
    },
    "error": null,
    "research": {
      "contentIngest": { "...": "..." },
      "shaping": { "...": "..." },
      "tavily": { "rawResults": [] },
      "refiner": {
        "compressedFacts": [
          "SCENARIO: ...",
          "CONTESTO: ...",
          "SFIDE_OPPORTUNITA: ..."
        ],
        "sourcesPreview": [],
        "tables": [],
        "isContextRelevant": true
      }
    },
    "tones": {
      "provocatore": {
        "status": "ON | OFF",
        "lock_reason": "",
        "text": "",
        "version": 0,
        "type": "generation | regeneration"
      }
    }
  }
}
```

**Note sul payload status (allineato a `getJobStatusForClient`):**
- Se `status` è `completed` o `blocked` → `workerState.step = "done"` e `progress = 1`
- `research.*` può arrivare annidato sotto `research` (come dopo consolidate) **oppure** flat in Redis; il client API unifica: `job.refiner || job.research?.refiner`
- `tones[toneKey].text` è vuoto dopo prepare-shaping; si riempie solo dopo regenerate-tone

**Response failed/blocked**
```json
{
  "success": false,
  "jobId": "...",
  "status": "failed | blocked",
  "error": { "message": "...", "step": "..." },
  "...altri campi come data..."
}
```

**404**
```json
{ "success": false, "error": "JOB_NOT_FOUND" }
```

**Mock polling:**
- Step 1: `status: "running"`, `progress: 0.2`, niente refiner
- Step 2: `progress: 0.5`, shaping presente
- Step 3: `status: "completed"`, `progress: 1`, `research.refiner.compressedFacts` + `tones` ON/OFF

---

### 1.3 `POST /api/regenerate-tone-surgical`

Genera **un solo** tono su un job già analizzato.

**Request body** (accetta alias IT/EN)
```json
{
  "userId": "...",
  "companyId": "...",
  "jobId": "...",
  "tono": "provocatore",
  "toneKey": "provocatore",
  "linguaOutput": "italiano",
  "language": "italiano",
  "piattaforma": "linkedin",
  "platform": "LinkedIn",
  "argomento": "opzionale — default topic del job",
  "topic": "...",
  "istruzioniAggiuntive": "opzionale",
  "instructions": "",
  "contenutoPrecedente": "opzionale — baseline regen",
  "previousContent": ""
}
```

Obbligatori: `userId`, `companyId`, `jobId`, `tono|toneKey`, `linguaOutput|language`, `piattaforma|platform`.

**Response 200**
```json
{
  "success": true,
  "contenutoGenerato": "testo del post...",
  "jobId": "...",
  "toneKey": "provocatore"
}
```

**Errori tipici**
| Status | Caso |
|--------|------|
| `400` | Parametri mancanti / tono `status: OFF` |
| `403` | Tono non in `companies.enabled_tones` |
| `404` | Job non trovato |
| `500` | Generazione fallita / timeout |

**Comportamento reale:**
1. Check `enabled_tones`
2. Carica job (Redis → Firestore)
3. Se tono OFF → 400
4. Hydrate Redis se serve
5. Worker Gemini → salva testo + `version++` → **consolidate Firestore**
6. Risponde con `contenutoGenerato` (sincrono, fino a 120s)

**Comportamento mock:**
1. Leggi `contents/{jobId}` da Firestore
2. Verifica `tones[toneKey].status === "ON"`
3. Verifica tone in `companies/{companyId}.enabled_tones`
4. Genera testo random (o template) per piattaforma/lingua
5. Aggiorna Firestore appendendo a `tones.{toneKey}.versions`:
   - `version` = last+1 (prima volta → 1)
   - `text` = contenuto (solo `text`, non `content`)
   - `platform`, `language` dalla request
   - `regeneratedWith` / `instructions` / `createdAt`
   - aggiorna anche `contents.platform` / `contents.language` / `updatedAt` / `status`
6. Restituisci `{ success, contenutoGenerato, jobId, toneKey }`

---

## 2. Flusso UI (come il backend)

```
┌─────────────┐   prepare-shaping    ┌──────────────┐
│  Frontend   │ ──────────────────►  │ Mock / API   │
└─────────────┘   { jobId }          └──────────────┘
       │                                    │
       │  poll /jobs/status                 │ scrive progressi
       │◄───────────────────────────────────┤ + alla fine
       │  finché status=completed           │ contents/{jobId}
       │
       │  regenerate-tone-surgical (per tono)
       │───────────────────────────────────►│
       │  { contenutoGenerato }             │ merge tones.* su FS
```

**Importante:** prepare-shaping **non** produce testi. Solo:
- diagnosi / plan / search_required
- toni con `status` ON|OFF e `text: ""`
- pilastri in `research.refiner.compressedFacts`

---

## 3. Persistenza Firestore (contratto backend)

### 3.1 Collection `companies/{companyId}`

Letta dal backend prima di generare un tono.

```json
{
  "created_at": "<Timestamp>",
  "enabled_tones": [
    "provocatore",
    "confidente",
    "sferzante",
    "visionario",
    "metodologico",
    "narratore",
    "promotore"
  ]
}
```

Catalogo toni noti PRISM:
`provocatore | confidente | sferzante | visionario | metodologico | narratore | promotore`

**Mock:** leggere sempre `enabled_tones` reale (o stub locale) per filtrare quali chiavi mettere in `tones` e quali regen consentire.

---

### 3.2 Collection `contents/{jobId}`

Documento **definitivo** dopo analisi / dopo ogni regen.  
Scrittura backend: `set(payload, { merge: true })`.

**Date:** su Firestore devono essere **Timestamp nativi** (non stringhe ISO).  
Chiavi data: `createdAt`, `updatedAt`, `extractedAt`, `retrievedAt` (anche nested).

#### Schema documento (dopo prepare-shaping completed)

```ts
type ContentDoc = {
  jobId: string;                 // == document id; se mock → inizia con "mock_"
  isMock?: boolean;              // true sui documenti creati dal mock FE
  companyId: string;
  userId: string;
  topic: string;                 // testo usato in pipeline (se URL: testo estratto)
  originalInput: string;         // input utente originale
  inputType: "text" | "url";
  sourceMeta: null | {
    type: "url";
    url: string;
    title: string;
    charCount: number;
    truncated: boolean;
    extractedAt: Timestamp;
  };
  status: "completed" | "failed" | "blocked" | "generating" | ...;
  language: string;
  platform: "LinkedIn" | "Facebook" | "X";  // normalizzato
  action: string;                // tipicamente "shaping_only" in analisi
  createdAt: Timestamp;
  updatedAt: Timestamp;
  workerState: {
    currentStep: string;         // "done" se completed
    progress: number;            // 1.0 se completed
    retryCount?: number;
    updatedAt: Timestamp;
  };
  research: {
    contentIngest: object | null;
    shaping: {
      is_blocked: boolean;
      block_message: string;
      diagnosi: {
        scenario: "OK" | "GAP";
        context: "OK" | "GAP";
        sfide_opportunita: "OK" | "GAP";
      };
      search_required: boolean;
      tone_suitability: Record<string, { status: "ON"|"OFF"; lock_reason: string }>;
      plan: Array<{ pillar: "SCENARIO"|"CONTESTO"|"SFIDE_OPPORTUNITA"; query: string }>;
      suggestedQueries: string[];
      updatedAt: Timestamp | null;
    };
    tavily: { rawResults: Array<{
      sourceId?: string;
      title: string;
      url: string;
      content?: string;
      retrievedAt?: Timestamp;
      pillar?: string;
    }> };
    refiner: {
      compressedFacts: string[];  // ESATTAMENTE 3 stringhe etichettate
      sourcesPreview: Array<{ title: string; url: string }>;
      tables: unknown[];
      isContextRelevant: boolean;
    };
  };
  tones: Record<ToneId, {
    status: "ON" | "OFF";
    lock_reason: string;         // "" se ON
    /**
     * Storico bozze (Fase 4). Vuoto finché non c’è almeno una generazione.
     * L’ultima entry = versione attiva in UI.
     * NOTA backend attuale (prism-core): ancora modello flat
     *   { text, version, type } senza array versions — da migrare.
     * Il mock FE deve già usare `versions` come da prodotto.
     */
    versions: Array<{
      version: number;             // >= 1, sequenziale
      text: string;                // UNICO campo testo (niente `content` duplicato)
      platform: "LinkedIn" | "Facebook" | "X";
      language: string;            // es. "italiano" | "inglese"
      regeneratedWith: "total" | "instructions";
      instructions: string;        // max 100–2000; "" se total
      createdAt: Timestamp;        // ISO in API, Timestamp su FS
    }>;
  }>;
  error: null | { message: string; step: string };
};
```

#### Perché dopo prepare-shaping non c’è `text` “nella versione principale”

Due livelli distinti:

1. **Dopo `prepare-shaping` (analisi)**  
   I toni esistono solo come idoneità: `status` ON/OFF + `lock_reason`.  
   **Nessun testo generato** → `versions: []` (o assente).  
   Non è un bug: F4 non è ancora partita.

2. **Dopo `regenerate-tone-surgical` (prima generazione)**  
   Si crea `versions[0]` con `version: 1` e `text` pieno.  
   Non esiste un “testo root” separato dalla v1: la bozza attiva = **ultima** entry di `versions`.

#### Perché a volte vedi `content` e `text` insieme

Il backend PRISM espone/salva solo **`text`**.  
Se il mock scrive anche `content`, è un **duplicato non previsto** (alias UI/legacy).  
**Regola mock:** un solo campo → `text`. Mai `content` sullo stesso oggetto versione.

#### Piattaforma e lingua

- A livello **job** restano `contents.platform` e `contents.language` (ultimo contesto usato).
- A livello **versione tono** sono obbligatori `platform` + `language`: ogni bozza ricorda con quale canale/lingua è stata generata (regen su LinkedIn vs Facebook non si sovrascrivono a caso).

#### Forma obbligatoria dei 3 pilastri

`research.refiner.compressedFacts` è un array di **3 stringhe** con prefisso:

```
SCENARIO: <testo fatti/metriche>
CONTESTO: <testo cornice/narrazione>
SFIDE_OPPORTUNITA: <testo attriti/leve/CTA>
```

Il mock può randomizzare il body dopo i due punti; **non** cambiare i prefissi.

---

## 4. Logica di scrittura (allineata al backend)

### 4.1 Fine analisi (`prepare-shaping` → completed)

Equivalente a `consolidateToFirestore(userId, jobId, "completed")`:

```
contents/{jobId}.set(fullPayload, { merge: true })
```

Dove `fullPayload` include tutto lo schema §3.2 con:
- `status: "completed"`
- `workerState.currentStep: "done"`, `progress: 1`
- `tones[*].versions: []` (nessun testo ancora)
- solo toni presenti in `companies.enabled_tones` (intersezione catalogo)
- subset ON/OFF random **ma coerente** (es. confidente/narratore sempre ON; ~20% OFF su provocatore/sferzante/promotore)

### 4.2 Dopo generazione tono

Equivalente prodotto (target mock con `versions`):

```
const prev = contents.tones[toneKey] || { status: "ON", lock_reason: "", versions: [] };
const nextVersion = (prev.versions?.at(-1)?.version ?? 0) + 1;
const entry = {
  version: nextVersion,
  text: contenutoGenerato,           // solo `text`, mai `content`
  platform: normalizePlatform(platform),
  language: String(language).trim(),
  regeneratedWith: instructions.trim() ? "instructions" : "total",
  instructions: instructions.trim() ? String(instructions).slice(0, 100) : "",
  createdAt: Timestamp.now(),
};

contents/{jobId}.set({
  [`tones.${toneKey}`]: {
    ...prev,
    status: "ON",
    lock_reason: "",
    versions: [...(prev.versions || []), entry],
  },
  platform: entry.platform,          // aggiorna anche contesto job
  language: entry.language,
  status: "completed",
  updatedAt: Timestamp.now(),
  workerState: {
    currentStep: "done",
    progress: 1,
    updatedAt: Timestamp.now()
  }
}, { merge: true })
```

### 4.3 Job fallito / bloccato

```
status: "failed" | "blocked"
error: { message, step }
updatedAt: Timestamp
```

---

## 5. Generatori random per il mock

### 5.1 Pilastri (`buildRandomPillars(topic)`)

```ts
function buildRandomPillars(topic: string): string[] {
  const n = () => (Math.random() * 80 + 5).toFixed(1);
  const m = () => Math.floor(Math.random() * 900_000 + 10_000).toLocaleString("it-IT");
  return [
    `SCENARIO: Su «${topic}», nel 2026 si osservano ${m()} unità rilevanti (+${n()}% annuo). Quota segmento leader: ${n()}%.`,
    `CONTESTO: La narrazione dominante su «${topic}» insiste su modernizzazione e competitività, con cornice istituzionale e pressioni di mercato.`,
    `SFIDE_OPPORTUNITA: Il gap operativo su «${topic}» richiede priorità chiare, scadenze misurabili e una leva di conversione credibile entro il 2026.`,
  ];
}
```

### 5.2 Toni (`buildRandomTones(enabledTones)`)

```ts
const ALWAYS_ON = new Set(["confidente", "narratore"]);

function buildRandomTones(enabledTones: string[]) {
  const tones: Record<string, any> = {};
  for (const id of enabledTones) {
    let status: "ON" | "OFF" = "ON";
    let lock_reason = "";
    if (!ALWAYS_ON.has(id) && Math.random() < 0.25) {
      status = "OFF";
      lock_reason = `Mock: ${id} non idoneo per questo topic`;
    }
    tones[id] = {
      status,
      lock_reason,
      versions: [], // testo solo dopo regenerate-tone
    };
  }
  return tones;
}
```

### 5.3 Testo tono (`buildRandomToneText({ toneKey, platform, topic, pillars })`)

Generare 3–6 paragrafi fake con:
- menzione di `toneKey` e `platform`
- 1–2 numeri presi/parafrasati da `SCENARIO`
- chiusura diversa per tono (domanda A/B se provocatore; CTA se promotore; stacco se sferzante)

Non serve qualità editoriale: serve **variabilità** e lunghezza realistica (900–1400 char per LinkedIn).

---

## 6. Stato in-memory vs Firestore (scelta mock)

| Approccio | Pro | Contro |
|-----------|-----|--------|
| **A. Solo Firestore** | Persistenza reale; UI può ricaricare pagina | Polling più lento; serve Auth FS |
| **B. Memory + flush FS a completed** | Polling veloce | Stato intermedio perso al refresh |
| **C. Memory mirror del backend Redis** | Fedeltà massima | Più codice |

**Raccomandato per UI:** **B** — job Map in memoria per polling; a `completed` e dopo ogni regen → `contents/{jobId}` come backend.

Il frontend in produzione oggi legge i risultati tramite **API status** (non necessariamente listener Firestore). I mock devono quindi:
1. implementare le 3 route HTTP (MSW / mock service / vite plugin), **oppure**
2. se la UI legge già Firestore direttamente, scrivere lo stesso documento e simulare i delay

Allinea il mock al modo in cui il frontend **legge** oggi (API vs snapshot FS).

---

## 7. Checklist parità backend

- [ ] Mock attivo **solo** se `VITE_PRISM_USE_MOCK` (o equivalente) è true
- [ ] Con mock OFF → zero scritture mock su Firestore, chiamate API reali
- [ ] Ogni `jobId` mock inizia con `mock_` (`createMockJobId`)
- [ ] Documento FS: `jobId` coerente + `isMock: true` consigliato
- [ ] `prepare-shaping` ritorna solo `{ success, jobId }`
- [ ] Status polling espone `research.refiner.compressedFacts` con 3 prefissi corretti
- [ ] `tones` solo da `enabled_tones` company
- [ ] Dopo shaping, `tones.*.versions` vuoto (nessun `text` root)
- [ ] Regen appende `versions[]` con `text` + `platform` + `language` (niente campo `content`)
- [ ] Regen rifiuta tono OFF e tono non enabled (400/403)
- [ ] Regen mock solo su jobId `mock_*`
- [ ] `version` sequenziale >= 1; `regeneratedWith` total|instructions
- [ ] Date su FS = `Timestamp`, non stringhe
- [ ] `contents/{jobId}` usa `set(..., { merge: true })`
- [ ] Platform normalizzata: `LinkedIn` | `Facebook` | `X`

---

## 8. Mapping codice backend (riferimento)

| Concern | File |
|---------|------|
| Endpoint HTTP | `src/api/index.js` |
| Payload FS + consolidate | `src/services/stateManager.js` → `buildFirestorePayload`, `consolidateToFirestore`, `getJobStatusForClient`, `writeGeneratedTone` |
| Worker F0–F3 / regen | `src/worker/processor.js` |
| enabled_tones | `src/services/companyAccess.js` + `companies/{id}` |
| Toni catalogo | `stateManager.TONE_IDS` |

---

## 9. Mini sequenza mock (pseudo)

```ts
if (!isPrismMockEnabled()) {
  return realApi.prepareShaping(body); // niente mock
}

// prepare-shaping
const jobId = createMockJobId(); // "mock_" + uuid
jobs.set(jobId, { status: "running", progress: 0.1, ... });
respond({ success: true, jobId });
setTimeout(async () => {
  const enabled = await readEnabledTones(companyId);
  const doc = {
    jobId,
    isMock: true,
    userId, companyId, topic, originalInput: topic,
    inputType: topic.startsWith("http") ? "url" : "text",
    status: "completed",
    language, platform: normalizePlatform(platform),
    action: "shaping_only",
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    workerState: { currentStep: "done", progress: 1, updatedAt: Timestamp.now() },
    research: {
      contentIngest: null,
      shaping: { is_blocked: false, block_message: "", diagnosi: { scenario: "GAP", context: "GAP", sfide_opportunita: "GAP" }, search_required: true, plan: [...], tone_suitability: {...}, suggestedQueries: [], updatedAt: Timestamp.now() },
      tavily: { rawResults: [] },
      refiner: { compressedFacts: buildRandomPillars(topic), sourcesPreview: [], tables: [], isContextRelevant: true },
    },
    tones: buildRandomTones(enabled),
    error: null,
  };
  await db.collection("contents").doc(jobId).set(doc, { merge: true });
  jobs.set(jobId, { status: "completed", fsReady: true });
}, 1500);

// status → se fsReady, leggi FS e mappa a getJobStatusForClient shape
// regen → solo se isMockJobId(jobId); leggi FS, random text, merge tones.X, return contenutoGenerato
```

Fine blueprint.
