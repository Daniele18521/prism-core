/**
 * Test unitari Shaper (F1) — logica di normalizzazione output Gemini.
 * Non chiama Gemini: verifica regole GAP/plan/toni dopo ogni modifica a shaper.js.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToneEntry,
  normalizeToneSuitability,
  normalizeShaperOutput,
} from '../src/services/shaper.js';

describe('Shaper — normalizeToneEntry', () => {
  test('status ON → lock_reason vuoto', () => {
    const out = normalizeToneEntry({ status: 'ON', lock_reason: 'ignorato' });
    assert.equal(out.status, 'ON');
    assert.equal(out.lock_reason, '');
  });

  test('status OFF con lock_reason separato', () => {
    const out = normalizeToneEntry({ status: 'OFF', lock_reason: 'Tema sensibile' });
    assert.equal(out.status, 'OFF');
    assert.equal(out.lock_reason, 'Tema sensibile');
  });

  test('status concatenato OFF + motivo (bug Gemini)', () => {
    const out = normalizeToneEntry({ status: 'OFFRichiesto rispetto solenne', lock_reason: '' });
    assert.equal(out.status, 'OFF');
    assert.equal(out.lock_reason, 'Richiesto rispetto solenne');
  });

  test('status con suffisso ", lock_reason: ..."', () => {
    const out = normalizeToneEntry({ status: 'OFF, lock_reason: Incompatibile con l\'ironia' });
    assert.equal(out.status, 'OFF');
    assert.equal(out.lock_reason, 'Incompatibile con l\'ironia');
  });
});

describe('Shaper — normalizeShaperOutput', () => {
  const baseTones = () => ({
    provocatore: { status: 'ON', lock_reason: '' },
    confidente: { status: 'ON', lock_reason: '' },
    sferzante: { status: 'ON', lock_reason: '' },
    visionario: { status: 'ON', lock_reason: '' },
    metodologico: { status: 'ON', lock_reason: '' },
    narratore: { status: 'ON', lock_reason: '' },
  });

  test('tutti pilastri OK → search_required false e plan vuoto', () => {
    const out = normalizeShaperOutput({
      is_blocked: false,
      block_message: '',
      diagnosi: { scenario: 'OK', context: 'OK', sfide_opportunita: 'OK' },
      search_required: true,
      tone_suitability: baseTones(),
      plan: [{ pillar: 'SCENARIO', query: 'query fantasma 2026' }],
    });
    assert.equal(out.search_required, false);
    assert.deepEqual(out.plan, []);
  });

  test('almeno un GAP → search_required true', () => {
    const out = normalizeShaperOutput({
      is_blocked: false,
      block_message: '',
      diagnosi: { scenario: 'GAP', context: 'OK', sfide_opportunita: 'GAP' },
      search_required: false,
      tone_suitability: baseTones(),
      plan: [
        { pillar: 'SCENARIO', query: 'q scenario 2026' },
        { pillar: 'CONTESTO', query: 'q contesto 2026' },
        { pillar: 'SFIDE_OPPORTUNITA', query: 'q sfide 2026' },
      ],
    });
    assert.equal(out.search_required, true);
    assert.equal(out.plan.length, 2);
    assert.ok(out.plan.every((p) => ['SCENARIO', 'SFIDE_OPPORTUNITA'].includes(p.pillar)));
    assert.ok(!out.plan.some((p) => p.pillar === 'CONTESTO'));
  });

  test('plan filtrato solo pilastri GAP (case insensitive)', () => {
    const out = normalizeShaperOutput({
      is_blocked: false,
      block_message: '',
      diagnosi: { scenario: 'gap', context: 'OK', sfide_opportunita: 'OK' },
      search_required: true,
      tone_suitability: baseTones(),
      plan: [
        { pillar: 'scenario', query: 'unica query 2026' },
        { pillar: 'CONTESTO', query: 'non deve restare 2026' },
      ],
    });
    assert.equal(out.plan.length, 1);
    assert.equal(out.plan[0].pillar, 'scenario');
  });

  test('normalizza toni e gatekeeper forza ON su topic neutro', () => {
    const out = normalizeShaperOutput(
      {
        is_blocked: false,
        block_message: '',
        diagnosi: { scenario: 'OK', context: 'OK', sfide_opportunita: 'OK' },
        search_required: false,
        tone_suitability: {
          provocatore: { status: 'OFFMotivo provocatore' },
          confidente: { status: 'ON' },
          sferzante: { status: 'OFF', lock_reason: 'ironia' },
          visionario: { status: 'ON' },
          metodologico: { status: 'ON' },
          narratore: { status: 'ON' },
        },
        plan: [],
      },
      'Trend marketing digitale 2026',
    );
    // Gemini aveva messo OFF, ma senza segnali solenni/umanitari → ON
    assert.equal(out.tone_suitability.provocatore.status, 'ON');
    assert.equal(out.tone_suitability.sferzante.status, 'ON');
    assert.equal(out.tone_suitability.confidente.status, 'ON');
  });

  test('topic politico: provocatore e sferzante ON anche se Gemini spegne', () => {
    const out = normalizeShaperOutput(
      {
        is_blocked: false,
        block_message: '',
        diagnosi: { scenario: 'OK', context: 'OK', sfide_opportunita: 'OK' },
        search_required: false,
        tone_suitability: {
          provocatore: { status: 'OFF', lock_reason: 'Richiesto rispetto solenne' },
          confidente: { status: 'ON', lock_reason: '' },
          sferzante: { status: 'OFF', lock_reason: "Incompatibile con l'ironia" },
          visionario: { status: 'ON', lock_reason: '' },
          metodologico: { status: 'ON', lock_reason: '' },
          narratore: { status: 'ON', lock_reason: '' },
        },
        plan: [],
      },
      'Crisi di governo Meloni: Camera respinge emendamento, opposizioni chiedono dimissioni',
    );
    assert.equal(out.tone_suitability.provocatore.status, 'ON');
    assert.equal(out.tone_suitability.sferzante.status, 'ON');
  });
});

describe('Shaper — normalizeToneSuitability', () => {
  test('restituisce sempre le 6 chiavi tono', () => {
    const out = normalizeToneSuitability({ confidente: { status: 'ON' } });
    assert.equal(Object.keys(out).length, 6);
    assert.equal(out.confidente.status, 'ON');
    assert.equal(out.provocatore.status, 'OFF');
  });
});
