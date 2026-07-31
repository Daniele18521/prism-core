/**
 * Test gatekeeper toni — regole hard ON/OFF indipendenti da Gemini.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTopicForTones,
  enforceToneSuitability,
  LOCK_REASONS,
} from '../src/utils/toneGatekeeper.js';

/** Simula Gemini che spegne provocatore e sferzante per errore */
const geminiFalseOff = () => ({
  provocatore: { status: 'OFF', lock_reason: 'Tema sensibile' },
  confidente: { status: 'ON', lock_reason: '' },
  sferzante: { status: 'OFF', lock_reason: "Incompatibile con l'ironia" },
  visionario: { status: 'ON', lock_reason: '' },
  metodologico: { status: 'ON', lock_reason: '' },
  narratore: { status: 'ON', lock_reason: '' },
});

describe('toneGatekeeper — classifyTopicForTones', () => {
  test('crisi Meloni / Camera → politica', () => {
    const text = `
      La Camera dei deputati ha respinto un emendamento sulle preferenze elettorali.
      Spaccatura nella maggioranza. Le opposizioni chiedono le dimissioni di Meloni.
      Studio microplastiche e infarto miocardico.
    `;
    const flags = classifyTopicForTones(text);
    assert.equal(flags.isPolitical, true);
    assert.equal(flags.isSolemn, false);
    assert.equal(flags.isHumanitarian, false);
  });

  test('lutto con funerali → solenne', () => {
    const flags = classifyTopicForTones('Funerali di Stato e cordoglio nazionale per le vittime del disastro');
    assert.equal(flags.isSolemn, true);
  });

  test('crisi umanitaria → umanitario', () => {
    const flags = classifyTopicForTones('Crisi umanitaria e campi profughi dopo la guerra civile');
    assert.equal(flags.isHumanitarian, true);
  });

  test('guerra + bambini sfollati → umanitario (anche senza “crisi umanitaria”)', () => {
    const flags = classifyTopicForTones('Impatto della guerra sui bambini sfollati');
    assert.equal(flags.isHumanitarian, true);
    assert.equal(flags.isSolemn, false);
  });

  test('guerra dei prezzi → non umanitario', () => {
    const flags = classifyTopicForTones('Guerra dei prezzi nel retail e sconti 2026');
    assert.equal(flags.isHumanitarian, false);
  });
});

describe('toneGatekeeper — enforceToneSuitability', () => {
  test('caso Meloni: Gemini spegne provocatore/sferzante → gatekeeper li riaccende', () => {
    const topic = `
      SCENARIO: La Camera dei deputati ha respinto con 233 voti un emendamento
      sulle preferenze elettorali. Spaccatura maggioranza centrodestra.
      Studio microplastiche nel sangue coronarico e infarto miocardico.
      CONTESTO: Opposizioni denunciano minoranza di governo Fratelli d'Italia.
      SFIDE: Meloni deve gestire crisi dopo Lega e Forza Italia. Dimissioni chieste.
    `;
    const out = enforceToneSuitability(topic, geminiFalseOff());
    assert.equal(out.provocatore.status, 'ON');
    assert.equal(out.sferzante.status, 'ON');
    assert.equal(out.confidente.status, 'ON');
    assert.equal(out.narratore.status, 'ON');
  });

  test('studio medico senza politica → toni punchy ON (niente falso OFF)', () => {
    const topic = 'Ricerca Sapienza: microplastiche e rischio di infarto miocardico acuto 2026';
    const out = enforceToneSuitability(topic, geminiFalseOff());
    assert.equal(out.provocatore.status, 'ON');
    assert.equal(out.sferzante.status, 'ON');
  });

  test('lutto vero → provocatore e sferzante OFF, confidente ON', () => {
    const topic = 'Commemorazione e cordoglio per le vittime del terremoto: funerali di Stato';
    const out = enforceToneSuitability(topic, {
      ...geminiFalseOff(),
      provocatore: { status: 'ON', lock_reason: '' },
      sferzante: { status: 'ON', lock_reason: '' },
    });
    assert.equal(out.provocatore.status, 'OFF');
    assert.equal(out.provocatore.lock_reason, LOCK_REASONS.provocatore);
    assert.equal(out.sferzante.status, 'OFF');
    assert.equal(out.confidente.status, 'ON');
  });

  test('genocidio / crisi umanitaria → provocatore e sferzante OFF', () => {
    const topic = 'Reportage sulla crisi umanitaria e crimini di guerra contro i civili';
    const out = enforceToneSuitability(topic, {
      ...geminiFalseOff(),
      provocatore: { status: 'ON', lock_reason: '' },
      sferzante: { status: 'ON', lock_reason: '' },
    });
    assert.equal(out.provocatore.status, 'OFF');
    assert.equal(out.provocatore.lock_reason, LOCK_REASONS.provocatore);
    assert.equal(out.sferzante.status, 'OFF');
    assert.equal(out.sferzante.lock_reason, LOCK_REASONS.sferzante);
    assert.equal(out.confidente.status, 'ON');
  });

  test('bambini sfollati in guerra: Gemini ON → gatekeeper spegne punchy', () => {
    const topic = 'Impatto della guerra sui bambini sfollati';
    const out = enforceToneSuitability(topic, {
      provocatore: { status: 'ON', lock_reason: '' },
      confidente: { status: 'ON', lock_reason: '' },
      sferzante: { status: 'ON', lock_reason: '' },
      visionario: { status: 'ON', lock_reason: '' },
      metodologico: { status: 'ON', lock_reason: '' },
      narratore: { status: 'ON', lock_reason: '' },
    });
    assert.equal(out.provocatore.status, 'OFF');
    assert.equal(out.sferzante.status, 'OFF');
    assert.equal(out.confidente.status, 'ON');
    assert.equal(out.narratore.status, 'ON');
  });

  test('business generico → tutti ON anche se Gemini spegne', () => {
    const topic = 'Come scalare un SaaS B2B nel 2026: pricing e retention';
    const out = enforceToneSuitability(topic, geminiFalseOff());
    assert.equal(out.provocatore.status, 'ON');
    assert.equal(out.sferzante.status, 'ON');
    assert.equal(out.visionario.status, 'ON');
    assert.equal(out.metodologico.status, 'ON');
  });

  test('archeologia pura → visionario OFF', () => {
    const topic = 'Scavi archeologici nell\'antica Roma: reperto archeologico dell\'età del bronzo';
    const out = enforceToneSuitability(topic, {
      ...geminiFalseOff(),
      visionario: { status: 'ON', lock_reason: '' },
    });
    assert.equal(out.visionario.status, 'OFF');
    assert.equal(out.visionario.lock_reason, LOCK_REASONS.visionario);
  });
});
