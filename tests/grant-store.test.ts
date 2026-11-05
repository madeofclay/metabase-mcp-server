import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CredentialSealer } from '../src/credentials.js';
import { GrantStore } from '../src/grant-store.js';

const SECRET = 'test-secret-for-vitest';
const creds = { metabase_url: 'https://metabase.example.com', metabase_api_key: 'mb_store_key' };

let dir: string;
let file: string;
const open = () => new GrantStore(file, SECRET, new CredentialSealer(SECRET));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-'));
  file = path.join(dir, 'nested', 'grants.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('GrantStore', () => {
  it('survives a restart, so a deploy does not disconnect anyone', () => {
    const g = open().create(creds, 'sub1', 3600, 'jti-1');
    const reloaded = open();
    const again = reloaded.get(g.id)!;
    expect(reloaded.credentials(again).metabase_api_key).toBe('mb_store_key');
    expect(reloaded.checkRefresh(again, 'jti-1', 30)).toBe('current');
  });

  it('writes no credential and no refresh token in the clear', () => {
    open().create(creds, 'sub1', 3600, 'jti-plain');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('mb_store_key');
    expect(raw).not.toContain('jti-plain');
  });

  it.skipIf(process.platform === 'win32')('keeps the file readable by its owner only', () => {
    open().create(creds, 'sub1', 3600, 'jti-1');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects credentials moved from one grant to another in the file', () => {
    const store = open();
    const a = store.create(creds, 'a', 3600, 'jti-a');
    const b = store.create({ ...creds, metabase_api_key: 'mb_other' }, 'b', 3600, 'jti-b');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    rows.find((r: any) => r.id === b.id).cred = rows.find((r: any) => r.id === a.id).cred;
    fs.writeFileSync(file, JSON.stringify(rows));
    const tampered = open();
    expect(() => tampered.credentials(tampered.get(b.id)!)).toThrow();
  });

  it('drops grants past their absolute end', () => {
    const store = open();
    const g = store.create(creds, 'sub1', -1, 'jti-1');
    expect(store.get(g.id)).toBeUndefined();
    expect(store.purge()).toBe(1);
    expect(open().size).toBe(0);
  });

  it('forgets the credentials of a revoked grant but remembers the revocation', () => {
    const store = open();
    const g = store.create(creds, 'sub1', 3600, 'jti-1');
    expect(store.revoke(g, 'test')?.metabase_api_key).toBe('mb_store_key');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(g.cred || 'never');
    const reloaded = open().get(g.id)!;
    expect(reloaded.revoked_reason).toBe('test');
    expect(reloaded.cred).toBe('');
  });

  it('fails closed on an unreadable file and keeps it aside', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const store = open();
    expect(store.size).toBe(0);
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.includes('.corrupt-'))).toBe(true);
  });
});
