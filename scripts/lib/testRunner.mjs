/**
 * Helper condivisi per script di test pipeline (run-pipeline, test-error-handling).
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const log = {
  ok: (msg) => console.log(`  ✅ ${msg}`),
  fail: (msg) => console.log(`  ❌ ${msg}`),
  info: (msg) => console.log(`  ℹ️  ${msg}`),
  scopo: (msg) => console.log(`     Scopo: ${msg}`),
  section: (msg) => console.log(`\n▶ ${msg}`),
  warn: (msg) => console.log(`  ⚠️  ${msg}`),
};

/** Rimuove virgolette esterne da argomento CLI */
const unquote = (s) => String(s ?? '').replace(/^["']|["']$/g, '');

/**
 * Legge flag CLI comuni.
 * Default: --mock (nessuna chiamata Gemini/Tavily). Usa --live per API reali.
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const has = (flag) => argv.includes(flag);

  const getEq = (prefix) => {
    const hit = argv.find((a) => a.startsWith(`${prefix}=`));
    return hit ? unquote(hit.slice(prefix.length + 1)) : null;
  };

  const getNext = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) return null;
    return unquote(argv[i + 1]);
  };

  const topic =
    getEq('--topic')
    || getNext('--topic')
    || process.env.TEST_TOPIC
    || null;

  const live = has('--live');
  const mock = has('--mock') || !live;

  const simulatePhase = getEq('--phase') || (has('--simulate') ? 'F2' : null);
  const simulateMode = getEq('--fault-mode') || 'fatal';

  const timeoutSec = Number(getEq('--timeout') || process.env.TEST_TIMEOUT_SEC || 120);
  const verbose = has('--verbose') || process.env.TEST_VERBOSE === 'true';
  const help = has('--help') || has('-h');

  const expectStatus = getEq('--expect') || (simulatePhase ? 'failed' : 'completed');

  return {
    topic,
    mock,
    live,
    modeLabel: mock ? 'MOCK (no Gemini/Tavily)' : 'LIVE (Gemini + Tavily reali)',
    simulatePhase,
    simulateMode,
    timeoutMs: Math.max(15, timeoutSec) * 1000,
    verbose,
    help,
    expectStatus,
    integration: has('--integration'),
    simulate: has('--simulate') || Boolean(simulatePhase),
    apiOnly: !has('--integration') && !has('--simulate') && !simulatePhase && !has('--pipeline'),
  };
}

export function printCliHelp(scriptName) {
  console.log(`
Uso: node scripts/${scriptName} [opzioni]

Modalità pipeline (job shaping F1→F3):
  --mock              Simulazione locale, nessuna chiamata Gemini/Tavily (DEFAULT)
  --live              Chiamate reali a Gemini e Tavily (consuma quota API)
  --topic="argomento" Argomento da analizzare (obbligatorio per run pipeline)
  --expect=completed  Status atteso: completed | failed | blocked (default: completed)
  --timeout=120       Secondi massimi di polling (default: 120)
  --verbose           Mostra log del worker temporaneo

Simulazione errore worker (opzionale):
  --simulate          Attiva SIMULATE_FAULT (default fase F2)
  --phase=F2          F1 | F2 | F3 | F4
  --fault-mode=fatal  fatal | transient

Test suite errori (test-error-handling.mjs):
  --integration       Gruppo B — job end-to-end
  (senza flag)        Gruppo A — solo API

Variabili .env:
  TEST_TOPIC, TEST_USER_ID, TEST_COMPANY_ID, API_BASE, TEST_TIMEOUT_SEC

Esempi (PowerShell):
  node scripts/run-pipeline.mjs --mock --topic="Trend e-commerce moda 2026"
  node scripts/run-pipeline.mjs --live --topic="Situazione geopolitica Iraq 2026"
  node scripts/run-pipeline.mjs --mock --simulate --phase=F2 --topic="Test errore F2"
  npm run test:pipeline -- --live --topic="Il mio argomento"
`);
}

/** L'API avvolge completed/running in { success, data }; failed/blocked sono piatti. */
export function parseJobStatusBody(body) {
  if (!body) return null;
  if (body.success === true && body.data) return body.data;
  if (body.status) return body;
  return null;
}

export async function request(apiBase, method, urlPath, body) {
  const res = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

export async function pollJobStatus(apiBase, userId, jobId, { expectStatus, timeoutMs = 120_000, onTick }) {
  const start = Date.now();
  let lastSnapshot = null;

  while (Date.now() - start < timeoutMs) {
    const { status: httpStatus, data: body } = await request(apiBase, 'GET', `/jobs/status/${userId}/${jobId}`);

    if (httpStatus === 404) {
      lastSnapshot = 'JOB_NOT_FOUND (404)';
      if (onTick) onTick(lastSnapshot);
      await sleep(2000);
      continue;
    }

    const job = parseJobStatusBody(body);
    if (job?.status) {
      lastSnapshot = `status=${job.status}${job.workerState?.currentStep ? ` step=${job.workerState.currentStep}` : ''}${job.error?.step ? ` err=${job.error.step}` : ''}`;
      if (onTick) onTick(lastSnapshot, job);
      if (job.status === expectStatus) return job;
      if (['completed', 'failed', 'blocked'].includes(job.status) && !expectStatus) return job;
    } else {
      lastSnapshot = JSON.stringify(body)?.slice(0, 120);
      if (onTick) onTick(lastSnapshot);
    }

    await sleep(2000);
  }

  throw new Error(
    `Timeout: job ${jobId} non ha raggiunto status "${expectStatus}" entro ${timeoutMs / 1000}s` +
    (lastSnapshot ? ` (ultimo stato: ${lastSnapshot})` : '')
  );
}

export async function enqueueShaping(apiBase, { userId, companyId, topic }) {
  const { status, data } = await request(apiBase, 'POST', '/api/prepare-shaping', {
    userId,
    companyId,
    topic,
    platform: 'general',
    language: 'italiano',
  });
  if (!(status === 200 && data?.success && data?.jobId)) {
    throw new Error(`Accodamento fallito: HTTP ${status} ${JSON.stringify(data)}`);
  }
  return data.jobId;
}

export function createWorkerManager({ verbose = false } = {}) {
  let workerProcess = null;

  const spawnWorker = (extraEnv = {}) => new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const child = spawn(process.execPath, ['src/worker/processor.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (verbose) process.stdout.write(`     [worker] ${text}`);
      if (!started && (text.includes('Worker PRISM operativo') || text.includes('Redis pronto'))) {
        started = true;
        resolve(child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);

    setTimeout(() => {
      if (!started) {
        child.kill();
        reject(new Error('Worker non avviato entro 15s (controlla Redis e .env)'));
      }
    }, 15_000);
  });

  const stopWorker = async () => {
    if (!workerProcess) return;
    workerProcess.kill('SIGTERM');
    await sleep(1000);
    workerProcess = null;
  };

  const startWorker = async (extraEnv) => {
    workerProcess = await spawnWorker(extraEnv);
    await sleep(2000);
    return workerProcess;
  };

  return { startWorker, stopWorker };
}

export function workerEnvFromCli({ mock, simulatePhase, simulateMode }) {
  const env = {
    USE_MOCK_GENERATOR: mock ? 'true' : 'false',
  };
  if (simulatePhase) {
    env.SIMULATE_FAULT = simulatePhase;
    env.SIMULATE_FAULT_MODE = simulateMode;
  }
  return env;
}

export function assertLiveKeys() {
  const missing = [];
  if (!process.env.GEMINI_API_KEY?.trim()) missing.push('GEMINI_API_KEY');
  if (!process.env.TAVILY_API_KEY?.trim()) missing.push('TAVILY_API_KEY');
  if (missing.length) {
    throw new Error(`Modalità LIVE richiede nel .env: ${missing.join(', ')}`);
  }
}

const STEP_MAP = {
  F0: 'content_ingest',
  F1: 'query_shaping',
  F2: 'tavily_search',
  F3: 'refiner',
  F4: 'generation',
};

export function expectedFaultStep(phase) {
  return STEP_MAP[phase] || 'tavily_search';
}

export function printJobSummary(job, { topic, mock }) {
  console.log('\n── Risultato job ──');
  console.log(`  Modalità:  ${mock ? 'MOCK' : 'LIVE'}`);
  console.log(`  Topic:     ${topic}`);
  console.log(`  Status:    ${job.status}`);
  console.log(`  JobId:     ${job.jobId}`);

  if (job.error) {
    console.log(`  Errore:    ${job.error.message || JSON.stringify(job.error)}`);
    if (job.error.step) console.log(`  Step:      ${job.error.step}`);
  }

  const shaping = job.research?.shaping;
  if (shaping?.diagnosi) {
    console.log('  Diagnosi:', shaping.diagnosi);
    console.log(`  search_required: ${shaping.search_required}`);
    if (shaping.plan?.length) {
      console.log('  Query plan:');
      for (const { pillar, query } of shaping.plan) {
        console.log(`    • [${pillar}] ${query}`);
      }
    }
  }

  const facts = job.research?.refiner?.compressedFacts;
  if (facts?.length) {
    console.log('  Refiner (anteprima):');
    for (const line of facts.slice(0, 3)) {
      console.log(`    ${line.slice(0, 120)}${line.length > 120 ? '…' : ''}`);
    }
  }
  console.log('');
}
