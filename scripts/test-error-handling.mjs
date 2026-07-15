/**
 * Test automatici gestione errori PRISM.
 *
 * Uso:
 *   npm run test:errors
 *   npm run test:errors:integration
 *   npm run test:errors:simulate
 *
 * Opzioni CLI (PowerShell):
 *   --mock | --live          default: --mock
 *   --topic="argomento"      topic per integration/simulate
 *   --phase=F2 --fault-mode=fatal
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ROOT,
  log,
  parseCliArgs,
  printCliHelp,
  request,
  pollJobStatus,
  enqueueShaping,
  createWorkerManager,
  workerEnvFromCli,
  assertLiveKeys,
  expectedFaultStep,
} from './lib/testRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(ROOT, '.env') });

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const TEST_USER_ID = process.env.TEST_USER_ID || 'test-automation-user';
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID || 'test-automation-company';
const FAKE_JOB_ID = '00000000-0000-0000-0000-000000000000';

const cli = parseCliArgs();
const DEFAULT_MOCK_TOPIC = 'Test automazione PRISM mock 2026';
const DEFAULT_SIM_TOPIC = 'Test automazione errore simulato Iraq geopolitica 2026';

let passed = 0;
let failed = 0;
const { startWorker, stopWorker } = createWorkerManager({ verbose: cli.verbose });

async function runTest({ id, name, purpose, fn }) {
  console.log(`\n  📋 ${id} — ${name}`);
  log.scopo(purpose);
  try {
    await fn();
    passed += 1;
    log.ok(`${id} — ${name}`);
  } catch (err) {
    failed += 1;
    log.fail(`${id} — ${name} — ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runApiTests() {
  log.section('Gruppo A — Test API (senza worker)');

  await runTest({
    id: 'TC-13',
    name: 'GET /health → 200',
    purpose: 'Controllare che l\'API sia accesa e risponda (load balancer / avvio locale).',
    fn: async () => {
      const { status, data } = await request(API_BASE, 'GET', '/health');
      assert(status === 200, `HTTP ${status}`);
      assert(data?.status === 'ok', JSON.stringify(data));
    },
  });

  await runTest({
    id: 'TC-09',
    name: 'GET /ready → 200 o 503',
    purpose: 'Controllare se Redis è raggiungibile prima di accodare job veri.',
    fn: async () => {
      const { status, data } = await request(API_BASE, 'GET', '/ready');
      assert(status === 200 || status === 503, `HTTP ${status}`);
      if (status === 503) {
        log.info('Redis non ready — ok per questo test, ma sistemare prima dei job');
      } else {
        assert(data?.status === 'ready', JSON.stringify(data));
      }
    },
  });

  await runTest({
    id: 'TC-03',
    name: 'GET /jobs/status job inesistente → 404',
    purpose: 'Verificare che un jobId inventato restituisca errore pulito, non dati casuali.',
    fn: async () => {
      const { status, data } = await request(API_BASE, 'GET', `/jobs/status/${TEST_USER_ID}/${FAKE_JOB_ID}`);
      assert(status === 404, `HTTP ${status}`);
      assert(data?.success === false && data?.error === 'JOB_NOT_FOUND', JSON.stringify(data));
    },
  });

  await runTest({
    id: 'A4',
    name: 'POST /api/prepare-shaping senza topic → 400',
    purpose: 'Verificare che l\'API rifiuti richieste incomplete (validazione input).',
    fn: async () => {
      const { status } = await request(API_BASE, 'POST', '/api/prepare-shaping', {
        userId: TEST_USER_ID,
        companyId: TEST_COMPANY_ID,
      });
      assert(status === 400, `HTTP ${status}`);
    },
  });
}

async function runIntegrationTests() {
  const topic = cli.topic || DEFAULT_MOCK_TOPIC;
  log.section(`Gruppo B — Integrazione (${cli.modeLabel})`);
  log.info(`Topic: "${topic}"`);

  if (cli.live) assertLiveKeys();

  log.info(`Avvio worker USE_MOCK_GENERATOR=${cli.mock ? 'true' : 'false'} (chiudi worker manuale se aperto)`);
  await startWorker(workerEnvFromCli({ mock: cli.mock }));

  await runTest({
    id: 'TC-12',
    name: `shaping_only → completed (${cli.mock ? 'mock' : 'live'})`,
    purpose: cli.mock
      ? 'Verificare F1→F3 senza Gemini/Tavily: job creato, processato, salvato su Firestore.'
      : 'Verificare F1→F3 con Gemini e Tavily reali sul topic scelto.',
    fn: async () => {
      const jobId = await enqueueShaping(API_BASE, {
        userId: TEST_USER_ID,
        companyId: TEST_COMPANY_ID,
        topic,
      });
      log.info(`Job accodato: ${jobId}`);
      const result = await pollJobStatus(API_BASE, TEST_USER_ID, jobId, {
        expectStatus: 'completed',
        timeoutMs: cli.timeoutMs,
      });
      assert(result.status === 'completed', JSON.stringify(result));
    },
  });
}

async function runSimulateTests() {
  const topic = cli.topic || DEFAULT_SIM_TOPIC;
  const phase = cli.simulatePhase || 'F2';
  const expectedStep = expectedFaultStep(phase);

  log.section(`Gruppo C — Simulazione errore ${phase} (${cli.simulateMode}) — ${cli.modeLabel}`);
  log.info(`Topic: "${topic}"`);

  log.info(`Avvio worker SIMULATE_FAULT=${phase}, MODE=${cli.simulateMode}`);
  await startWorker(workerEnvFromCli({
    mock: cli.mock,
    simulatePhase: phase,
    simulateMode: cli.simulateMode,
  }));

  await runTest({
    id: 'TC-06',
    name: `SIMULATE ${phase} → failed step ${expectedStep}`,
    purpose: 'Verificare che un errore simulato porti il job a failed con step corretto (consigliato --mock per non consumare API).',
    fn: async () => {
      const jobId = await enqueueShaping(API_BASE, {
        userId: TEST_USER_ID,
        companyId: TEST_COMPANY_ID,
        topic,
      });
      log.info(`Job accodato: ${jobId}`);
      const result = await pollJobStatus(API_BASE, TEST_USER_ID, jobId, {
        expectStatus: 'failed',
        timeoutMs: cli.timeoutMs,
      });
      assert(result.status === 'failed', JSON.stringify(result));
      assert(result.error?.step === expectedStep, `step atteso ${expectedStep}, got ${result.error?.step}`);
      log.info(`Messaggio errore: ${result.error?.message}`);
    },
  });
}

async function main() {
  if (cli.help) {
    printCliHelp('test-error-handling.mjs');
    process.exit(0);
  }

  console.log('═══════════════════════════════════════════');
  console.log('  PRISM — Test automatici gestione errori');
  console.log(`  API: ${API_BASE}`);
  console.log(`  userId test: ${TEST_USER_ID}`);
  if (cli.integration || cli.simulate) {
    console.log(`  Modalità pipeline: ${cli.modeLabel}`);
  }
  console.log('═══════════════════════════════════════════');

  try {
    const health = await request(API_BASE, 'GET', '/health');
    if (health.status !== 200) {
      console.error('\n❌ API non raggiungibile. Avvia prima: npm run start:api\n');
      process.exit(1);
    }

    await runApiTests();

    if (cli.integration) {
      await runIntegrationTests();
    }

    if (cli.simulate) {
      await runSimulateTests();
    }

    if (!cli.integration && !cli.simulate) {
      log.info('Suggerimento: npm run test:pipeline -- --mock --topic="Il tuo argomento"');
      log.info('Suggerimento: npm run test:errors:integration  (job mock, topic default)');
      log.info('Suggerimento: npm run test:errors:simulate -- --mock  (errore F2 senza API reali)');
    }
  } finally {
    await stopWorker();
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Errore fatale test runner:', err);
  process.exit(1);
});
