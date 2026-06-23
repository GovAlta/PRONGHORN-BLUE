const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('stateful rollback requires destructive acknowledgement', () => {
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    'infra/scripts/test-rollback-prerequisites.ps1',
    '-Operation', 'rollback-execute',
    '-RollbackSnapshot', 'infra/scripts/tests/fixtures/deployment-snapshot.json',
    '-RollbackScopes', 'database',
    '-SkipAzureLoginCheck',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      AZURE_CLIENT_ID: 'fixture-client',
      AZURE_TENANT_ID: 'fixture-tenant',
      AZURE_SUBSCRIPTION_ID: 'fixture-subscription',
      TFSTATE_KEY: 'fixture-key',
      TFSTATE_RESOURCE_GROUP: 'fixture-rg',
      TFSTATE_STORAGE_ACCOUNT: 'fixturestorage',
      TFSTATE_CONTAINER: 'fixture-container',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /destructive/i);
});
