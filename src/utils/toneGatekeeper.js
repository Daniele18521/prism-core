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
  promotore: 'Tono sprecato senza obiettivo di conversione',
  promotore_sensitive: 'Tono inappropriato su crisi o alta sensibilità',
  promotore_ethics: 'Prism non denigra concorrenti o prodotti altrui',
  promotore_honesty: 'Persuasione deve restare legata a fatti reali',
  informatore: 'Tono adatto solo a comunicazioni neutre e non commerciali',
  informatore_overrides_promotore: 'Contenuto informativo: evita spinta commerciale',
  informatore_overrides_provocatore: 'Contenuto informativo: evita frizione editoriale',
  informatore_overrides_visionario: 'Contenuto informativo: evita registro aspirazionale',
  informatore_overrides_narratore: 'Contenuto informativo: evita storytelling',
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

/**
 * Violenza / umanitario / guerra su civili → spegne provocatore e sferzante.
 * Include sfollati/rifugiati e “guerra + bambini/civili” (non solo “guerra civile”).
 * Esclude metafore tipo “guerra dei prezzi” (vedi classifyTopicForTones).
 */
const HUMANITARIAN_PATTERNS = [
  /\bgenocidio\b/,
  /\bcrimini? di guerra\b/,
  /\bguerra civile\b/,
  /\bconflitto armato\b/,
  /\bcarestia\b/,
  /\bcampi? (profughi|rifugiati)\b/,
  /\bcrisi umanitaria\b/,
  /\bumanitari[ao]\b/,
  /\bviolenza sessuale\b/,
  /\bstupr[oi]\b/,
  /\btortur[ae]\b/,
  /\bbambini (uccisi|morti|feriti|sfollat)/,
  /\bcivili (uccisi|morti|bombardat|sfollat)/,
  /\bpulizia etnica\b/,
  /\besodo (di|dei) rifugiat/,
  /\bsfollat/,
  /\brifugiat/,
  /\bprofugh/,
  // guerra/conflitto legato a civili, minori, sfollamento (non metafora commerciale)
  /\bguerra\b.{0,60}\b(bambin|civili|sfollat|rifugiat|profugh|vittime|bombard)/,
  /\b(bambin|civili|sfollat|rifugiat|profugh|vittime)\b.{0,60}\bguerra\b/,
  /\bimpatto (della|di una|di) guerra\b/,
];

/** Metafore di “guerra” non umanitarie → non spegnere i toni punchy */
const COMMERCIAL_WAR_PATTERNS = [
  /\bguerra (dei prezzi|commerciale|di marketing|al talento|dei talenti)\b/,
  /\bprice war\b/,
];

/**
 * Fit commerciale → promotore ON
 * (lanci, campagne, eventi, opportunità di crescita/investimento)
 */
const PROMOTORE_FIT_PATTERNS = [
  /\blanc(io|iare|iato)\b/,
  /\bnuov[oa] (prodotto|servizio|funzionalit)/,
  /\bcampagn[ae]\b/,
  /\bpromo(zion[ei])?\b/,
  /\boffert[ae]\b/,
  /\bsconto\b/,
  /\binvito\b/,
  /\bwebinar\b/,
  /\bconferenz/,
  /\bevento\b/,
  /\beventi\b/,
  /\biscrizione\b/,
  /\binvestiment/,
  /\bfunding\b/,
  /\bround\b/,
  /\bcrescita aziendale\b/,
  /\bopportunita (di|di business|commerciale)/,
  /\bcall to action\b/,
  /\bcta\b/,
  /\bprenota\b/,
  /\bacquist/,
];

/** Critica diretta a concorrenti → promotore OFF (etica) */
const PROMOTORE_COMPETITOR_PATTERNS = [
  /\bconcorrent/,
  /\bcompetitor\b/,
  /\bvs\b.{0,40}\b(brand|prodotto|azienda)/,
  /\bpeggio (di|del|della)\b/,
  /\bsuperiore a .{0,30}(concorrent|rival)/,
  /\bdenigr/,
  /\bscredit/,
];

/** Promesse irrealistiche → promotore OFF */
const PROMOTORE_UNREALISTIC_PATTERNS = [
  /\bgarantito al 100\b/,
  /\bsenza (alcun )?sforzo\b/,
  /\bdiventa(re)? milionar/,
  /\bricc(hi|o) subito\b/,
  /\bmiracol/,
  /\bzero rischi\b/,
  /\bguadagni facili\b/,
];

/**
 * Contenuto puramente analitico / informativo senza leva di conversione
 * (usato solo se manca PROMOTORE_FIT)
 */
const PROMOTORE_ANALYTICAL_PATTERNS = [
  /\banalisi\b/,
  /\breport\b/,
  /\bstudio (su|sul|sulla|dei|delle)\b/,
  /\bimpatto (di|del|della|dei|delle)\b/,
  /\bdati (su|sul|sulla)\b/,
  /\bstatistich/,
  /\bquadro (di|del)\b/,
  /\bpanoramica\b/,
  /\brassegna\b/,
];

/** Fit informatore: annuncio neutro, presenza evento, aggiornamento operativo */
const INFORMATORE_FIT_PATTERNS = [
  /\bsaremo presenti\b/,
  /\bci vediamo\b/,
  /\bannunciamo\b/,
  /\baggiornamento operativo\b/,
  /\bavviso\b/,
  /\bdisponibilit/,
  /\borari?\b/,
  /\bquando\b/,
  /\bdove\b/,
  /\bstand\b/,
  /\bpadiglione\b/,
  /\bcabina\b/,
  /\bevento\b/,
  /\bfiera\b/,
  /\bconvegno\b/,
];

/** Segnali di conversione commerciale incompatibili con informatore puro */
const INFORMATORE_COMMERCIAL_PATTERNS = [
  /\bdemo\b/,
  /\brichiedi\b/,
  /\bacquista\b/,
  /\bprenota\b/,
  /\bofferta\b/,
  /\bsconto\b/,
  /\bpromo(zion[ei])?\b/,
  /\blead\b/,
  /\bconversione\b/,
  /\bcall to action\b/,
  /\bcta\b/,
];

/** Segnali di attrito/competizione: informatore dovrebbe evitarli */
const INFORMATORE_FRICTION_PATTERNS = [
  /\bpessim[oa]\b/,
  /\bfalliment/,
  /\bcontro\b/,
  /\bvs\b/,
  /\battacc/,
  /\bdenigr/,
  /\bcompetitor\b/,
];

/** Segnali espliciti di spiegazione processo (metodologico) */
const PROCESS_EXPLANATION_PATTERNS = [
  /\bprocesso\b/,
  /\bprocedura\b/,
  /\bstep\b/,
  /\bpassaggi\b/,
  /\bchecklist\b/,
  /\bprotocollo\b/,
  /\bworkflow\b/,
  /\bcome fare\b/,
  /\bcome implementare\b/,
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
  // Segnale umanitario, ma non se “guerra” è solo metafora commerciale
  const isHumanitarian =
    anyMatch(text, HUMANITARIAN_PATTERNS) && !anyMatch(text, COMMERCIAL_WAR_PATTERNS);
  const looksHistorical = anyMatch(text, HISTORICAL_PATTERNS);
  const hasFutureLink = anyMatch(text, FUTURE_LINK_PATTERNS);
  const looksAbstract = anyMatch(text, ABSTRACT_PATTERNS);
  const hasPractical = anyMatch(text, PRACTICAL_PATTERNS);
  const isPromotoreFit = anyMatch(text, PROMOTORE_FIT_PATTERNS);
  const isCompetitorAttack = anyMatch(text, PROMOTORE_COMPETITOR_PATTERNS);
  const isUnrealisticPromise = anyMatch(text, PROMOTORE_UNREALISTIC_PATTERNS);
  const isPureAnalytical =
    anyMatch(text, PROMOTORE_ANALYTICAL_PATTERNS) && !isPromotoreFit;
  const isInformatoreFit = anyMatch(text, INFORMATORE_FIT_PATTERNS);
  const hasCommercialIntent = anyMatch(text, INFORMATORE_COMMERCIAL_PATTERNS);
  const hasFrictionSignals = anyMatch(text, INFORMATORE_FRICTION_PATTERNS);
  const hasProcessExplanation = anyMatch(text, PROCESS_EXPLANATION_PATTERNS);

  return {
    isPolitical,
    isSolemn,
    isHumanitarian,
    isPureHistorical: looksHistorical && !hasFutureLink && !isPolitical,
    isPureAbstract: looksAbstract && !hasPractical && !isPolitical,
    isPromotoreFit,
    isCompetitorAttack,
    isUnrealisticPromise,
    isPureAnalytical,
    isInformatoreFit,
    hasCommercialIntent,
    hasFrictionSignals,
    hasProcessExplanation,
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
 * Principio: OFF solo se il detector conferma; altrimenti ON (tranne promotore: serve fit conversione).
 * Se `enabledTones` è passato, l’output contiene **solo** quei toni (lista company).
 *
 * @param {string} topic — testo input (topic o testo F0)
 * @param {Record<string, {status: string, lock_reason: string}>} tones — già normalizzati
 * @param {{ enabledTones?: string[] }} [opts]
 * @returns {Record<string, {status: string, lock_reason: string}>}
 */
export const enforceToneSuitability = (topic, tones = {}, opts = {}) => {
  const flags = classifyTopicForTones(topic);
  const enabledList = Array.isArray(opts.enabledTones)
    ? opts.enabledTones.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
    : null;
  const allowed = enabledList?.length ? new Set(enabledList) : null;
  const has = (id) => !allowed || allowed.has(id);

  const out = { ...tones };

  for (const id of ALWAYS_ON) {
    if (!has(id)) continue;
    out[id] = forceOn(out[id] || { status: 'ON', lock_reason: '' });
  }

  // Lutto/tragedia OPPURE umanitario/violenza → spegne entrambi i toni “punchy”
  if (has('provocatore') || has('sferzante')) {
    if (flags.isSolemn || flags.isHumanitarian) {
      if (has('provocatore')) {
        out.provocatore = forceOff(out.provocatore || {}, LOCK_REASONS.provocatore);
      }
      if (has('sferzante')) {
        out.sferzante = forceOff(out.sferzante || {}, LOCK_REASONS.sferzante);
      }
    } else {
      if (has('provocatore')) out.provocatore = forceOn(out.provocatore || {});
      if (has('sferzante')) out.sferzante = forceOn(out.sferzante || {});
    }
  }

  // Visionario: OFF solo tema storico puro senza legami attuali; altrimenti sempre ON
  if (has('visionario')) {
    if (flags.isPureHistorical) {
      out.visionario = forceOff(out.visionario || {}, LOCK_REASONS.visionario);
    } else {
      out.visionario = forceOn(out.visionario || {});
    }
  }

  // Metodologico: OFF solo astratto puro senza leva pratica; altrimenti sempre ON
  if (has('metodologico')) {
    if (flags.isPureAbstract) {
      out.metodologico = forceOff(out.metodologico || {}, LOCK_REASONS.metodologico);
    } else {
      out.metodologico = forceOn(out.metodologico || {});
    }
  }

  // Promotore: ON solo con leva di conversione; OFF su sensibilità / etica / no-CTA
  if (has('promotore')) {
    if (flags.isSolemn || flags.isHumanitarian) {
      out.promotore = forceOff(out.promotore || {}, LOCK_REASONS.promotore_sensitive);
    } else if (flags.isCompetitorAttack) {
      out.promotore = forceOff(out.promotore || {}, LOCK_REASONS.promotore_ethics);
    } else if (flags.isUnrealisticPromise) {
      out.promotore = forceOff(out.promotore || {}, LOCK_REASONS.promotore_honesty);
    } else if (flags.isPromotoreFit) {
      out.promotore = forceOn(out.promotore || {});
    } else if (flags.isPureAnalytical) {
      out.promotore = forceOff(out.promotore || {}, LOCK_REASONS.promotore);
    } else {
      // Dubbio senza fit commerciale → OFF (non sprecare conversione)
      out.promotore = forceOff(out.promotore || {}, LOCK_REASONS.promotore);
    }
  }

  // Informatore: ON solo se l'obiettivo è neutro/non commerciale.
  if (has('informatore')) {
    if (
      flags.isInformatoreFit &&
      !flags.hasCommercialIntent &&
      !flags.hasFrictionSignals &&
      !flags.isPromotoreFit
    ) {
      out.informatore = forceOn(out.informatore || {});
    } else {
      out.informatore = forceOff(out.informatore || {}, LOCK_REASONS.informatore);
    }
  }

  // Quando informatore è ON, disattiva i toni non coerenti col registro neutro.
  if (out.informatore?.status === 'ON') {
    if (has('promotore')) {
      out.promotore = forceOff(out.promotore || {}, LOCK_REASONS.informatore_overrides_promotore);
    }
    if (has('provocatore')) {
      out.provocatore = forceOff(out.provocatore || {}, LOCK_REASONS.informatore_overrides_provocatore);
    }
    if (has('visionario')) {
      out.visionario = forceOff(out.visionario || {}, LOCK_REASONS.informatore_overrides_visionario);
    }
    if (has('narratore')) {
      out.narratore = forceOff(out.narratore || {}, LOCK_REASONS.informatore_overrides_narratore);
    }
    // Metodologico resta ON solo se il topic parla esplicitamente di processo.
    if (has('metodologico') && !flags.hasProcessExplanation) {
      out.metodologico = forceOff(out.metodologico || {}, LOCK_REASONS.metodologico);
    }
  }

  // Lista dinamica: solo toni abilitati per la company
  if (allowed) {
    const filtered = {};
    for (const id of enabledList) {
      filtered[id] = out[id] || { status: 'OFF', lock_reason: '' };
    }
    return filtered;
  }

  return out;
};
