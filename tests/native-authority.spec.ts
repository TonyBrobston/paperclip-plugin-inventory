import { beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@paperclipai/plugin-sdk/testing';
import plugin from '../src/worker.js';
import manifest from '../src/manifest.js';
import { actionActor, toolActor } from '../src/native.js';

const companyId = 'company-authorized';
describe('native host authority', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
  });
  it('rejects browser identity spoofing when host context is absent', async () => {
    await expect(harness.performAction('inventory_action', {
      operation: 'save_settings', companyId, actor: {type:'user', userId:'forged'}, userId:'forged',
    })).rejects.toThrow(/authenticated|company/i);
    expect(harness.logs.some(log => /migration|database/.test(log.message))).toBe(false);
  });
  it('requires a real human id for a host user principal', async () => {
    await expect(harness.performAction('inventory_action', { operation: 'approve_count', userId: 'forged' }, {
      companyId, actor: {type:'user', companyId, userId:null},
    })).rejects.toThrow(/human identity/i);
  });
  it('rejects a missing company even with a real host user id', () => {
    expect(() => actionActor({companyId:null, actor:{type:'user',companyId:null,userId:'human',agentId:null,runId:null}})).toThrow(/company/i);
  });
  it('rejects inconsistent host company context', () => {
    expect(() => actionActor({companyId:'other',actor:{type:'user',companyId,userId:'human',agentId:null,runId:null}})).toThrow(/company/i);
  });
  it('takes authority solely from host actor', () => {
    expect(actionActor({companyId,actor:{type:'user',companyId,userId:'real-human',agentId:null,runId:null}})).toEqual({type:'user',id:'real-human',companyId});
  });
  it('refuses system actions and tools without host agent identity', () => {
    expect(() => actionActor({companyId,actor:{type:'system',companyId,userId:'forged',agentId:null,runId:null}})).toThrow(/authenticated/i);
    expect(() => toolActor({companyId} as never)).toThrow(/agent identity/i);
  });
  it('requires host company scope before a data query', async () => {
    await expect(harness.getData('inventory_page', {page:'inventory'})).rejects.toThrow(/company/i);
  });
});
