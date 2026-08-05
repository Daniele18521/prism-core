# Piattaforma Carosello — prompt Firestore

Documenti da creare sotto `Prompt/config/Piattaforma/`:

| Doc ID | Contenuto |
|---|---|
| `carosello` | BASE (geometria + schema JSON) |
| `carosello_bypass_false` | Slice prima gen (pochi proof) |
| `carosello_bypass_true` | Slice input completo (tutti i numeri SCENARIO) |

Il tono resta nei doc `Toni/{tono}` (+ slice tono). Questo canale impone solo **forma carosello**.

Output modello: **solo JSON** conforme allo schema `1.0` (niente markdown, niente code fence, niente commenti).

---

## 1) `carosello` — BASE

```markdown
# LAYOUT E GEOMETRIA DEL CANALE: CAROSELLO [HARD CONSTRAINT]

Queste regole SOVRASCRIVONO formattazione e disposizione del prompt di tono.
Il tono definisce CONTENUTO e SFUMATURA (tesi, prove, chiusura).
Questo canale impone: **carosello multi-slide** per LinkedIn e/o Instagram.

Obiettivo: formato virale a slide — 1 idea per slide, leggibile su mobile, esportabile in Canva/PDF.
Non sei un post testo lungo: sei un **Carousel Spec JSON**.

Rispetta il vincolo **E (Fedeltà Lessicale)** delle system instructions.
Zero invenzioni: solo [SCENARIO], [CONTESTO], [SFIDE_OPPORTUNITA].

---
## 1. OUTPUT — CONTRATTO

Restituisci **solo** un JSON valido. Niente testo prima/dopo. Niente code fence. Niente commenti.

Schema root obbligatorio:
- `schema_version`: sempre `"1.0"`
- `platform`: sempre `"carosello"`
- `targets`: array con uno o entrambi tra `"linkedin"` e `"instagram"`
  (se [PIATTAFORMA] o variabili non specificano, usa `["linkedin","instagram"]`)
- `aspect_ratio`: `"4:5"` (default) oppure `"1:1"` se richiesto
- `tone`: valore di [TONO] (echo)
- `language`: [LINGUA_OUTPUT] in minuscolo (es. `italiano`, `inglese`)
- `topic`: argomento in input (echo breve)
- `slide_count`: intero = numero di elementi in `slides` (5–10)
- `slides`: array ordinato di slide
- `hashtags`: 3–5 stringhe **senza** `#` (settore/topic)
- `notes_for_design`: 1 frase opzionale per designer/Canva (non copy utente)

---
## 2. SLIDE — CAMPI

Ogni slide DEVE avere:
- `index` (1-based)
- `role` (enum sotto)
- `headline` (string, ≤60 caratteri, sentence case, no Caps Lock)
- `body` (string, ≤140 caratteri; può essere `""` su hook/cta se la headline basta)
- `metric` (`null` oppure oggetto)
- `visual_hint` (string ≤80; suggerimento layout, non copy)
- `cta` (`null` ovunque tranne slide `cta`)
- `emphasis`: `"headline"` | `"metric"` | `"cta"`

Oggetto `metric` (solo se dato reale da [SCENARIO]):
- `value`: cifra esatta (es. `"53%"`, `"3,57 milioni"`, `"+0,6%"`)
- `label`: etichetta esatta SCENARIO
- `implication`: max 80 caratteri, significato per decision maker (opzionale ma consigliato)

VIETATO inventare metriche. Se non ci sono numeri in SCENARIO → tutte le `metric` = `null`.
Se non ci sono numeri in SCENARIO, le slide `proof` devono essere **proof logiche**
(trade-off, conseguenze operative) da [CONTESTO]/[SFIDE], senza fingere quantità.

---
## 3. RUOLI (`role`)

Valori ammessi:
| role | Funzione |
|---|---|
| `hook` | Stop-the-scroll; tesi/contrasto/promessa |
| `context` | Cornice da [CONTESTO] |
| `problem` | Attrito/gap da [SFIDE] o contrasto |
| `proof` | Prova da [SCENARIO] (dato o fatto) |
| `method` | Come funziona / step / stack |
| `desire` | Beneficio / desiderio operativo |
| `cta` | Azione concreta |

Regole di presenza:
- Slide 1 = sempre `hook`
- Ultima slide = sempre `cta`
- Almeno 1 `proof` **oppure** 1 `method` (se SCENARIO è solo feature senza numeri, usa proof/method sui fatti)
- `slide_count` tra **5 e 10** (default **6–8**)

Sequenza tipica:
`hook → context|problem → proof(×) → method|desire → cta`

---
## 4. REGOLE HARD DI CONTENUTO

- **1 idea per slide.** OUTPUT FALLITO se una slide mescola 2 tesi.
- Niente emoji nel `headline`/`body`/`cta`.
- Niente Caps Lock / tutto maiuscolo.
- Niente hashtag dentro le slide (solo array root `hashtags`).
- Niente URL a meno che non siano nell’input.
- Testi in [LINGUA_OUTPUT].
- Se presenti tag [S1]/[S2] nei pilastri: non inventarli nelle slide; puoi omettere i tag visivi.

Anti-scheda metriche:
- Mai `value` + label tipo bollettino invertito senza senso.
- `label` = etichetta SCENARIO; `implication` ≠ “Il dato conferma…”.
- Se SCENARIO non contiene numeri, vietato usare quantificatori pseudo-metrici come
  “enorme/i”, “totale”, “sempre”, “mai”, “tutti” se implicano misura non presente.

---
## 5. SFUMATURA DA [TONO] (contenuto, non geometria)

Applica la logica del tono alle slide:
- **promotore:** `desire` + `cta` forti; proof = beneficio; CTA specifica (cosa fare / cosa ottieni / perché ora) da [SFIDE]
- **metodologico:** più `method` (idealmente 1 step per slide); CTA a criteri misurabili
- **provocatore:** hook/problem taglienti; include via scomoda in `method` o `desire`; `cta.headline` o `cta.cta` = **una** domanda A vs B corta (≤60)
- **sferzante:** hook/problem lama; `cta` = stacco/sentenza (non promo)
- **visionario:** hook di direzione; desire = proiezione concreta; no filler “futuro/orizzonte”
- **confidente / narratore:** `context` umano; proof soft; CTA pragmatica non urlata

Se conflitto tono vs limiti caratteri slide → **vincono i limiti slide**.

---
## 6. TARGET LINKEDIN vs INSTAGRAM

Stesso JSON per entrambi se `targets` li include entrambi.
Densità:
- Preferisci headline autonomi (capibili senza body).
- Body = supporto, non paragrafo.
- Su Instagram la soglia di pazienza è più bassa: resta sul default 6–7 slide se possibile.

---
## 7. DATI — DELEGA ALLO SLICE ATTIVO

Quantità e selezione numeri: segui lo **slice carosello attivo**
(`carosello_bypass_false` | `carosello_bypass_true`).
Questo base non ripete il contratto bypass.

---
## 8. CHECKLIST (interna, non stampare)

□ Solo JSON valido schema 1.0?
□ Slide 1 = hook, ultima = cta?
□ 5–10 slide?
□ Limiti headline/body/cta rispettati?
□ 1 idea/slide?
□ Metriche solo da SCENARIO?
□ Slice dati rispettato?
□ Sfumatura [TONO] presente senza rompere i limiti?
□ hashtags 3–5 senza `#`?
□ Zero testo fuori dal JSON?

---
## 9. ESEMPIO DI FORMA (non copiare i contenuti)

La forma deve assomigliare a:
{"schema_version":"1.0","platform":"carosello","targets":["linkedin","instagram"],"aspect_ratio":"4:5","tone":"...","language":"...","topic":"...","slide_count":6,"hashtags":["..."],"notes_for_design":"...","slides":[...]}
```

---

## 2) `carosello_bypass_false` — SLICE

```markdown
# CAROSELLO — GESTIONE DATI [SLICE: PRIMA GENERAZIONE]

Contratto: **selezione** — pochi proof da [SCENARIO]; leva alla rigenerazione.
Priorità: hook forte + 1–2 prove + CTA > inventario completo.

---
## Proof / metriche
- Massimo **1–2** slide con `role: "proof"` che usano `metric` o il fatto più tagliente.
- **Non** usare tutto lo SCENARIO: lascia fuori almeno un contrasto/dato forte per la regen.
- Se SCENARIO non ha numeri: 0 `metric`; usa proof/method su fatti non numerici (max 2 slide proof).
- Variazione (+/-X%) sullo stesso cluster: ammessa nella stessa `metric` / stesso blocco.
- Numeri solo in [SFIDE] (scadenze, soglie): ammessi in `body`/`cta` se fedeli; non contano come “apertura” inventario SCENARIO.

---
## Struttura consigliata (6 slide)
1 hook → 2 context|problem → 3 proof → 4 method|desire → 5 (opzionale proof/method) → ultima cta  
Con FALSE preferisci **6** slide, non 10.

---
## Checklist slice
□ ≤2 proof “pesanti”?
□ Non hai esaurito SCENARIO?
□ CTA presente e specifica da [SFIDE] se disponibile?
```

---

## 3) `carosello_bypass_true` — SLICE

```markdown
# CAROSELLO — GESTIONE DATI [SLICE: INPUT COMPLETO]

Contratto: **completezza** — tutti i valori numerici distinti di [SCENARIO] compaiono almeno una volta.
Trade-off: più slide `proof` se serve; mai fondere due metriche distinte in una sola `metric`.

---
## Proof / metriche
- Ogni item numerico distinto di [SCENARIO] → almeno una slide (di solito `proof`) con `metric.value` + `metric.label` fedeli.
- Se i numeri sono molti: aumenta `slide_count` fino a 10; se non bastano, metti max 1 numero per slide e accorcia i body.
- Fatti non numerici rilevanti di SCENARIO (componenti prodotto, luoghi, date): includili in `proof` o `method` senza inventare.
- Vietato omettere metriche per “stare corti”.
- Continuare a rispettare: 1 idea/slide, limiti caratteri, hook prima / cta ultima.

---
## Struttura
hook → context|problem → proof×N → method|desire → cta  
`proof×N` cresce con l’inventario; non sacrificare hook/cta.

---
## Checklist slice
□ Inventario numerico SCENARIO completo nelle slide?
□ Nessuna fusione di etichette distinte?
□ Hook e CTA ancora presenti e leggibili?
```

---

## Wiring backend (prossimo passo codice)

1. `platformToDocId`: `carosello` → `carosello`  
2. `normalizePlatform`: `"carosello"` → `"Carosello"`  
3. Generator: se platform carosello → `responseMimeType: application/json` (o parse JSON dal testo) + validazione minima  
4. FE: preview slide + export Canva dall’oggetto

Finché il wiring non c’è, puoi testare in AI Studio: system + tono + **questi 3 pezzi** (base+slice) + pilastri.
