/**
 * Test unitari promptLoader e companyAccess (senza Firestore reale).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformToDocId,
  resolveBypassDataCutting,
  applyPromptPlaceholders,
  buildInputVariablesBlock,
} from '../src/services/promptLoader.js';

describe('promptLoader — helpers', () => {
  test('platformToDocId normalizza LinkedIn/Facebook/X', () => {
    assert.equal(platformToDocId('LinkedIn'), 'linkedin');
    assert.equal(platformToDocId('facebook'), 'facebook');
    assert.equal(platformToDocId('Twitter'), 'x');
    assert.equal(platformToDocId('X'), 'x');
    assert.equal(platformToDocId(''), 'linkedin');
  });

  test('BYPASS_DATA_CUTTING true solo se search_required=false (input utente completo)', () => {
    // Nessuna search → non tagliare i dati in prima generazione
    assert.equal(resolveBypassDataCutting({ search_required: false }), true);
    // Search fatta (o da fare) → taglio selettivo, resto in regen
    assert.equal(resolveBypassDataCutting({ search_required: true }), false);
    // Scenario OK ma search su altri pilastri → comunque FALSE
    assert.equal(
      resolveBypassDataCutting({
        search_required: true,
        diagnosi: { scenario: 'OK', context: 'GAP', sfide_opportunita: 'GAP' },
      }),
      false,
    );
    // Tutti OK → search_required false → TRUE
    assert.equal(
      resolveBypassDataCutting({
        search_required: false,
        diagnosi: { scenario: 'OK', context: 'OK', sfide_opportunita: 'OK' },
      }),
      true,
    );
    assert.equal(resolveBypassDataCutting({}), false);
    assert.equal(resolveBypassDataCutting(null), false);
  });

  test('applyPromptPlaceholders sostituisce {{VAR}}', () => {
    const out = applyPromptPlaceholders('Ciao {{ LINGUA_OUTPUT }} su {{PIATTAFORMA}}', {
      LINGUA_OUTPUT: 'italiano',
      PIATTAFORMA: 'LinkedIn',
    });
    assert.equal(out, 'Ciao italiano su LinkedIn');
  });

  test('buildInputVariablesBlock include tutti i campi richiesti', () => {
    const block = buildInputVariablesBlock({
      LINGUA_OUTPUT: 'italiano',
      PIATTAFORMA: 'LinkedIn',
      TONO: 'sferzante',
      BYPASS_DATA_CUTTING: true,
      ISTRUZIONI_AGGIUNTIVE: 'più corto',
      CONTENUTO_PRECEDENTE: 'testo vecchio',
      ARGOMENTO: 'Meloni Camera',
    });
    assert.match(block, /LINGUA_OUTPUT: italiano/);
    assert.match(block, /PIATTAFORMA: LinkedIn/);
    assert.match(block, /TONO: sferzante/);
    assert.match(block, /BYPASS_DATA_CUTTING: TRUE/);
    assert.match(block, /ISTRUZIONI_AGGIUNTIVE: più corto/);
    assert.match(block, /CONTENUTO_PRECEDENTE: testo vecchio/);
    assert.match(block, /ARGOMENTO: Meloni Camera/);
  });
});
