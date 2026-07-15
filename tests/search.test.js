/**
 * Test unitari Search (F2) — logica Tavily senza chiamate di rete.
 * Usa client mock iniettato per verificare partial failure, ID fonti, plan vuoto.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { performWebSearch } from '../src/services/search.js';
import { AppError } from '../src/utils/errors.js';

const sampleResult = (title, content) => ({
  title,
  url: `https://example.com/${title}`,
  content,
});

describe('Search — performWebSearch', () => {
  let savedTavilyKey;

  beforeEach(() => {
    savedTavilyKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'test-key-mock';
  });

  afterEach(() => {
    if (savedTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedTavilyKey;
  });

  test('plan vuoto → rawResults [] senza chiamare Tavily', async () => {
    let called = false;
    const out = await performWebSearch([], {
      getTavilyClient: () => {
        called = true;
        return { search: async () => ({ results: [] }) };
      },
    });
    assert.deepEqual(out.rawResults, []);
    assert.equal(called, false);
  });

  test('TAVILY_API_KEY mancante → AppError non retryable', async () => {
    delete process.env.TAVILY_API_KEY;
    await assert.rejects(
      () => performWebSearch([{ pillar: 'SCENARIO', query: 'test 2026' }]),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'TAVILY_CONFIG');
        assert.equal(err.retryable, false);
        assert.equal(err.step, 'tavily_search');
        return true;
      }
    );
  });

  test('numerazione globale sourceId S1, S2, S3 su più query', async () => {
    const out = await performWebSearch(
      [
        { pillar: 'SCENARIO', query: 'q1' },
        { pillar: 'CONTESTO', query: 'q2' },
      ],
      {
        getTavilyClient: () => ({
          search: async (query) => ({
            results: [
              sampleResult(`t1-${query}`, 'contenuto uno'),
              sampleResult(`t2-${query}`, 'contenuto due'),
            ],
          }),
        }),
      }
    );
    assert.equal(out.rawResults.length, 4);
    assert.deepEqual(out.rawResults.map((r) => r.sourceId), ['S1', 'S2', 'S3', 'S4']);
    assert.equal(out.rawResults[0].pillar, 'SCENARIO');
    assert.equal(out.rawResults[2].pillar, 'CONTESTO');
    assert.ok(out.rawResults[0].content.length <= 4000);
  });

  test('una query fallisce → risultati parziali + partialFailures', async () => {
    let n = 0;
    const out = await performWebSearch(
      [
        { pillar: 'SCENARIO', query: 'q1' },
        { pillar: 'SFIDE_OPPORTUNITA', query: 'q2' },
      ],
      {
        getTavilyClient: () => ({
          search: async () => {
            n += 1;
            if (n === 1) throw new Error('rete down');
            return { results: [sampleResult('ok', 'dati verificabili 2026')] };
          },
        }),
      }
    );
    assert.equal(out.rawResults.length, 1);
    assert.equal(out.partialFailures?.length, 1);
    assert.equal(out.partialFailures[0].pillar, 'SCENARIO');
  });

  test('tutte le query falliscono → AppError TAVILY_ALL_FAILED retryable', async () => {
    await assert.rejects(
      () => performWebSearch(
        [{ pillar: 'SCENARIO', query: 'q1' }],
        {
          getTavilyClient: () => ({
            search: async () => { throw new Error('timeout'); },
          }),
        }
      ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'TAVILY_ALL_FAILED');
        assert.equal(err.retryable, true);
        assert.equal(err.step, 'tavily_search');
        return true;
      }
    );
  });

  test('accetta voci plan come stringhe (legacy)', async () => {
    const out = await performWebSearch(['query semplice 2026'], {
      getTavilyClient: () => ({
        search: async () => ({ results: [sampleResult('fonte', 'testo')] }),
      }),
    });
    assert.equal(out.rawResults.length, 1);
    assert.equal(out.rawResults[0].sourceId, 'S1');
  });
});
