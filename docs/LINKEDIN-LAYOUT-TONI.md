# LinkedIn — Mappa layout toni (Verticale LI vs Prosa vs Gabbia)

Da incollare nel prompt Firestore `Piattaforma/linkedin` (sostituisce §2 MAPPATURA, §3 VARIANTE C, e relative override).
Presuppone che §1 STRUTTURA COMUNE resti valida: **HOOK riga 1 + riga 2 vuota** per tutti i toni.

---

## 2. MAPPATURA TONO → LAYOUT

| [TONO] | Layout |
|---|---|
| promotore, sferzante, provocatore, visionario | **V** — Verticale LinkedIn (executive, mobile-first) |
| informatore | **I** — Informatore moderno (fattuale, scansionabile, non commerciale) |
| confidente, narratore, narrativo | **C** — Prosa B2B densa |
| metodologico | **B** — Gabbia logica |

Regole rapide:
- **V** → respiro verticale, blocchi corti; **no** emoji; **no** Layout A Facebook (niente slang/ghigliottina da feed community).
- **I** → informatore: prosa fluida scansionabile; zero soft-promo; zero artefatti.
- **C** → prosa continua a paragrafi; no monorighe come struttura dominante.
- **B** → step numerati dopo hook + cornice; vietato partire da `1.` senza apertura.
- Su LinkedIn **nessun tono** usa il Layout A Facebook (emoji, “caffè professionale”, monorighe infinite).

---

## 3. VARIANTE V — Verticale LinkedIn (promotore | sferzante | provocatore | visionario)

Obiettivo: stop-the-scroll su **cellulare**, registro **B2B executive**.
Differenza da Facebook: stessa aria, meno rumore; zero emoji; lessico professionale.

### Geometria HARD
- Dopo hook + riga vuota (§1): **4–7 blocchi** totali (chiusura inclusa), poi hashtag.
- Riga vuota tra ogni blocco.
- Ogni blocco = **1 frase** (max **2** solo se ciascuna ha ≤15 parole).
- Target per blocco: **≤280 caratteri** (spazi inclusi).
- OUTPUT FALLITO se:
  - un blocco ha 3+ frasi, oppure 2 frasi di cui una >15 parole;
  - il corpo è un muro di prosa senza a capo frequenti;
  - compaiono emoji;
  - il post sembra un elenco Facebook (simboli, slang, monorighe decorative).

### Ritmo
- Preferisci frase ≤12 parole; raccordo max ≤18.
- Alterna blocco “colpo” (tesi/dato/beneficio) e blocco “implicazione”.
- Max **1** riga-punch di enfasi isolata nel corpo (oltre all’hook).

### Stack / Desire (promotore e affini)
- Componenti o leve multiple: **una leva per blocco** (o una riga enumerativa corta tipo “X. Y. Z. W.” in un solo blocco), non un paragrafo che le fonde in prosa.
- Numeri: slice attivo; integra cifra + etichetta SCENARIO nel blocco (no riga-solo-numero da scheda).


### Sfumatura per tono
| Tono | Sfumatura Verticale LI |
|---|---|
| promotore | Beneficio decision maker + prova + CTA specifica (blocco finale dedicato) |
| sferzante | Colpi vernice→lama→terra; stacco netto in chiusura |
| provocatore | Paradosso + prove; S scomoda; **una** domanda A vs B; poi stop |
| visionario | Tesi di direzione + implicazione operativa; niente filler “futuro/orizzonte”; chiusura a proiezione concreta |

### Chiusura (per tono — allinea a §1)
- promotore → CTA imperativa (cosa fare / cosa ottieni / perché ora) su 1–2 frasi, blocco isolato
- sferzante → punchline secca, senza via d’uscita
- provocatore → via scomoda breve (se non già nel corpo) + domanda A vs B
- visionario → proiezione forward misurabile / scelta di direzione (no slogan vuoto)

### Divieti Layout V
- Elenchi puntati, numerazioni `1. 2. 3.`, trattini elenco.
- Emoji di qualsiasi tipo.
- Paragrafi-muro e stile comunicato stampa.
- Copia del ritmo Facebook (troppe monorighe da 3–5 parole di fila).

---

## 4. VARIANTE I — Informatore (LinkedIn)

Allinea la geometria canale al tono informatore (come V/C/B per gli altri toni).

### Geometria HARD
- Hook riga 1 + riga 2 vuota (§1).
- Hook = fatto da SCENARIO (sentence case, ≤100 caratteri). OUTPUT FALLITO se teaser/CTA.
- Corpo: **3–5 paragrafi**, **1–2 frasi**, riga vuota tra paragrafi.
- Target frase: 12–20 parole.
- No emoji, no elenchi, no monorighe decorative.
- Hashtag: **3–4**, minuscolo, termini dai pilastri.

### Mapping contenuto (dal tono)
Se hook ha già soggetto+tema → corpo parte dai dettagli SCENARIO (luogo/date/punto), senza ripetere l’intero fatto.
Poi: Contesto denso (`riguarda` + focus/ambiti) → Orientamento descrittivo (SFIDE) → stop.

### BAN canale (OUTPUT FALLITO)
presidia, collocata, prenderà parte, vetrina, espone, presenta attività, si concentra,
ambiti di lavoro includono, attività specialistiche, l’attività riguarda, lo scambio si riferisce,
serve per, permette di, incontra i visitatori per, per approfondire, per valutare,
ti aspettiamo, prenota, networking strategico, [S], {{

### Verbo CONTESTO
AMMESSO: `riguarda`, `include`, `con focus su`.
VIETATO: `espone`, `mette in mostra`, `presenta attività`.

### Override
Ignora CTA/punchline/storytelling/verticalità aggressiva nel tono.
Vince Layout I + slice dati attivo.

---

## 5. VARIANTE C — Prosa B2B densa (confidente | narratore | narrativo)

### Geometria
- Max **4** paragrafi (dalla riga 3 alla chiusura).
- Ogni paragrafo: max **2–3** frasi; riga vuota tra paragrafi.
- Vietate frasi singole isolate come struttura dominante (salvo chiusura).

### Ritmo
- Alterna frase corta (≤10 parole) e raccordo (≤20 parole).
- Max 1 astrazione tecnica ogni 5 frasi; resto in immagini concrete.

### Sfumatura
| Tono | Sfumatura |
|---|---|
| confidente | Pragmatico, empatico, sostanza |
| narratore / narrativo | Scena concreta, before/after controllato |

### Gestione numeri
Segui lo **slice attivo**.

### Divieti Layout C
- Elenchi puntati, numerazioni, trattini.
- Righe isolate dedicate ai soli numeri.
- Dati senza implicazione per chi legge.
- Scivolare nel Verticale V (troppi a capo “da social punch”).

---

## 6. VARIANTE B — Gabbia logica (metodologico)

### Geometria HARD
- OUTPUT FALLITO se manca hook (§1) o se il post inizia con `1.`
- Dopo hook + riga vuota: **max 2 frasi** di cornice (problema → perché serve un metodo).
- Poi elenco numerato `1. 2. 3. …` (ogni step ≤ 2 righe visive; riga vuota tra step).
- Chiusura metodica (CTA a criteri misurabili), fuori dall’elenco.
- Hashtag dopo chiusura (§1).

### Marker step
- Solo numeri `1. 2. 3.` — **niente emoji** (vincolo LinkedIn).

### Gestione numeri
Slice attivo; max 1–2 cluster per step se TRUE; pochi anchor se FALSE.

### Divieti Layout B
- Solo elenco senza hook/cornice (manuale scopiazzato).
- Prosa senza step.
- Emoji, slang, tono Facebook.

---

## 7. OVERRIDE SUL TONO

| Layout | Ignora nel prompt di tono |
|---|---|
| V | “paragrafi densi”, “prosa fluida tradizionale senza a capo”, “max 3 frasi per blocco muro” |
| I | “CTA”, “invito commerciale”, “verticalità aggressiva”, “punchline”, “storytelling emotivo” |
| C | “ritmo asimmetrico verticale”, “una riga per dato”, “ghigliottina monorighe”, “C-mobile aggressivo” |
| B | “prosa discorsiva senza step”, “solo elenco senza hook” |

Se il tono chiede BYPASS/dati: vince lo **slice attivo**; la geometria resta di questo canale.

---

## 8. CHECKLIST PRE-OUTPUT (aggiunte layout)

□ Hook riga 1 + riga 2 vuota?
□ Layout corretto per [TONO] (V / I / C / B)?
□ Se V: blocchi 1–2 frasi, no emoji, no muro?
□ Se I: 3–5 paragrafi, 1–2 frasi, document-bound, zero marker/soft-promo?
□ Se I: hook = fatto (non teaser), hashtag 3–4 specifici?
□ Se C: prosa densa, non verticale social?
□ Se B: hook + cornice + step (non parte da 1.)?
□ Zero emoji LinkedIn?
□ Hashtag 3–4, tecnici e pertinenti (no tag generici)?
□ Contratto dati dello slice rispettato?

---

## Nota prodotto

- **Facebook** resta il canale del verticale “community” (eventuali emoji soft, registro più caldo).
- **LinkedIn Verticale (V)** è lo stesso bisogno di leggibilità mobile, filtrato executive.
- Non unificare i due prompt: differenziare lessico e divieti emoji.
