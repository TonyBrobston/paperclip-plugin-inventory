import { afterEach, expect, it } from 'vitest';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.js';
import { openStore } from '../src/storage.js';
import { dropSchema, freshSchema, integration, type TestSchema } from './support/database.js';

integration('schema company isolation', () => {
  let target: TestSchema;
  afterEach(async () => { await dropSchema(target); target = undefined as unknown as TestSchema; });
  it('rejects copied database configuration for another host company', async () => {
    target = await freshSchema();
    const harness = createTestHarness({manifest,config:{databaseUrl:{type:'secret_ref',secretId:'synthetic'},databaseSchema:target.schema}});
    harness.ctx.secrets.resolve = async () => process.env.INVENTORY_TEST_DATABASE_URL!;
    await openStore(harness.ctx, 'company-a');
    await expect(openStore(harness.ctx, 'company-b')).rejects.toThrow(/another company/);
    expect(await target.db.query('SELECT company_id FROM company_scope')).toEqual([{company_id:'company-a'}]);
  });
  it('refuses absent host company before resolving configuration or credentials', async () => {
    const harness = createTestHarness({manifest});
    await expect(openStore(harness.ctx, '')).rejects.toThrow(/company/);
  });
});
