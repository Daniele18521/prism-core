# Documento di test — Gestione errori PRISM

Questo documento spiega **cosa fare passo passo** per verificare che errori, retry e stati job funzionino correttamente.

**Tu hai già il frontend** → per la maggior parte dei test usi l’app come fai normalmente. Il backend va solo avviato e, in alcuni casi, configurato prima del test.

---

## 1. Cosa devi avere acceso

| Componente | Cosa fa | Come avviarlo |
|------------|---------|---------------|
| **API** | Riceve le richieste dal frontend | `npm run start:api` (porta **3001**) |
| **Worker** | Esegue F1→F4 in background | `npm run start:worker` |
| **Frontend** | La tua app (polling su `/jobs/status/...`) | Come fai di solito |
| **Redis** (Upstash) | Stato job in elaborazione | Deve essere raggiungibile (`REDIS_URL` nel `.env`) |
| **Firestore** | Risultato finale del job | Credenziali Firebase nel `.env` |

### Verifica rapida prima di iniziare

Apri nel browser o con curl:

```
http://localhost:3001/health   → deve rispondere { "status": "ok" }
http://localhost:3001/ready    → deve rispondere { "status": "ready" }
```

Se `/ready` dà **503**, Redis non è raggiungibile: sistemare prima di testare i job.

---

## 1b. Test automatici (consigliato)

Lo script `scripts/test-error-handling.mjs` fa al posto tuo le chiamate HTTP al backend e controlla che le risposte siano quelle giuste. **Non serve il browser.**

In fondo stampa: `Risultato: X passati, Y falliti`. Se vedi **0 falliti**, tutto ok.

---

### Passo passo (semplice)

#### Passo 0 — Apri 2 terminali

| Terminale | Cosa fare |
|-----------|-----------|
| **1** | Avvia solo l’API e lasciala accesa |
| **2** | Lancia i comandi di test |

#### Passo 1 — Terminale 1: avvia l’API

```powershell
cd C:\Users\pc\Desktop\Progetti\prism-core
npm run start:api
```

Aspetta di vedere che l’API è in ascolto sulla porta **3001**.

#### Passo 2 — Terminale 2: lancia i test (uno alla volta)

```powershell
cd C:\Users\pc\Desktop\Progetti\prism-core

npm run test:errors                  # ~5 sec  — controlli base API
npm run test:errors:integration      # ~1 min  — job mock → completed (default --mock)
npm run test:errors:simulate         # ~1 min  — errore F2 simulato (default --mock)

# Pipeline con TOPIC e modalità a tua scelta:
npm run test:pipeline -- --mock --topic="Trend e-commerce moda 2026"
npm run test:pipeline -- --live --topic="Situazione geopolitica Iraq 2026"
```

> **Importante:** per pipeline/integration/simulate, **chiudi il worker manuale** (Ctrl+C). Lo script ne avvia uno temporaneo.

#### Mock vs Live — cosa scegliere

| Flag | Gemini | Tavily | Quota API | Quando usarlo |
|------|--------|--------|-----------|---------------|
| `--mock` **(default)** | ❌ dati finti | ❌ dati finti | Zero | Sviluppo, CI, test errori |
| `--live` | ✅ reale | ✅ reale | Sì | Verificare qualità reale Shaper/Refiner |

> **Default sicuro:** se non passi nulla, tutti gli script pipeline usano `--mock`.

---

#### Passo 3 — Leggi l’esito

| Cosa vedi | Significato |
|-----------|-------------|
| `✅` davanti al nome del test | Test passato |
| `❌` + messaggio | Test fallito — leggi il messaggio |
| `Risultato: N passati, 0 falliti` | Tutto ok |
| `Risultato: N passati, 1+ falliti` | Qualcosa non va — vedi tabella assert sotto |
| `API non raggiungibile` | Terminale 1: API non avviata |

---

### Cosa fa ogni comando (in pratica)

#### `npm run test:errors` — Gruppo A (solo API, niente worker)

Lo script **non crea job**. Fa 4 richieste veloci:

1. Chiede a `/health` se l’API è viva
2. Chiede a `/ready` se Redis è raggiungibile
3. Chiede lo stato di un job **inventato** (UUID tutto zeri) → deve dire “non trovato”
4. Prova ad accodare un job **senza topic** → deve rifiutare la richiesta

**Serve:** solo API accesa. **Non serve:** worker, frontend, Gemini.

---

#### `npm run test:errors:integration` — Gruppo B (job → completed)

Default: **`--mock`** (nessuna chiamata Gemini/Tavily). Puoi passare topic e modalità:

```powershell
# Mock (default) — topic personalizzato
node scripts/test-error-handling.mjs --integration --mock --topic="Trend moda 2026"

# Live — Gemini + Tavily reali sul tuo argomento
node scripts/test-error-handling.mjs --integration --live --topic="Situazione Iraq 2026"
```

Lo script:

1. Avvia worker temporaneo (`USE_MOCK_GENERATOR=true` se `--mock`)
2. Accoda `prepare-shaping` con il **topic che scegli tu**
3. Polling fino a `completed`
4. Chiude il worker

**Serve:** API + Redis + Firestore. Per `--live`: `GEMINI_API_KEY` + `TAVILY_API_KEY` nel `.env`.

---

#### `npm run test:errors:simulate` — Gruppo C (job → failed)

Default: **`--mock --phase=F2`** — errore simulato **senza** chiamate API reali.

```powershell
# Consigliato — mock + topic tuo
node scripts/test-error-handling.mjs --simulate --mock --phase=F2 --topic="Test errore ricerca 2026"

# Solo se vuoi testare con Gemini reale prima del fault
node scripts/test-error-handling.mjs --simulate --live --phase=F2 --topic="Iraq geopolitica 2026"
```

Fasi disponibili: `--phase=F1|F2|F3|F4` · `--fault-mode=fatal|transient`

---

### Come leggere l'output (ogni test ha lo Scopo)

Prima di ogni ✅ o ❌ lo script stampa **Scopo:** con una frase che spiega *perché* esiste quel test.

```
  📋 TC-12 — shaping_only con mock → completed
     Scopo: Verificare l'intero flusso F1→F3 senza chiamare Gemini/Tavily...
  ℹ️  Job accodato: d55564fe-77cc-4202-87a6-b8bd2071339e
  ✅ TC-12 — shaping_only con mock → completed
```

Se TC-12 fallisce con **timeout** ma vedi `ultimo stato: status=completed`, segnala un bug nello script (non nel backend). È stato corretto: l'API mette `status` dentro `data` quando `success: true`.

Per log del worker temporaneo: `TEST_VERBOSE=true npm run test:errors:integration`

---

### Tabella assert — cosa deve succedere (esito atteso)

Legenda colonne:
- **Assert** = condizione che lo script verifica (se falsa → ❌)
- **PASS** = valore/risposta corretta
- **FAIL tipico** = cosa indica di solito un problema

#### Gruppo A — `npm run test:errors`

| ID | Scopo del test | Chiamata | Assert HTTP | Assert body (JSON) | PASS | FAIL tipico |
|----|----------------|----------|-------------|-------------------|------|-------------|
| TC-13 | L'API è accesa e risponde | `GET /health` | `status === 200` | `status === "ok"` | `{ "status": "ok" }` | API spenta, porta sbagliata |
| TC-09 | Redis è raggiungibile prima dei job | `GET /ready` | `200` **oppure** `503` | Se `200`: `status === "ready"` | Redis ok → 200; Redis down → 503 accettato | 500 generico, timeout |
| TC-03 | Job inventato → errore pulito | `GET /jobs/status/{userId}/00000000-...` | `status === 404` | `success === false` **e** `error === "JOB_NOT_FOUND"` | 404 + JOB_NOT_FOUND | 200 con dati falsi |
| A4 | Input incompleto rifiutato | `POST /api/prepare-shaping` senza `topic` | `status === 400` | (non controllato) | 400 Bad Request | 200 accetta richiesta invalida |

**Esito finale Gruppo A:** `4 passati, 0 falliti`

---

#### Gruppo B — `npm run test:errors:integration`

| ID | Scopo del test | Step | Assert | PASS | FAIL tipico |
|----|----------------|------|--------|------|-------------|
| B0 | Worker mock parte correttamente | Avvio worker | Log `Worker PRISM operativo` entro 15s | Worker avviato | Redis/.env mancante |
| B1 | API accoda il job | `POST /api/prepare-shaping` | HTTP `200`, `success: true`, `jobId` | Ricevi un `jobId` | 400/500, coda rotta |
| B2 | Polling fino a fine job | `GET /jobs/status/...` ogni 2s | Entro 90s | — | Timeout |
| TC-12 | Pipeline F1→F3 mock completa | Esito finale | `data.status === "completed"` *(dentro `data` se success)* | Job finito OK | `failed`, resta `processing` |

**Esito finale Gruppo B:** `5 passati, 0 falliti` (4 del Gruppo A + 1 integrazione)

---

#### Gruppo C — `npm run test:errors:simulate` (default F2 fatal)

| ID | Scopo del test | Step | Assert | PASS | FAIL tipico |
|----|----------------|------|--------|------|-------------|
| C0 | Errore simulato attivo nel worker | Env `SIMULATE_FAULT=F2` | Worker avviato | Variabili non lette |
| C1 | Job accodato normalmente | Come B1 | `jobId` ricevuto | Come B1 |
| C2 | Polling fino a fallimento | Fino a `failed` entro 90s | — | Timeout |
| TC-06 | Errore gestito → job failed | Status finale | `status === "failed"` | Job fallito come previsto | `completed` (fault non attivo) |
| TC-06 | Fase errore identificata | Campo step | `error.step === "tavily_search"` | Fase F2 corretta | step mancante o sbagliato |

**Mapping fase → step** (se cambi `--phase=`):

| SIMULATE_FAULT | error.step atteso |
|----------------|-------------------|
| F1 | `query_shaping` |
| F2 | `tavily_search` |
| F3 | `refiner` |
| F4 | `generation` |

**Esito finale Gruppo C:** `6 passati, 0 falliti` (4 Gruppo A + 1 simulate)

---

### Riepilogo: quale comando copre quale TC manuale

| TC manuale | Automatizzato? | Comando |
|------------|----------------|---------|
| TC-03 job inesistente | ✅ Sì | `test:errors` |
| TC-09 Redis down | ⚠️ Parziale | `test:errors` accetta 503, non forza Redis down |
| TC-12 mock shaping | ✅ Sì | `test:errors:integration` |
| TC-06 errore F2 fatal | ✅ Sì | `test:errors:simulate` |
| TC-07 transient retry | ❌ No | Va fatto a mano con worker + frontend |
| TC-01, TC-02 happy path reale | ❌ No | Frontend + Gemini/Tavily veri |
| TC-04 tono OFF | ❌ No | Solo frontend |
| TC-05 gatekeeper | ❌ No | Solo frontend |

---

### userId personalizzato (opzionale)

Nel `.env`:

```env
TEST_USER_ID=OhwVoYWDDkYQ2xnKwt3kL4S6U8a2
TEST_COMPANY_ID=la-tua-company-id
```

Se non li metti, lo script usa `test-automation-user` / `test-automation-company`.

---

### Cosa resta manuale (frontend)

- TC-01, TC-02 — flusso reale con Gemini
- TC-04 — rigenerazione tono OFF
- TC-05 — input bloccato gatekeeper
- TC-07 — retry transient
- Verifica messaggi errore nell’UI su `localhost:3000`

---

## 1d. Run pipeline — argomento e mock/live a scelta

Script dedicato: `scripts/run-pipeline.mjs` — lancia **un solo job** shaping (F1→F3) e stampa diagnosi + refiner.

### Prerequisito

API accesa (`npm run start:api`). Worker manuale **spento**.

### Comandi rapidi

```powershell
# Mock + topic tuo (consigliato in sviluppo)
npm run test:pipeline -- --mock --topic="Trend e-commerce moda 2026 in Italia"

# Live — chiamate reali Gemini + Tavily
npm run test:pipeline -- --live --topic="Situazione geopolitica Iraq 2026"

# Errore simulato F2, mock, topic tuo
npm run test:pipeline -- --mock --simulate --phase=F2 --topic="Test fault F2"

# Aiuto completo flag
node scripts/run-pipeline.mjs --help
```

### Tutte le opzioni CLI

| Opzione | Default | Descrizione |
|---------|---------|-------------|
| `--mock` | ✅ sì | Nessuna chiamata Gemini/Tavily |
| `--live` | no | API reali (richiede chiavi nel `.env`) |
| `--topic="..."` | — | **Argomento da analizzare** (obbligatorio) |
| `--expect=completed` | completed | Status atteso: `completed` \| `failed` \| `blocked` |
| `--timeout=120` | 120 | Secondi max di polling |
| `--verbose` | no | Log del worker in console |
| `--simulate` | no | Attiva `SIMULATE_FAULT` |
| `--phase=F2` | F2 | Fase errore: F1, F2, F3, F4 |
| `--fault-mode=fatal` | fatal | `fatal` o `transient` |

Variabile alternativa nel `.env`: `TEST_TOPIC=...`

### Output atteso (mock completato)

```
  Modalità:  MOCK
  Topic:     Trend e-commerce moda 2026
  Status:    completed
  Diagnosi:  { scenario: 'GAP', ... }
  Refiner (anteprima):
    SCENARIO: Dati mock +15%.
  ✅ Job terminato con status "completed"
```

### Tabella assert — run pipeline

| Modalità | Assert | PASS | FAIL tipico |
|----------|--------|------|-------------|
| `--mock` | Job finisce | `status: completed` | Timeout, worker non parte |
| `--live` | Chiavi presenti | Avvio senza errore config | `GEMINI_API_KEY` mancante |
| `--live` | Qualità pipeline | 3 blocchi refiner in output | `failed` step F1/F2/F3 |
| `--simulate --mock` | Errore gestito | `failed` + `error.step` corretto | `completed` (fault non attivo) |

### Relazione con altri test

| Comando | Cosa fa |
|---------|---------|
| `npm test` | Unit test logica (no API, no job) |
| `npm run test:pipeline` | **Un job**, topic e mock/live a scelta |
| `npm run test:errors:integration` | Suite assert + job (default mock) |
| `npm run test:errors` | Solo health/404/400 |

---

## 1c. Test unitari servizi (dopo ogni modifica a shaper/search/refiner)

Test **veloci** (~3 secondi) che **non chiamano Gemini né Tavily**. Verificano la logica pura (normalizzazione GAP, anti-allucinazione, partial failure Tavily, ecc.).

### Comando

```powershell
npm test
# oppure solo i tre servizi:
npm run test:services
```

**Non serve** API, worker o Redis accesi.

### Quando lanciarli

| Hai modificato… | Cosa verificano i test |
|-----------------|------------------------|
| `src/services/shaper.js` | GAP → plan, plan vuoto se tutti OK, fix toni OFF concatenati |
| `src/services/search.js` | Plan vuoto, ID fonti S1/S2…, partial failure, errore se tutte le query falliscono |
| `src/services/refiner.js` | Scarto date/numeri inventati, pilastro OK senza validazione web, 3 blocchi pilastro |

### Tabella assert — test unitari

#### Shaper (`tests/shaper.test.js`)

| Test | Scopo | Assert PASS |
|------|-------|-------------|
| status ON | Tono attivo | `lock_reason === ""` |
| status OFF concatenato | Bug Gemini `OFFMotivo…` | `status OFF` + motivo separato |
| tutti pilastri OK | Nessuna ricerca | `search_required false`, `plan []` |
| pilastri GAP | Ricerca mirata | `plan` solo su pilastri GAP |
| 6 toni | Matrice completa | sempre 6 chiavi normalizzate |

#### Search (`tests/search.test.js`)

| Test | Scopo | Assert PASS |
|------|-------|-------------|
| plan vuoto | Skip F2 | `rawResults []`, Tavily non chiamato |
| key mancante | Config errata | `AppError TAVILY_CONFIG`, non retryable |
| più query | Numerazione fonti | `S1, S2, S3…` globali |
| partial failure | Resilienza | almeno 1 risultato + `partialFailures` |
| all failed | Errore pipeline | `AppError TAVILY_ALL_FAILED`, retryable |

#### Refiner (`tests/refiner.test.js`)

| Test | Scopo | Assert PASS |
|------|-------|-------------|
| citazione [S1] | Tracciabilità | frase senza [Sx] scartata |
| data inventata | Anti-allucinazione | `8 marzo 2026` scartata se assente in fonte |
| pilastro OK | Input utente | nessuna validazione web |
| consolidate | Output canonico | 3 blocchi ordine SCENARIO→CONTESTO→SFIDE |
| duplicati pilastro | Un blocco per pilastro | frasi unite in un paragrafo |

### Output atteso

```
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

Se `fail > 0`, leggi quale test è rosso: indica quale regola di business non è più rispettata.

---

## 2. Come funziona il flusso (per capire cosa osservare)

```
Frontend invia topic
       ↓
API crea jobId + salva in Redis + mette in coda
       ↓
Worker esegue: F1 Shaper → F2 Search → F3 Refiner → F4 Generator
       ↓
Fine OK  → Firestore status: "completed"
Fine KO  → Firestore status: "failed" + error.message + error.step
Bloccato → Firestore status: "blocked" (contenuto non ammesso)
       ↓
Frontend fa polling GET /jobs/status/{userId}/{jobId}
```

**Dove guardare durante i test:**

| Dove | Cosa controllare |
|------|------------------|
| **Frontend** | Messaggio errore, spinner che si ferma, stato job |
| **Terminale Worker** | Log `❌ [WORKER:...]`, retry `attempt 1/2`, `SIMULATE_FAULT` |
| **Terminale API** | Errori accodamento, `requestId` |
| **Firestore** → collection `contents` → doc `{jobId}` | `status`, `error`, `research`, `tones` |

---

## 3. Preparazione ambiente di test

### 3.1 Variabili utili nel `.env`

```env
# Per test senza chiamare Gemini/Tavily (solo flusso Redis→Firestore)
USE_MOCK_GENERATOR=true

# Per simulare errori nel worker (vedi sezione 5)
# SIMULATE_FAULT=F2
# SIMULATE_FAULT_MODE=fatal
```

> **Importante:** dopo ogni modifica al `.env`, **riavvia API e Worker**.

### 3.2 Dati di test consigliati

Usa lo stesso `userId` e `companyId` che usa il frontend quando sei loggato.

| Campo | Esempio |
|-------|---------|
| userId | il tuo UID Firebase reale |
| companyId | ID azienda reale |
| topic (OK) | `Trend e-commerce moda 2026 in Italia` |
| topic (GAP / ricerca) | `Situazione geopolitica Iraq 2026` |
| topic (blocco) | *(solo se vuoi testare gatekeeper — contenuto non ammesso)* |

---

## 4. Test dal FRONTEND (senza toccare il backend)

Questi test usano **solo la tua app**, con API e Worker accesi normalmente.

### TC-01 — Happy path analisi (shaping_only)

**Obiettivo:** verificare che un job completi senza errori.

| Step | Azione |
|------|--------|
| 1 | Avvia API + Worker |
| 2 | Dal frontend, lancia **solo analisi** (prepare-shaping / shaping_only) con un topic normale |
| 3 | Attendi fine elaborazione (polling) |

**Esito atteso**

- Frontend: successo, dati ricerca visibili (shaping, refiner)
- Firestore: `status: "completed"`
- Worker: log `Analisi completata`, nessun `❌`

---

### TC-02 — Happy path generazione completa

**Obiettivo:** pipeline F1→F4 completa.

| Step | Azione |
|------|--------|
| 1 | Dal frontend, lancia **generazione completa** (`/api/generate`) |
| 2 | Attendi fine |

**Esito atteso**

- Frontend: toni con testo per quelli ON
- Firestore: `status: "completed"`, `tones.*.text` popolati
- Worker: `Pipeline completata`

---

### TC-03 — Polling job inesistente

**Obiettivo:** API gestisce jobId sbagliato.

| Step | Azione |
|------|--------|
| 1 | Apri/chiama manualmente: `GET /jobs/status/{userId}/00000000-0000-0000-0000-000000000000` |

**Esito atteso**

- Risposta: `404` con `"error": "JOB_NOT_FOUND"`
- Frontend: messaggio “job non trovato” (se lo gestite)

---

### TC-04 — Rigenerazione tono OFF

**Obiettivo:** API rifiuta tono bloccato dallo Shaper.

| Step | Azione |
|------|--------|
| 1 | Completa un job con almeno un tono **OFF** (es. provocatore su tema sensibile) |
| 2 | Dal frontend prova a rigenerare quel tono OFF |

**Esito atteso**

- API: `400` con messaggio tipo `Tono X bloccato: ...`
- Frontend: mostra il `lock_reason`, nessun job avviato

---

### TC-05 — Input bloccato (Gatekeeper)

**Obiettivo:** contenuto non ammesso → `blocked`, non `failed`.

| Step | Azione |
|------|--------|
| 1 | Inserisci un topic che viola le policy (odio, violenza, ecc.) — solo in ambiente di test |
| 2 | Lancia analisi o generazione |

**Esito atteso**

- Firestore: `status: "blocked"` (non `failed`)
- Frontend: `success: false`, messaggio blocco (`block_message`)
- Worker: `Input bloccato dal Gatekeeper`

---

## 5. Test con SIMULATE_FAULT (simulazione errori nel Worker)

Serve quando vuoi **forzare un errore** in una fase specifica senza rompere API key o rete.

### Come si usa (PowerShell)

1. **Chiudi** il worker se è già in esecuzione (Ctrl+C)
2. Imposta le variabili **nella stessa finestra** dove lancerai il worker:

```powershell
# Errore DEFINITIVO in F2 (Search) — job fallisce subito
$env:SIMULATE_FAULT="F2"
$env:SIMULATE_FAULT_MODE="fatal"
node src/worker/processor.js
```

3. Dal **frontend**, lancia un job che arriva a F2 (topic con GAP → serve ricerca web)
4. Osserva worker + frontend + Firestore
5. **Pulisci** dopo il test:

```powershell
Remove-Item Env:SIMULATE_FAULT -ErrorAction SilentlyContinue
Remove-Item Env:SIMULATE_FAULT_MODE -ErrorAction SilentlyContinue
```

All’avvio vedrai: `🧪 SIMULATE_FAULT attivo: F2 (fatal)`

### Valori SIMULATE_FAULT

| Valore | Fase | step in Firestore error |
|--------|------|-------------------------|
| `F1` | Shaper | `query_shaping` |
| `F2` | Tavily Search | `tavily_search` |
| `F3` | Refiner | `refiner` |
| `F4` | Generator | `generation` |

### Valori SIMULATE_FAULT_MODE

| Valore | Comportamento |
|--------|---------------|
| `fatal` (default) | Errore subito → job `failed` su Firestore, **nessun retry** |
| `transient` | Errore temporaneo → BullMQ **riprova** (prepare-shaping: 2 tentativi, generate: 3) |

---

### TC-06 — Errore fatal F2

| Step | Azione |
|------|--------|
| 1 | Worker con `SIMULATE_FAULT=F2`, `MODE=fatal` |
| 2 | Frontend: lancia analisi su topic che richiede ricerca (GAP) |

**Esito atteso**

- Worker: `❌ [WORKER:...]`, messaggio `[SIMULATED] Errore fatal in fase tavily_search`
- Firestore: `status: "failed"`, `error.step: "tavily_search"`
- Frontend: polling mostra errore, `success: false`

---

### TC-07 — Errore transient F2 (retry)

| Step | Azione |
|------|--------|
| 1 | Worker con `SIMULATE_FAULT=F2`, `MODE=transient` |
| 2 | Frontend: lancia analisi (shaping_only) |

**Esito atteso**

- Worker: `attempt 1/2` → errore → `attempt 2/2` → errore → poi `failAndConsolidate`
- Firestore: alla fine `status: "failed"` (dopo tentativi esauriti)
- **Non** deve esserci un terzo tentativo dopo il salvataggio su Firestore

---

### TC-08 — Errore fatal F1 / F3 / F4

Ripeti TC-06 cambiando `SIMULATE_FAULT` in `F1`, `F3`, `F4`.

- **F1:** qualsiasi topic
- **F3:** job che supera F1 e F2
- **F4:** usa **generazione completa** (`/api/generate`), non shaping_only

---

## 6. Test modificando il `.env` (errori “reali”)

Riavvia sempre API + Worker dopo ogni modifica.

### TC-09 — Redis non disponibile

| Step | Azione |
|------|--------|
| 1 | In `.env`, commenta o sbaglia temporaneamente `REDIS_URL` |
| 2 | Riavvia API |
| 3 | Apri `http://localhost:3001/ready` |

**Esito atteso:** HTTP **503**, `"status": "not_ready"`

Ripristina `REDIS_URL` corretto e verifica che `/ready` torni OK.

---

### TC-10 — GEMINI_API_KEY mancante

| Step | Azione |
|------|--------|
| 1 | Rimuovi/commenta `GEMINI_API_KEY` nel `.env` |
| 2 | Assicurati `USE_MOCK_GENERATOR` **non** sia `true` |
| 3 | Riavvia Worker |
| 4 | Frontend: lancia analisi |

**Esito atteso**

- Worker: errore in F1 o F3
- Firestore: `failed`, step `query_shaping` o `refiner`

---

### TC-11 — TAVILY_API_KEY mancante

| Step | Azione |
|------|--------|
| 1 | Rimuovi/commenta `TAVILY_API_KEY` |
| 2 | Frontend: topic che genera GAP (ricerca web) |

**Esito atteso**

- Errore in F2, `error.step: "tavily_search"`
- Firestore: `failed`

---

### TC-12 — Mock completo (sanity check infrastruttura)

| Step | Azione |
|------|--------|
| 1 | `.env`: `USE_MOCK_GENERATOR=true` |
| 2 | Riavvia Worker |
| 3 | Frontend: generazione completa |

**Esito atteso**

- Nessuna chiamata Gemini/Tavily reale
- Job `completed` con dati mock
- Utile per verificare Redis + Firestore + frontend **senza costi API**

---

## 7. Test infrastruttura e produzione

### TC-13 — Health check

```
GET http://localhost:3001/health
```

**OK:** `200`, `"status":"ok"`

### TC-14 — Shutdown graceful Worker

| Step | Azione |
|------|--------|
| 1 | Avvia un job lungo dal frontend |
| 2 | Nel terminale Worker premi **Ctrl+C** |

**Esito atteso**

```
🛑 [worker] SIGINT — avvio shutdown graceful...
✅ [worker] Shutdown completato.
```

---

## 8. Cosa deve fare il FRONTEND (checklist integrazione)

Verifica che la tua app gestisca questi casi:

| Risposta API / Firestore | Comportamento frontend atteso |
|--------------------------|-------------------------------|
| `success: true`, `status: "running"` / progress < 1 | Mostra loader / progress |
| `success: true`, `status: "completed"` | Mostra risultati |
| `success: false`, `status: "failed"` | Mostra `error.message`, permette retry manuale |
| `success: false`, `status: "blocked"` | Mostra `block_message`, no retry |
| `404 JOB_NOT_FOUND` | Messaggio chiaro, torna indietro |
| `400` tono bloccato | Mostra `lock_reason` |
| Polling timeout / rete | Messaggio connessione, non bloccare UI |

Endpoint polling:

```
GET /jobs/status/{userId}/{jobId}
```

Risposta errore job:

```json
{
  "success": false,
  "status": "failed",
  "error": { "message": "...", "step": "tavily_search" },
  "workerState": { "step": "...", "progress": 0.5 }
}
```

---

## 9. Matrice riepilogativa test

| ID | Tipo | Come | Esito atteso |
|----|------|------|--------------|
| TC-01 | Frontend | Analisi OK | `completed` |
| TC-02 | Frontend | Generazione OK | `completed` + toni |
| TC-03 | API | jobId finto | `404` |
| TC-04 | Frontend | Regen tono OFF | `400` |
| TC-05 | Frontend | Topic bloccato | `blocked` |
| TC-06 | SIMULATE | F2 fatal | `failed` step tavily |
| TC-07 | SIMULATE | F2 transient | 2 attempt poi `failed` |
| TC-08 | SIMULATE | F1/F3/F4 fatal | `failed` step corretto |
| TC-09 | .env | Redis down | `/ready` 503 |
| TC-10 | .env | No Gemini | `failed` F1/F3 |
| TC-11 | .env | No Tavily | `failed` F2 |
| TC-12 | .env | USE_MOCK=true | `completed` mock |
| TC-13 | HTTP | /health | 200 |
| TC-14 | Worker | Ctrl+C | shutdown pulito |

---

## 10. Ordine consigliato (prima volta)

1. TC-13 + TC-09 → infrastruttura OK  
2. TC-12 → flusso end-to-end senza API esterne  
3. TC-01 + TC-02 → flusso reale dal frontend  
4. TC-06 + TC-07 → simulazione errori F2  
5. TC-04 + TC-05 → casi business (tono OFF, blocco)  
6. TC-10 / TC-11 → solo se vuoi testare errori configurazione  

---

## 11. Ripristino dopo i test

1. Rimuovi `SIMULATE_FAULT` e `SIMULATE_FAULT_MODE` dal terminale o `.env`
2. Ripristina tutte le API key nel `.env`
3. Imposta `USE_MOCK_GENERATOR=false` (o rimuovi) per produzione
4. Riavvia API e Worker
5. Verifica `/ready` → OK

---

*Documento generato per prism-core — gestione errori e retry BullMQ / Redis / Firestore.*
