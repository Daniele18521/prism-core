/**
 * Test unitari Refiner (F3) — anti-allucinazione, consolidamento pilastri.
 * Non chiama Gemini: verifica sanitize e consolidate dopo ogni modifica a refiner.js.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSentenceGrounded,
  sanitizeCompressedFacts,
  consolidatePillarBlocks,
} from '../src/services/refiner.js';

const rawResults = [
  {
    sourceId: 'S1',
    title: 'Fonte test',
    url: 'https://example.com',
    content: 'Nel 2026 la crescita è del 15% secondo il rapporto ufficiale.',
    pillar: 'SCENARIO',
  },
];

describe('Refiner — isSentenceGrounded', () => {
  const sourceById = { S1: 'Fonte test\nNel 2026 la crescita è del 15%.' };

  test('frase con citazione e numeri presenti in fonte → grounded', () => {
    assert.equal(
      isSentenceGrounded('La crescita è del 15% nel 2026 [S1].', sourceById),
      true
    );
  });

  test('frase senza citazione [Sx] → non grounded', () => {
    assert.equal(isSentenceGrounded('La crescita è del 15% nel 2026.', sourceById), false);
  });

  test('data inventata non presente in fonte → non grounded', () => {
    assert.equal(
      isSentenceGrounded('Il 8 marzo 2026 è la scadenza [S1].', sourceById),
      false
    );
  });

  test('numero inventato non in fonte → non grounded', () => {
    assert.equal(
      isSentenceGrounded('Il mercato vale 999 miliardi [S1].', sourceById),
      false
    );
  });
});

describe('Refiner — sanitizeCompressedFacts', () => {
  test('scarta frase con data allucinata, mantiene frase verificabile', () => {
    const input = [
      'SCENARIO: Il 8 marzo 2026 scade il termine [S1]. La crescita è del 15% nel 2026 [S1].',
    ];
    const out = sanitizeCompressedFacts(input, rawResults, { scenario: 'GAP' });
    assert.equal(out.length, 1);
    assert.match(out[0], /15%/);
    assert.doesNotMatch(out[0], /8 marzo/);
  });

  test('pilastro OK salta validazione web', () => {
    const input = ['CONTESTO: Testo dall\'input utente senza citazioni.'];
    const out = sanitizeCompressedFacts(input, rawResults, { context: 'OK' });
    assert.deepEqual(out, input);
  });

  test('pilastro GAP senza frasi verificabili → blocco omesso', () => {
    const input = ['SFIDE_OPPORTUNITA: Tutto inventato 888888 [S1].'];
    const out = sanitizeCompressedFacts(input, rawResults, { sfide_opportunita: 'GAP' });
    assert.deepEqual(out, []);
  });

  test('senza rawResults passa i fatti invariati', () => {
    const input = ['SCENARIO: Testo libero.'];
    assert.deepEqual(sanitizeCompressedFacts(input, []), input);
  });
});

describe('Refiner — consolidatePillarBlocks', () => {
  test('unisce duplicati stesso pilastro in un blocco', () => {
    const out = consolidatePillarBlocks([
      'SCENARIO: Primo fatto.',
      'SCENARIO: Secondo fatto.',
      'CONTESTO: Contesto unico.',
      'SFIDE_OPPORTUNITA: Sfida.',
    ]);
    assert.equal(out.length, 3);
    assert.match(out[0], /^SCENARIO: Primo fatto\. Secondo fatto\./);
    assert.equal(out[1], 'CONTESTO: Contesto unico.');
    assert.equal(out[2], 'SFIDE_OPPORTUNITA: Sfida.');
  });

  test('ordine canonico SCENARIO → CONTESTO → SFIDE_OPPORTUNITA', () => {
    const out = consolidatePillarBlocks([
      'SFIDE_OPPORTUNITA: Z.',
      'SCENARIO: A.',
      'CONTESTO: B.',
    ]);
    assert.deepEqual(out.map((l) => l.split(':')[0]), ['SCENARIO', 'CONTESTO', 'SFIDE_OPPORTUNITA']);
  });

  test('omette pilastri vuoti', () => {
    const out = consolidatePillarBlocks(['SCENARIO: Solo scenario.']);
    assert.equal(out.length, 1);
    assert.match(out[0], /^SCENARIO:/);
  });
});
