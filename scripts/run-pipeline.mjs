/**
 * Esegue un job shaping (F1→F3) con modalità e topic a scelta.
 *
 * Uso:
 *   node scripts/run-pipeline.mjs --mock --topic="Trend moda 2026"
 *   node scripts/run-pipeline.mjs --live --topic="Situazione Iraq 2026"
 *   node scripts/run-pipeline.mjs --mock --simulate --phase=F2 --topic="Test errore"
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
  printJobSummary,
} from './lib/testRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(ROOT, '.env') });

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const TEST_USER_ID = process.env.TEST_USER_ID || 'test-automation-user';
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID || 'test-automation-company';

const cli = parseCliArgs();
const { startWorker, stopWorker } = createWorkerManager({ verbose: cli.verbose });

async function main() {
  if (cli.help) {
    printCliHelp('run-pipeline.mjs');
    process.exit(0);
  }

  if (!cli.topic) {
    console.error('\n❌ Specifica un argomento con --topic="..."\n');
    printCliHelp('run-pipeline.mjs');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log('  PRISM — Run pipeline (shaping F1→F3)');
  console.log(`  Modalità: ${cli.modeLabel}`);
  console.log(`  Topic:    ${cli.topic}`);
  console.log(`  API:      ${API_BASE}`);
  if (cli.simulatePhase) {
    console.log(`  Fault:    SIMULATE_FAULT=${cli.simulatePhase} (${cli.simulateMode})`);
    console.log(`  Atteso:   status ${cli.expectStatus}`);
  }
  console.log('═══════════════════════════════════════════');

  try {
    const health = await request(API_BASE, 'GET', '/health');
    if (health.status !== 200) {
      console.error('\n❌ API non raggiungibile. Avvia prima: npm run start:api\n');
      process.exit(1);
    }

    if (cli.live) assertLiveKeys();

    log.info('Avvio worker temporaneo (chiudi il worker manuale se già in esecuzione)');
    await startWorker(workerEnvFromCli(cli));

    log.info(`Accodamento job shaping_only…`);
    const jobId = await enqueueShaping(API_BASE, {
      userId: TEST_USER_ID,
      companyId: TEST_COMPANY_ID,
      topic: cli.topic,
    });
    log.info(`JobId: ${jobId}`);

    let lastTick = '';
    const result = await pollJobStatus(API_BASE, TEST_USER_ID, jobId, {
      expectStatus: cli.expectStatus,
      timeoutMs: cli.timeoutMs,
      onTick: (snap) => {
        if (snap !== lastTick) {
          log.info(`Polling… ${snap}`);
          lastTick = snap;
        }
      },
    });

    printJobSummary(result, { topic: cli.topic, mock: cli.mock });

    if (cli.simulatePhase) {
      const step = expectedFaultStep(cli.simulatePhase);
      if (result.error?.step !== step) {
        console.error(`❌ Step errore atteso "${step}", ricevuto "${result.error?.step}"`);
        process.exit(1);
      }
    }

    if (result.status === cli.expectStatus) {
      log.ok(`Job terminato con status "${result.status}"`);
      process.exit(0);
    }

    log.fail(`Status "${result.status}" diverso da atteso "${cli.expectStatus}"`);
    process.exit(1);
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  } finally {
    await stopWorker();
  }
}

main();
