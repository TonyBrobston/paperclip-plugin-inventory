import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@paperclipai/plugin-sdk';
import { googleSheetsClient } from '../src/sheets-client.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { type: 'service_account', client_email: 'robot@example.invalid', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://example.invalid/must-never-receive-key' };
const settings = { spreadsheetId: 'synthetic-spreadsheet', serviceAccount: { type: 'secret_ref' as const, secretId: 'synthetic-key' } };
function ctx(value: unknown = key) { return { secrets: { resolve: vi.fn(async () => JSON.stringify(value)) } } as unknown as PluginContext; }
afterEach(() => vi.unstubAllGlobals());
describe('service-account HTTP boundary', () => {
  it('signs a verifiable assertion for the fixed Google endpoint and uses only a bearer token for Sheet requests', async () => {
    const calls: { url: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      calls.push({ url, options });
      return Response.json(url.endsWith('/token') ? { access_token: 'synthetic-token' } : url.endsWith(':batchUpdate') ? {} : { sheets: [] });
    });
    const context = ctx();
    const client = await googleSheetsClient(context, 'company-1', settings);
    await client.read(); await client.batch([{ syntheticRequest: {} }]);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const assertion = (calls[0].options!.body as URLSearchParams).get('assertion')!;
    const [header, payload, signature] = assertion.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/spreadsheets' });
    expect(calls[1].url).toBe('https://sheets.googleapis.com/v4/spreadsheets/synthetic-spreadsheet?includeGridData=true');
    expect(calls[2].options?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
    expect(calls.slice(1).map(c => JSON.stringify(c)).join('')).not.toContain('PRIVATE KEY');
    expect(context.secrets.resolve).toHaveBeenCalledWith(settings.serviceAccount, { companyId: 'company-1', configPath: 'googleServiceAccount' });
  });
  it('does not disclose Google error bodies or credential material', async () => {
    vi.stubGlobal('fetch', async () => new Response('synthetic-sensitive-provider-detail', { status: 403 }));
    await expect(googleSheetsClient(ctx(), 'company-1', settings)).rejects.toThrow('Google rejected the service-account credentials.');
    vi.stubGlobal('fetch', async (url: string) => url.endsWith('/token') ? Response.json({ access_token: 'synthetic-token' }) : new Response('synthetic-sensitive-sheet-detail', { status: 403 }));
    const client = await googleSheetsClient(ctx(), 'company-1', settings);
    await expect(client.read()).rejects.toThrow(/HTTP 403/);
  });
  it('rejects malformed or non-service-account credentials before network access', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(googleSheetsClient(ctx({ type: 'authorized_user' }), 'company-1', settings)).rejects.toThrow(/missing/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
