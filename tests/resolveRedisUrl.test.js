/**
 * Test unitari risoluzione URL Redis (locale vs produzione).
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRedisUrl,
  resolveRedisProfile,
  maskRedisUrl,
} from '../src/utils/resolveRedisUrl.js';

const snapshotEnv = () => ({ ...process.env });

describe('resolveRedisUrl', () => {
  let saved;

  beforeEach(() => {
    saved = snapshotEnv();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_URL_LOCAL;
    delete process.env.REDIS_URL_PRODUCTION;
    delete process.env.PRISM_ENV;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    // Ripristina le variabili ambiente modificate dal test
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  test('development → Redis locale di default', () => {
    process.env.NODE_ENV = 'development';
    const out = resolveRedisUrl();
    assert.equal(out.profile, 'local');
    assert.equal(out.url, 'redis://127.0.0.1:6379');
    assert.equal(out.source, 'default');
  });

  test('NODE_ENV=production → REDIS_URL_PRODUCTION', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL_PRODUCTION = 'rediss://user:pass@upstash.example:6379';
    const out = resolveRedisUrl();
    assert.equal(out.profile, 'production');
    assert.equal(out.url, 'rediss://user:pass@upstash.example:6379');
  });

  test('REDIS_URL vince come override', () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_URL = 'redis://custom:6380';
    const out = resolveRedisUrl();
    assert.equal(out.url, 'redis://custom:6380');
    assert.equal(out.source, 'REDIS_URL');
  });

  test('PRISM_ENV=production forza cloud anche in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.PRISM_ENV = 'production';
    process.env.REDIS_URL_PRODUCTION = 'rediss://prod.example:6379';
    assert.equal(resolveRedisProfile(), 'production');
  });

  test('maskRedisUrl nasconde la password', () => {
    const masked = maskRedisUrl('rediss://default:secret@host.upstash.io:6379');
    assert.ok(!masked.includes('secret'));
    assert.ok(masked.includes('****'));
  });
});
