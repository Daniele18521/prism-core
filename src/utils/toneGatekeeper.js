/**
 * GATEKEEPER TONI — regole hard dopo F1.
 *
 * Gemini propone ON/OFF, ma questo modulo ha l'ultima parola:
 * - default = ON (il prodotto vende toni, non li spegne)
 * - OFF solo se il testo mostra segnali forti e verificabili
 * - confidente e narratore sono sempre ON
 *
 * Evita falsi OFF (es. politica + studio medico → Gemini spegne sferzante).
 */

/** Motivi di blocco canonici mostrati in UI */
export const LOCK_REASONS = {
  provocatore: 'Richiesto rispetto solenne',
  sferzante: "Incompatibile con l'ironia",
  visionario: 'Tema puramente storico',
  metodologico: 'Nessuna leva metodologica',
};

/** Toni sempre disponibili, senza eccezioni editoriali */
const ALWAYS_ON = new Set(['confidente', 'narratore']);

/**
 * Normalizza il testo per matching (minuscole, senza accenti estremi).
 * @param {string} text
 * @returns {string}
 */
const norm = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ' ');

/**
 * True se almeno un pattern regex matcha il testo.
 * @param {string} text
 * @param {RegExp[]} patterns
 */
const anyMatch = (text, patterns) => patterns.some((re) => re.test(text));

// --- Rilevatori di dominio (priorità: politica forza ON; solennità/umanitario forzano OFF) ---

/** Politica / polemica istituzionale → provocatore e sferzante devono restare ON */
const POLITICAL_PATTERNS = [
  /\bgoverno\b/,
  /\bpremier\b/,
  /\bpresidente del consiglio\b/,
  /\bparlamento\b/,
  /\bcamera dei deputati\b/,
  /\bsenato\b/,
  /\bmaggioranza\b/,
  /\bopposizion[ei]\b/,
  /\bdimission[ei]\b/,
  /\bemendamento\b/,
  /\blegge elettorale\b/,
  /\bpreferenze elettorali\b/,
  /\belezioni?\b/,
  /\bpartit[oi]\b/,
  /\bdeputat[oi]\b/,
  /\bsenatori?\b/,
  /\bministro\b/,
  /\bministri\b/,
  /\bcoalizione\b/,
  /\bcrisi di governo\b/,
  /\bspaccatura\b/,
  /\bfratelli d.?italia\b/,
  /\blega\b/,
  /\bforza italia\b/,
  /\bmeloni\b/,
  /\bvotazioni parlamentari\b/,
  /\bcentrodestra\b/,
  /\bcentrosinistra\b/,
];

/** Lutto / tragedia concreta → spegne solo provocatore */
const SOLEMN_PATTERNS = [
  /\blutto\b/,
  /\bfuneral[ei]\b/,
  /\bcordoglio\b/,
  /\bcommemorazion[ei]\b/,
  /\bomaggio ai (defunt|cadut)/,
  /\briposa in pace\b/,
  /\bvittime (del|della|dei|delle|di)\b/,
  /\bstrage\b/,
  /\bmassacro\b/,
  /\btragedia (di|del|della)\b/,
  /\bmort[ei] (nel|nella|nello|nei|nelle|per)\b/,
  /\bdecedut[oi]\b/,
  /\bterremoto\b.*\b(vittime|morti|decedut)/,
  /\b(alluvione|inondazione)\b.*\b(vittime|morti)/,
  /\bdisastro (aereo|naturale|ferroviario)\b/,
];

/** Violenza / umanitario → spegne solo sferzante */
const HUMANITARIAN_PATTERNS = [
  /\bgenocidio\b/,
  /\bcrimini? di guerra\b/,
  /\bguerra civile\b/,
  /\bcarestia\b/,
  /\bcampi? (profughi|rifugiati)\b/,
  /\bcrisi umanitaria\b/,
  /\bviolenza sessuale\b/,
  /\bstupr[oi]\b/,
  /\btortur[ae]\b/,
  /\bbambini (uccisi|morti|feriti)\b/,
  /\bcivili (uccisi|morti|bombardat)/,
  /\bpulizia etnica\b/,
  /\besodo (di|dei) rifugiat/,
];

/** Tema puramente storico → spegne visionario */
const HISTORICAL_PATTERNS = [
  /\barcheolog/,
  /\beta (del|di) bronzo\b/,
  /\bantica roma\b/,
  /\bmedioevo\b/,
  /\bfaraon[ei]\b/,
  /\bstoria antica\b/,
  /\bscavi archeologici\b/,
  /\breperto (storico|archeologico)\b/,
];

/** Segnali di attualità / futuro che annullano il blocco visionario */
const FUTURE_LINK_PATTERNS = [
  /\b202[0-9]\b/,
  /\bfutur[oi]\b/,
  /\bprospettiv/,
  /\binnovazion/,
  /\bstrategia\b/,
  /\btrend\b/,
  /\boggi\b/,
  /\battualita\b/,
];

/** Tema astratto senza leva pratica → spegne metodologico */
const ABSTRACT_PATTERNS = [
  /\bfilosofia (pura|estetica|metafisica)\b/,
  /\bpoesia lirica\b/,
  /\bestaetica pura\b/,
  /\bmeditazione esistenziale\b/,
  /\bonologia\b/,
];

/** Segnali di problema pratico che annullano il blocco metodologico */
const PRACTICAL_PATTERNS = [
  /\bcome\b/,
  /\bstrategia\b/,
  /\bmetodo\b/,
  /\bprocesso\b/,
  /\bpiano\b/,
  /\bsoluzion/,
  /\boperativ/,
  /\bchecklist\b/,
  /\bguida\b/,
  /\bframework\b/,
];

/**
 * Classifica il testo di input per decidere i toni in modo deterministico.
 * @param {string} topic
 * @returns {{
 *   isPolitical: boolean,
 *   isSolemn: boolean,
 *   isHumanitarian: boolean,
 *   isPureHistorical: boolean,
 *   isPureAbstract: boolean,
 * }}
 */
export const classifyTopicForTones = (topic) => {
  const text = norm(topic);
  const isPolitical = anyMatch(text, POLITICAL_PATTERNS);
  const isSolemn = anyMatch(text, SOLEMN_PATTERNS);
  const isHumanitarian = anyMatch(text, HUMANITARIAN_PATTERNS);
  const looksHistorical = anyMatch(text, HISTORICAL_PATTERNS);
  const hasFutureLink = anyMatch(text, FUTURE_LINK_PATTERNS);
  const looksAbstract = anyMatch(text, ABSTRACT_PATTERNS);
  const hasPractical = anyMatch(text, PRACTICAL_PATTERNS);

  return {
    isPolitical,
    isSolemn,
    isHumanitarian,
    isPureHistorical: looksHistorical && !hasFutureLink && !isPolitical,
    isPureAbstract: looksAbstract && !hasPractical && !isPolitical,
  };
};

/**
 * Forza ON con lock_reason vuoto.
 * @param {{status: string, lock_reason: string}} entry
 */
const forceOn = (entry) => ({ ...entry, status: 'ON', lock_reason: '' });

/**
 * Forza OFF con motivo canonico.
 * @param {{status: string, lock_reason: string}} entry
 * @param {string} reason
 */
const forceOff = (entry, reason) => ({ ...entry, status: 'OFF', lock_reason: reason });

/**
 * Applica le regole hard sui toni proposti da Gemini.
 * Principio: OFF solo se il detector conferma; altrimenti ON.
 *
 * @param {string} topic — testo input (topic o testo F0)
 * @param {Record<string, {status: string, lock_reason: string}>} tones — già normalizzati
 * @returns {Record<string, {status: string, lock_reason: string}>}
 */
export const enforceToneSuitability = (topic, tones = {}) => {
  const flags = classifyTopicForTones(topic);
  const out = { ...tones };

  for (const id of ALWAYS_ON) {
    out[id] = forceOn(out[id] || { status: 'ON', lock_reason: '' });
  }

  // Lutto/tragedia OPPURE umanitario/violenza → spegne entrambi i toni “punchy”
  if (flags.isSolemn || flags.isHumanitarian) {
    out.provocatore = forceOff(out.provocatore || {}, LOCK_REASONS.provocatore);
    out.sferzante = forceOff(out.sferzante || {}, LOCK_REASONS.sferzante);
  } else {
    // Default ON su politica, business, scienza, attualità
    out.provocatore = forceOn(out.provocatore || {});
    out.sferzante = forceOn(out.sferzante || {});
  }

  // Visionario: OFF solo tema storico puro senza legami attuali; altrimenti sempre ON
  if (flags.isPureHistorical) {
    out.visionario = forceOff(out.visionario || {}, LOCK_REASONS.visionario);
  } else {
    out.visionario = forceOn(out.visionario || {});
  }

  // Metodologico: OFF solo astratto puro senza leva pratica; altrimenti sempre ON
  if (flags.isPureAbstract) {
    out.metodologico = forceOff(out.metodologico || {}, LOCK_REASONS.metodologico);
  } else {
    out.metodologico = forceOn(out.metodologico || {});
  }

  return out;
};
