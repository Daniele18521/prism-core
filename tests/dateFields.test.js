/**
 * Conversione date Redis (ISO) ↔ Firestore (Timestamp).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import {
  toFirestoreTimestamp,
  toIsoString,
  mapDateFieldsDeep,
} from '../src/services/stateManager.js';

describe('date fields — Firestore Timestamp', () => {
  test('ISO string → Timestamp → stessa ISO', () => {
    const iso = '2026-07-28T10:46:35.123Z';
    const ts = toFirestoreTimestamp(iso);
    assert.ok(ts instanceof Timestamp);
    assert.equal(toIsoString(ts), iso);
  });

  test('null e stringa invalida → null', () => {
    assert.equal(toFirestoreTimestamp(null), null);
    assert.equal(toFirestoreTimestamp('non-una-data'), null);
    assert.equal(toIsoString(null), null);
  });

  test('mapDateFieldsDeep converte solo chiavi data (anche nested)', () => {
    const iso = '2026-07-28T10:46:35.123Z';
    const payload = {
      jobId: 'j1',
      createdAt: iso,
      updatedAt: iso,
      topic: 'test',
      research: {
        contentIngest: { updatedAt: iso, sourceUrl: 'https://x.test' },
        tavily: {
          rawResults: [{ sourceId: 'S1', retrievedAt: iso, title: 'A' }],
        },
      },
      sourceMeta: { extractedAt: iso, type: 'url' },
    };

    const forFs = mapDateFieldsDeep(payload, toFirestoreTimestamp);
    assert.ok(forFs.createdAt instanceof Timestamp);
    assert.ok(forFs.research.contentIngest.updatedAt instanceof Timestamp);
    assert.ok(forFs.research.tavily.rawResults[0].retrievedAt instanceof Timestamp);
    assert.ok(forFs.sourceMeta.extractedAt instanceof Timestamp);
    assert.equal(forFs.topic, 'test');
    assert.equal(forFs.research.tavily.rawResults[0].title, 'A');

    const back = mapDateFieldsDeep(forFs, toIsoString);
    assert.equal(back.createdAt, iso);
    assert.equal(back.research.contentIngest.updatedAt, iso);
    assert.equal(back.research.tavily.rawResults[0].retrievedAt, iso);
  });
});
