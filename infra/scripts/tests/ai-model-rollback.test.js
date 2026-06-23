const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('deploy-models rollback preview succeeds with snapshot', () => {
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    'infra/scripts/deploy-models.ps1',
    '-ResourceGroup', 'fixture-rg',
    '-AccountName', 'fixture-account',
    '-Rollback',
    '-RollbackSnapshotPath', 'infra/scripts/tests/fixtures/deployment-snapshot.json',
    '-DryRun',
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /rollback mode/i);
});
