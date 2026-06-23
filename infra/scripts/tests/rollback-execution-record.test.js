const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('validate-rollback-record accepts a valid execution record', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'rollback-record-'));
  const recordPath = join(workDir, 'record.json');
  writeFileSync(recordPath, JSON.stringify({
    executionId: 'exec-1',
    planId: 'plan-1',
    environment: 'dev',
    selectedScopes: ['application-runtime'],
    overallStatus: 'completed',
    startedAt: '2026-03-27T00:00:00Z',
    steps: [{ stepId: 'step-1', scope: 'application-runtime', actionType: 'rollback-runtime', status: 'completed', message: 'ok' }]
  }, null, 2));

  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    'infra/scripts/validate-rollback-record.ps1',
    '-RecordPath', recordPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
