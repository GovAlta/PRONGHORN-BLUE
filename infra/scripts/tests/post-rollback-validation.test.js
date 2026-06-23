const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('post rollback validation emits scope validation summary', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'post-rollback-'));
  const recordPath = join(workDir, 'record.json');
  const outputPath = join(workDir, 'summary.json');

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
    'infra/scripts/test-post-rollback-state.ps1',
    '-SnapshotPath', 'infra/scripts/tests/fixtures/deployment-snapshot.json',
    '-ExecutionRecordPath', recordPath,
    '-OutputPath', outputPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(output.validations[0].scope, 'application-runtime');
});
