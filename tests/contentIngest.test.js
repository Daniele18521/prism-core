/**
 * Test unitari Content Ingest (F0) — rilevamento URL ed estrazione senza rete reale.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUrlInput,
  extractContentFromUrl,
  resolveInput,
} from '../src/services/contentIngest.js';

describe('contentIngest — isUrlInput', () => {
  test('accetta URL http/https validi', () => {
    assert.equal(isUrlInput('https://www.example.com/articolo'), true);
    assert.equal(isUrlInput('http://blog.test.it/post'), true);
  });

  test('rifiuta testo libero e pilastri pre-lavorati', () => {
    assert.equal(isUrlInput('Coiltech Novi giugno 2026'), false);
    assert.equal(isUrlInput('SCENARIO: dati numerici.'), false);
    assert.equal(isUrlInput(''), false);
  });

  test('rifiuta protocolli non web', () => {
    assert.equal(isUrlInput('javascript:alert(1)'), false);
    assert.equal(isUrlInput('file:///C:/secret.txt'), false);
  });
});

describe('contentIngest — extractContentFromUrl (mock)', () => {
  test('estrae testo e metadati da risposta Tavily mock', async () => {
    const mockClient = () => ({
      extract: async () => ({
        results: [{
          url: 'https://example.com/post',
          title: 'Titolo articolo',
          rawContent: 'Contenuto articolo '.repeat(30),
        }],
        failedResults: [],
      }),
    });

    const out = await extractContentFromUrl('https://example.com/post', {
      getTavilyClient: mockClient,
    });

    assert.ok(out.text.length >= 200);
    assert.equal(out.sourceUrl, 'https://example.com/post');
    assert.equal(out.sourceTitle, 'Titolo articolo');
  });

  test('pagina vuota → EXTRACT_EMPTY non retryable', async () => {
    const mockClient = () => ({
      extract: async () => ({
        results: [],
        failedResults: [{ url: 'https://paywall.com', error: 'Blocked' }],
      }),
    });

    await assert.rejects(
      () => extractContentFromUrl('https://paywall.com', { getTavilyClient: mockClient }),
      (err) => err.code === 'EXTRACT_EMPTY' && err.retryable === false && err.step === 'content_ingest',
    );
  });
});

describe('contentIngest — resolveInput', () => {
  test('testo libero → F0 saltato', async () => {
    const out = await resolveInput('Argomento breve ma valido');
    assert.equal(out.inputType, 'text');
    assert.equal(out.topic, 'Argomento breve ma valido');
    assert.equal(out.sourceMeta, null);
  });

  test('URL → F0 attivo con testo estratto', async () => {
    const mockClient = () => ({
      extract: async () => ({
        results: [{
          url: 'https://example.com/a',
          title: 'Post',
          rawContent: 'Testo estratto dal sito. '.repeat(20),
        }],
        failedResults: [],
      }),
    });

    const out = await resolveInput('https://example.com/a', { getTavilyClient: mockClient });
    assert.equal(out.inputType, 'url');
    assert.equal(out.originalInput, 'https://example.com/a');
    assert.ok(out.topic.length >= 200);
    assert.equal(out.sourceMeta?.url, 'https://example.com/a');
  });
});
