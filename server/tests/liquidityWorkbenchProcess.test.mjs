import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./liquidityWorkbenchProcessChild.mjs', import.meta.url));

function runChild(mode, databasePath, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [fixture, mode, databasePath], {
    encoding: 'utf8',
    timeout: 20_000
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('منظومة السيولة تستعيد الشموع والمسوح والأحداث عبر عملية جديدة وقاعدة SQLite ملفية', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'liquidity-workbench-process-'));
  const databasePath = path.join(directory, 'workbench.sqlite');
  try {
    const interrupted = JSON.parse(runChild('seed-crash', databasePath, 73));
    const recovered = JSON.parse(runChild('recover', databasePath));
    const recoveredAgain = JSON.parse(runChild('recover', databasePath));

    assert.equal(interrupted.recovery, 'ready');
    assert.equal(interrupted.seeded, 2);
    assert.equal(recovered.recovery, 'ready');
    assert.equal(recovered.seeded, 2);
    assert.equal(recovered.candleCount, 500);
    assert.equal(recovered.scanRows, 2);
    assert.equal(recovered.candleRows, 1000);
    assert.equal(recovered.restoredEventKeys.includes('process-recovery-fixture-event'), true);
    assert.equal(recoveredAgain.eventRows, recovered.eventRows);
    assert.deepEqual(recoveredAgain.restoredEventKeys, recovered.restoredEventKeys);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
