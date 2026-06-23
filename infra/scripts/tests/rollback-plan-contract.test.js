const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('new-rollback-plan produces resolved scopes and ordered steps', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'rollback-plan-'));
  const preflightPath = join(workDir, 'preflight.json');
  const planPath = join(workDir, 'plan.json');
  const snapshotPath = join(process.cwd(), 'infra/scripts/tests/fixtures/deployment-snapshot.json');

  writeFileSync(preflightPath, JSON.stringify({ checks: [], blockedCount: 0 }, null, 2));

  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    'infra/scripts/new-rollback-plan.ps1',
    '-SnapshotPath', snapshotPath,
    '-RollbackScopes', 'application-runtime,ai-models',
    '-PreflightResultPath', preflightPath,
    '-OutputPath', planPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.deepEqual(plan.resolvedScopes, ['application-runtime', 'ai-models']);
  assert.equal(plan.orderedSteps.length, 2);
});
