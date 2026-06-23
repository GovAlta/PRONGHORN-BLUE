const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('rollback prerequisites fail without snapshot', () => {
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    'infra/scripts/test-rollback-prerequisites.ps1',
    '-Operation', 'rollback-plan',
    '-RollbackScopes', 'application-runtime',
    '-SkipAzureLoginCheck',
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /snapshot/i);
});
