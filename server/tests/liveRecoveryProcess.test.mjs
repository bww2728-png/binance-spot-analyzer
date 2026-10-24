import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./liveRecoveryProcessChild.mjs', import.meta.url));
const defaultSourceRoot = fileURLToPath(new URL('..', import.meta.url));

function runChild(mode, databasePath, sourceRoot, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [fixture, mode, databasePath, sourceRoot], {
    encoding: 'utf8',
    timeout: 15_000
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('قاعدة SQLite الدائمة تستعيد الحالة بعد انتهاء مفاجئ لعملية الخدمة', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-recovery-process-'));
  const databasePath = path.join(directory, 'events.sqlite');
  const sourceRoot = process.env.RECOVERY_SOURCE_ROOT || defaultSourceRoot;
  try {
    runChild('crash-after-commit', databasePath, sourceRoot, 73);
    const recovered = JSON.parse(runChild('recover', databasePath, sourceRoot));
    const persisted = JSON.parse(runChild('inspect', databasePath, sourceRoot));

    assert.equal(recovered.recovery, 'ready');
    assert.deepEqual(recovered.activeIds, ['BTCUSDT|5m|active-zone|1700000000']);
    assert.deepEqual(recovered.closedIds, ['ETHUSDT|5m|closed-zone|1700000000']);
    assert.equal(recovered.trackerPhase, 'published');
    assert.equal(recovered.trackerPublishedKey, 'BTCUSDT|5m|active-zone|1700000000');
    assert.equal(recovered.listenerCount, 1);
    assert.deepEqual(persisted, { lifecycle: 2, published: 2, closed: 1, total: 5 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
