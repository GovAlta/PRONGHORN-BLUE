const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('deploy-containers rollback preview succeeds with snapshot', () => {
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    'infra/scripts/deploy-containers.ps1',
    '-Rollback',
    '-RollbackSnapshotPath', 'infra/scripts/tests/fixtures/deployment-snapshot.json',
    '-DryRun',
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Rollback mode/i);
});
