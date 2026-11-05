import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Server-side Google sign-in on: both halves of Metabase's Google client are set.
process.env.JWT_SECRET = 'test-secret-for-vitest';
process.env.GATEWAY_URL = 'https://mcp.example.com';
process.env.MCP_UPSTREAM = 'http://localhost:9999';
process.env.GOOGLE_CLIENT_ID = 'metabase-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';

// ── Fake Google and Metabase ─────────────────────────────────────────────────

const METABASE = 'https://metabase.example.com';
const CLIENT_REDIRECT = 'https://client.example.com/callback';

const fake = {
  googleRefreshFails: '' as '' | 'invalid_grant' | 'server_error',
  metabaseRejectsGoogle: false,
  logoutFails: false,
  deadSessions: new Set<string>(),
  sessionsIssued: 0,
  calls: [] as string[],
};

function idToken(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ sub, email: 'ana@clay.cl' })}.signature`;
}

const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(String(init?.body));
    fake.calls.push(`google:${params.get('grant_type')}`);
    if (params.get('client_secret') !== 'google-client-secret') return json(401, { error: 'invalid_client' });
    if (params.get('grant_type') === 'authorization_code') {
      return json(200, { id_token: idToken('google-user-1'), refresh_token: 'g-refresh-1' });
    }
    if (fake.googleRefreshFails === 'invalid_grant') return json(400, { error: 'invalid_grant' });
    if (fake.googleRefreshFails === 'server_error') return json(503, { error: 'server_error' });
    return json(200, { id_token: idToken('google-user-1') });
  }
  if (url === `${METABASE}/api/session/google_auth`) {
    fake.calls.push('metabase:google_auth');
    if (fake.metabaseRejectsGoogle) return json(401, { message: 'no user' });
    fake.sessionsIssued += 1;
    return json(200, { id: `session-${fake.sessionsIssued}` });
  }
  if (url === `${METABASE}/api/session` && init?.method === 'DELETE') {
    const session = (init?.headers as Record<string, string>)['X-Metabase-Session'];
    fake.calls.push(`metabase:logout:${session}`);
    if (fake.logoutFails) throw new Error('connection reset');
    fake.deadSessions.add(session);
    return new Response(null, { status: 204 });
  }
  if (url === `${METABASE}/api/user/current`) {
    fake.calls.push('metabase:user_current');
    const session = (init?.headers as Record<string, string>)['X-Metabase-Session'];
    return fake.deadSessions.has(session) ? json(401, {}) : json(200, { id: 1 });
  }
  throw new Error(`unexpected fetch ${url}`);
});
vi.stubGlobal('fetch', fetchMock);

const { app } = await import('../src/oauth-gateway.js');
const { CredentialSealer } = await import('../src/credentials.js');
const sealer = new CredentialSealer('test-secret-for-vitest');

function decode(token: string): Record<string, any> {
  const claims = jwt.verify(token, 'test-secret-for-vitest') as Record<string, any>;
  return claims.cred ? { ...claims, ...sealer.open(claims.cred) } : claims;
}

beforeEach(() => {
  fake.googleRefreshFails = '';
  fake.metabaseRejectsGoogle = false;
  fake.logoutFails = false;
  fake.deadSessions.clear();
  fake.calls = [];
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function startFlow() {
  const res = await request(app).get('/oauth/google/start').query({
    redirect_uri: CLIENT_REDIRECT,
    state: 'client-state',
    metabase_url: METABASE,
  });
  const google = new URL(res.headers['location'] as string);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return { res, google, state: google.searchParams.get('state') as string, cookie };
}

async function signIn() {
  const { state, cookie } = await startFlow();
  const cb = await request(app).get('/oauth/google/callback').query({ code: 'google-code', state }).set('Cookie', cookie);
  const back = new URL(cb.headers['location'] as string);
  const token = await request(app).post('/oauth/token').send({
    grant_type: 'authorization_code',
    code: back.searchParams.get('code'),
  });
  return token.body;
}

function refreshTokenFor(creds: Record<string, any>): string {
  return jwt.sign(
    { metabase_url: creds.metabase_url, cred: sealer.seal(creds as any), sub: 'test', typ: 'refresh' },
    'test-secret-for-vitest',
    { expiresIn: '30d' },
  );
}

const refresh = (refresh_token: string) =>
  request(app).post('/oauth/token').send({ grant_type: 'refresh_token', refresh_token });

const now = () => Math.floor(Date.now() / 1000);

// ── Sign-in ──────────────────────────────────────────────────────────────────

describe('server-side Google sign-in', () => {
  it('sends the authorize page through the gateway instead of Google’s in-page sign-in', async () => {
    const res = await request(app).get('/oauth/authorize?redirect_uri=https://client.example.com/cb');
    expect(res.text).toContain('var GOOGLE_SERVER_FLOW = true;');
  });

  it('asks Google for offline access with Metabase’s client', async () => {
    const { google } = await startFlow();
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('client_id')).toBe('metabase-client.apps.googleusercontent.com');
    expect(google.searchParams.get('access_type')).toBe('offline');
    expect(google.searchParams.get('prompt')).toBe('consent');
    expect(google.searchParams.get('redirect_uri')).toBe('https://mcp.example.com/oauth/google/callback');
  });

  it('binds the flow to the browser with an HttpOnly nonce cookie', async () => {
    const { res } = await startFlow();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('returns to the client with a code and its own state', async () => {
    const { state, cookie } = await startFlow();
    const cb = await request(app).get('/oauth/google/callback').query({ code: 'google-code', state }).set('Cookie', cookie);
    const back = new URL(cb.headers['location'] as string);
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('client-state');
  });

  it('issues a token holding the Metabase session and the Google refresh token', async () => {
    const body = await signIn();
    const creds = decode(body.access_token);
    expect(creds.metabase_session_token).toMatch(/^session-/);
    expect(creds.google_refresh_token).toBe('g-refresh-1');
    expect(creds.metabase_session_issued_at).toBeGreaterThan(now() - 60);
  });

  it('keeps every credential out of the readable JWT payload', async () => {
    const body = await signIn();
    const readable = JSON.stringify(jwt.decode(body.access_token)) + JSON.stringify(jwt.decode(body.refresh_token));
    expect(readable).not.toContain('g-refresh-1');
    expect(readable).not.toMatch(/session-\d/);
  });

  it('refuses a callback from a browser that did not start the flow', async () => {
    const { state } = await startFlow();
    const cb = await request(app).get('/oauth/google/callback').query({ code: 'google-code', state });
    expect(cb.status).toBe(400);
    expect(fake.calls).not.toContain('google:authorization_code');
  });

  it('refuses a forged state', async () => {
    const { cookie } = await startFlow();
    const cb = await request(app).get('/oauth/google/callback').query({ code: 'c', state: 'forged' }).set('Cookie', cookie);
    expect(cb.status).toBe(400);
  });

  it('tells the client when the user cancels at Google', async () => {
    const { state, cookie } = await startFlow();
    const cb = await request(app).get('/oauth/google/callback').query({ error: 'access_denied', state }).set('Cookie', cookie);
    const back = new URL(cb.headers['location'] as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('client-state');
  });

  it('explains when Metabase does not accept the Google account', async () => {
    fake.metabaseRejectsGoogle = true;
    const { state, cookie } = await startFlow();
    const cb = await request(app).get('/oauth/google/callback').query({ code: 'google-code', state }).set('Cookie', cookie);
    expect(cb.status).toBe(403);
    expect(cb.text).toContain('Metabase no aceptó esta cuenta de Google');
  });
});

// ── Session renewal on refresh ───────────────────────────────────────────────

describe('Metabase session renewal on refresh', () => {
  const googleCreds = (extra: Record<string, any> = {}) => ({
    metabase_url: METABASE,
    metabase_session_token: 'session-old',
    metabase_session_issued_at: now() - 3600,
    google_refresh_token: 'g-refresh-1',
    google_subject: 'google-user-1',
    ...extra,
  });

  it('keeps a young session that Metabase still honours', async () => {
    const res = await refresh(refreshTokenFor(googleCreds()));
    expect(res.status).toBe(200);
    expect(decode(res.body.access_token).metabase_session_token).toBe('session-old');
    expect(fake.calls).toEqual(['metabase:user_current']);
  });

  it('renews a session Metabase already rejects', async () => {
    fake.deadSessions.add('session-old');
    const res = await refresh(refreshTokenFor(googleCreds()));
    expect(res.status).toBe(200);
    const creds = decode(res.body.access_token);
    expect(creds.metabase_session_token).not.toBe('session-old');
    expect(creds.metabase_session_issued_at).toBeGreaterThan(now() - 60);
    expect(res.body.expires_in).toBe(8 * 3600);
  });

  it('renews a session once it is a day old, without waiting for it to fail', async () => {
    const res = await refresh(refreshTokenFor(googleCreds({ metabase_session_issued_at: now() - 86400 })));
    expect(decode(res.body.access_token).metabase_session_token).not.toBe('session-old');
    expect(fake.calls).not.toContain('metabase:user_current');
  });

  it('ends the replaced session, so renewing narrows exposure instead of adding sessions', async () => {
    await refresh(refreshTokenFor(googleCreds({ metabase_session_issued_at: now() - 86400 })));
    expect(fake.calls).toContain('metabase:logout:session-old');
    expect(fake.deadSessions.has('session-old')).toBe(true);
  });

  it('still hands out the new session when the old one could not be ended', async () => {
    fake.logoutFails = true;
    const res = await refresh(refreshTokenFor(googleCreds({ metabase_session_issued_at: now() - 86400 })));
    expect(res.status).toBe(200);
    expect(decode(res.body.access_token).metabase_session_token).not.toBe('session-old');
  });

  it('does not end the current session when renewal failed', async () => {
    fake.googleRefreshFails = 'server_error';
    await refresh(refreshTokenFor(googleCreds({ metabase_session_issued_at: now() - 86400 })));
    expect(fake.calls).not.toContain('metabase:logout:session-old');
  });

  it('keeps the same log subject when the session changes', async () => {
    const first = await signIn();
    fake.deadSessions.add(decode(first.access_token).metabase_session_token);
    const res = await refresh(first.refresh_token);
    expect(decode(res.body.access_token).sub).toBe(decode(first.access_token).sub);
  });

  it('asks the user to sign in again when Google revoked the grant', async () => {
    fake.deadSessions.add('session-old');
    fake.googleRefreshFails = 'invalid_grant';
    const res = await refresh(refreshTokenFor(googleCreds()));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('retries soon, instead of disconnecting, when Google is unreachable', async () => {
    fake.deadSessions.add('session-old');
    fake.googleRefreshFails = 'server_error';
    const res = await refresh(refreshTokenFor(googleCreds()));
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(300);
  });

  it('keeps an old-but-valid session at full lifetime when renewal fails transiently', async () => {
    fake.googleRefreshFails = 'server_error';
    const res = await refresh(refreshTokenFor(googleCreds({ metabase_session_issued_at: now() - 13 * 86400 })));
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(8 * 3600);
    expect(decode(res.body.access_token).metabase_session_token).toBe('session-old');
  });

  it('fails the refresh of a dead session that has no way to renew', async () => {
    fake.deadSessions.add('session-manual');
    const res = await refresh(refreshTokenFor({ metabase_url: METABASE, metabase_session_token: 'session-manual' }));
    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe('Metabase session expired; sign in again');
  });

  it('leaves API-key connections alone', async () => {
    const res = await refresh(refreshTokenFor({ metabase_url: METABASE, metabase_api_key: 'mb_key' }));
    expect(res.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });

  it('still refreshes a token issued before credentials were sealed', async () => {
    const legacy = jwt.sign(
      { metabase_url: METABASE, metabase_api_key: 'mb_legacy', typ: 'refresh' },
      'test-secret-for-vitest',
      { expiresIn: '30d' },
    );
    const res = await refresh(legacy);
    expect(res.status).toBe(200);
    expect(decode(res.body.access_token).metabase_api_key).toBe('mb_legacy');
  });
});

describe('sealed credentials', () => {
  it('rejects a token whose sealed credentials were tampered with', async () => {
    const token = jwt.sign(
      { metabase_url: METABASE, cred: 'v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', typ: 'access', aud: 'https://mcp.example.com/mcp' },
      'test-secret-for-vitest',
      { expiresIn: '8h' },
    );
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
  });

  it('cannot be opened with another secret', () => {
    const sealed = sealer.seal({ metabase_url: METABASE, metabase_api_key: 'mb_x' });
    expect(() => new CredentialSealer('other-secret').open(sealed)).toThrow();
  });
});
