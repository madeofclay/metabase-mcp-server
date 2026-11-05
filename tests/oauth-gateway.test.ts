import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Set env vars before importing the app
process.env.JWT_SECRET = 'test-secret-for-vitest';
process.env.GATEWAY_URL = 'https://mcp.example.com';
process.env.MCP_UPSTREAM = 'http://localhost:9999'; // unused in unit tests
process.env.GRANT_STORE_PATH = ':memory:';
process.env.ALLOWED_REDIRECT_HOSTS = 'client.example.com';

const { app, grants } = await import('../src/oauth-gateway.js');

const ISSUER = 'https://mcp.example.com';
const RESOURCE = 'https://mcp.example.com/mcp';

// PKCE is mandatory: every authorization uses this pair unless a test says otherwise.
// echo -n 'test-verifier-string' | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
const VERIFIER  = 'test-verifier-string';
const CHALLENGE = 'LHKy4-q59ocwlltGr-0vD9UbiHBsIU09drZuupn1ghs';
const PKCE = { code_challenge: CHALLENGE, code_challenge_method: 'S256' };

// Verifies a token and returns its claims with its grant's credentials, so
// assertions can look at both the way the gateway does.
function decode(token: string): Record<string, any> {
  const claims = jwt.verify(token, 'test-secret-for-vitest', { issuer: ISSUER }) as Record<string, any>;
  const grant = grants.get(claims.gid);
  return grant && !grant.revoked_at ? { ...claims, ...grants.credentials(grant) } : claims;
}

const exchange = (code: string, extra: Record<string, string> = {}) =>
  request(app).post('/oauth/token').send({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, ...extra });

// ── helpers ──────────────────────────────────────────────────────────────────

async function getAuthCode(opts: {
  apiKey?: string;
  username?: string;
  password?: string;
  codeChallenge?: string;
  state?: string;
} = { apiKey: 'mb_test_key' }) {
  const body: Record<string, string> = {
    redirect_uri: 'https://client.example.com/callback',
    metabase_url: 'https://metabase.example.com',
  };
  if (opts.apiKey)       body.metabase_api_key = opts.apiKey;
  if (opts.username)     body.metabase_username = opts.username;
  if (opts.password)     body.metabase_password = opts.password;
  body.code_challenge = opts.codeChallenge || CHALLENGE;
  body.code_challenge_method = 'S256';
  if (opts.state) body.state = opts.state;

  const res = await request(app).post('/oauth/authorize').send(body);
  const location = res.headers['location'] as string;
  const url = new URL(location);
  return url.searchParams.get('code') as string;
}

// ── Discovery ────────────────────────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns required OAuth metadata fields', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://mcp.example.com');
    expect(res.body.authorization_endpoint).toContain('/oauth/authorize');
    expect(res.body.token_endpoint).toContain('/oauth/token');
    expect(res.body.registration_endpoint).toContain('/oauth/register');
    expect(res.body.code_challenge_methods_supported).toContain('S256');
  });
});

describe('GET /.well-known/openid-configuration', () => {
  it('returns OpenID configuration', async () => {
    const res = await request(app).get('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    expect(res.body.authorization_endpoint).toContain('/oauth/authorize');
  });
});

// ── Client registration ───────────────────────────────────────────────────────

describe('POST /oauth/register', () => {
  it('registers a client and returns client_id', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: ['https://client.example.com/cb'], client_name: 'TestApp' });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
    expect(res.body.redirect_uris).toEqual(['https://client.example.com/cb']);
    expect(res.body.grant_types).toContain('authorization_code');
  });

  it('rejects missing redirect_uris', async () => {
    const res = await request(app).post('/oauth/register').send({ client_name: 'NoUris' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('rejects empty redirect_uris array', async () => {
    const res = await request(app).post('/oauth/register').send({ redirect_uris: [] });
    expect(res.status).toBe(400);
  });
});

// ── Authorization endpoint ────────────────────────────────────────────────────

describe('GET /oauth/authorize', () => {
  it('returns HTML login form when redirect_uri is provided', async () => {
    const res = await request(app)
      .get('/oauth/authorize')
      .query({ redirect_uri: 'https://client.example.com/callback', ...PKCE });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<form');
  });

  it('returns 400 when redirect_uri is missing', async () => {
    const res = await request(app).get('/oauth/authorize');
    expect(res.status).toBe(400);
  });

  it('escapes HTML in redirect_uri to prevent XSS', async () => {
    const res = await request(app)
      .get('/oauth/authorize')
      .query({ redirect_uri: 'https://client.example.com/cb?a=<script>alert(1)</script>', ...PKCE });
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });
});

describe('POST /oauth/authorize', () => {
  it('redirects with code when api_key is provided', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'mb_test_key',
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers['location']);
    expect(url.searchParams.get('code')).toBeTruthy();
  });

  it('redirects with code when username+password is provided', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_username: 'admin@example.com',
      metabase_password: 'secret',
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers['location']);
    expect(url.searchParams.get('code')).toBeTruthy();
  });

  it('includes state in redirect when provided', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'mb_test',
      state: 'xyz123',
    });
    const url = new URL(res.headers['location']);
    expect(url.searchParams.get('state')).toBe('xyz123');
  });

  it('returns 400 when redirect_uri is missing', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'mb_test',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when metabase_url is missing', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_api_key: 'mb_test',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no credentials are provided', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when only username is provided without password', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_username: 'admin@example.com',
    });
    expect(res.status).toBe(400);
  });
});

// ── Token endpoint ────────────────────────────────────────────────────────────

describe('POST /oauth/token', () => {
  it('issues a JWT for a valid code (api_key flow)', async () => {
    const code = await getAuthCode({ apiKey: 'mb_real_key' });
    const res = await exchange(code);
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.token_type).toBe('bearer');

    const decoded = decode(res.body.access_token);
    expect(decoded.metabase_url).toBe('https://metabase.example.com');
    expect(decoded.metabase_api_key).toBe('mb_real_key');
    expect(decoded.metabase_password).toBeUndefined();
  });

  it('issues a JWT for a valid code (username+password flow)', async () => {
    const code = await getAuthCode({ username: 'admin@example.com', password: 'secret' });
    const res = await exchange(code);
    expect(res.status).toBe(200);
    const decoded = decode(res.body.access_token);
    expect(decoded.metabase_username).toBe('admin@example.com');
    expect(decoded.metabase_api_key).toBeUndefined();
  });

  it('rejects unsupported grant_type', async () => {
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'client_credentials',
      code: 'whatever',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('rejects missing code', async () => {
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects invalid code', async () => {
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
      code: 'nonexistent-code',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a code used twice (single use)', async () => {
    const code = await getAuthCode();
    await exchange(code);
    const res2 = await exchange(code);
    expect(res2.status).toBe(400);
    expect(res2.body.error).toBe('invalid_grant');
  });
});

// ── Malformed API key (password-manager autofill) ────────────────────────────

describe('POST /oauth/authorize - malformed API key', () => {
  it('drops a value that cannot be an API key and keeps the session token', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'my-saved-google-password',   // autofilled, not a key
      metabase_session_token: 'a-real-session-uuid',
    });
    const code = new URL(res.headers['location'] as string).searchParams.get('code') as string;
    const { body } = await exchange(code);
    const decoded = decode(body.access_token);

    // The API key outranks every other credential downstream, so keeping it
    // would send a password as X-API-Key and earn a 401 from Metabase.
    expect(decoded.metabase_api_key).toBeUndefined();
    expect(decoded.metabase_session_token).toBe('a-real-session-uuid');
  });

  it('keeps a well-formed API key', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'mb_realkey12345',
    });
    const code = new URL(res.headers['location'] as string).searchParams.get('code') as string;
    const { body } = await exchange(code);
    const decoded = decode(body.access_token);
    expect(decoded.metabase_api_key).toBe('mb_realkey12345');
  });

  it('rejects when the malformed key was the only credential', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'not-a-key',
    });
    expect(res.status).toBe(400);
  });

  it('marks the credential inputs so the SSO path can clear them', async () => {
    const res = await request(app).get('/oauth/authorize').query({ redirect_uri: 'https://client.example.com/cb', ...PKCE });
    // Count the inputs themselves, not the querySelectorAll that clears them.
    const inputs = (res.text.match(/autocomplete="off" data-credential/g) || []).length;
    expect(inputs).toBe(4);
    for (const id of ['metabase_api_key', 'metabase_username', 'metabase_password', 'metabase_session_token']) {
      expect(res.text).toMatch(new RegExp(`autocomplete="off" data-credential id="${id}"`));
    }
  });
});

// ── Protected Resource Metadata (RFC 9728) ───────────────────────────────────

describe('GET /.well-known/oauth-protected-resource', () => {
  it('advertises the resource and its authorization server', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://mcp.example.com/mcp');
    expect(res.body.authorization_servers).toContain('https://mcp.example.com');
    expect(res.body.bearer_methods_supported).toContain('header');
  });

  it('is also served under the resource path, as RFC 9728 constructs it', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://mcp.example.com/mcp');
  });

  it('derives that path from the resource, not a hardcoded /mcp', async () => {
    // A proxy may expose the server under a prefix it strips, so the well-known
    // path RFC 9728 constructs is not always /.well-known/...-resource/mcp.
    process.env.MCP_RESOURCE_URI = 'https://mcp.example.com/prefixed/mcp';
    vi.resetModules();
    const { app: prefixed } = await import('../src/oauth-gateway.js?prefixed');
    delete process.env.MCP_RESOURCE_URI;

    const res = await request(prefixed).get('/.well-known/oauth-protected-resource/prefixed/mcp');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://mcp.example.com/prefixed/mcp');
  });
});

// ── Audience binding ─────────────────────────────────────────────────────────

describe('access token audience', () => {
  it('binds the access token to the MCP resource', async () => {
    const code = await getAuthCode({ apiKey: 'mb_aud_key' });
    const { body } = await exchange(code);
    const decoded = decode(body.access_token);
    expect(decoded.aud).toBe('https://mcp.example.com/mcp');
  });

  it('leaves the refresh token unbound — it is redeemed at the AS, not the resource', async () => {
    const code = await getAuthCode({ apiKey: 'mb_aud_key' });
    const { body } = await exchange(code);
    const decoded = decode(body.refresh_token);
    expect(decoded.aud).toBeUndefined();
  });

  it('rejects a token minted for another resource', async () => {
    const code = await getAuthCode({ apiKey: 'mb_aud_key' });
    const { body } = await exchange(code);
    const foreign = jwt.sign(
      { gid: decode(body.access_token).gid, typ: 'access', aud: 'https://other.example.com/mcp' },
      'test-secret-for-vitest',
      { expiresIn: '1h', issuer: ISSUER },
    );
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${foreign}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error_description).toBe('Token issued for another resource');
  });

  it('refuses a token from before grants existed, which carried the credentials itself', async () => {
    const legacy = jwt.sign(
      { metabase_url: 'https://metabase.example.com', metabase_api_key: 'mb_legacy' },
      'test-secret-for-vitest',
      { expiresIn: '8h' },
    );
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${legacy}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
  });

  it('points the WWW-Authenticate challenge at the resource metadata', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    );
  });
});

// ── Refresh grant ────────────────────────────────────────────────────────────

describe('POST /oauth/token - refresh_token grant', () => {
  async function getTokenPair(opts = { apiKey: 'mb_refresh_key' }) {
    const code = await getAuthCode(opts);
    const res = await exchange(code);
    return res.body;
  }

  it('issues a refresh token alongside the access token', async () => {
    const body = await getTokenPair();
    expect(body.refresh_token).toBeTruthy();
    expect(body.refresh_expires_in).toBeGreaterThan(body.expires_in);

    const decoded = decode(body.refresh_token);
    expect(decoded.typ).toBe('refresh');
  });

  it('marks access tokens with typ=access', async () => {
    const body = await getTokenPair();
    const decoded = decode(body.access_token);
    expect(decoded.typ).toBe('access');
  });

  it('exchanges a refresh token for a fresh access token', async () => {
    const body = await getTokenPair();
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token,
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();

    const decoded = decode(res.body.access_token);
    expect(decoded.typ).toBe('access');
    expect(decoded.metabase_api_key).toBe('mb_refresh_key');
  });

  it('carries every credential shape across a refresh', async () => {
    const body = await getTokenPair({ username: 'admin@example.com', password: 'secret' } as any);
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token,
    });
    const decoded = decode(res.body.access_token);
    expect(decoded.metabase_username).toBe('admin@example.com');
    expect(decoded.metabase_password).toBe('secret');
    expect(decoded.metabase_api_key).toBeUndefined();
  });

  it('rotates the refresh token on use', async () => {
    const body = await getTokenPair();
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token,
    });
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.refresh_token).not.toBe(body.refresh_token);
  });

  it('keeps a stable subject across refreshes so logs can correlate', async () => {
    const body = await getTokenPair();
    const first = decode(body.access_token);
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token,
    });
    const second = decode(res.body.access_token);
    expect(second.sub).toBe(first.sub);
    expect(first.sub).toMatch(/^[0-9a-f]{12}$/);
  });

  it('never leaks a credential into the subject', async () => {
    const body = await getTokenPair({ apiKey: 'mb_super_secret' } as any);
    const decoded = decode(body.access_token);
    expect(decoded.sub).not.toContain('mb_super_secret');
  });

  it('refuses an access token used as a refresh token', async () => {
    const body = await getTokenPair();
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: body.access_token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toBe('Not a refresh token');
  });

  it('rejects a missing refresh_token', async () => {
    const res = await request(app).post('/oauth/token').send({ grant_type: 'refresh_token' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects a malformed refresh token', async () => {
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: 'not.a.jwt',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a refresh token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { metabase_url: 'https://metabase.example.com', typ: 'refresh' },
      'attacker-secret',
      { expiresIn: '30d' },
    );
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: forged,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects an expired refresh token', async () => {
    const expired = jwt.sign(
      { metabase_url: 'https://metabase.example.com', typ: 'refresh' },
      'test-secret-for-vitest',
      { expiresIn: '-1s' },
    );
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: expired,
    });
    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe('Refresh token expired');
  });
});

// ── Discovery advertises the refresh grant ───────────────────────────────────

describe('refresh grant advertisement', () => {
  it('lists refresh_token in authorization server metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.grant_types_supported).toContain('refresh_token');
  });

  it('lists refresh_token in openid configuration', async () => {
    const res = await request(app).get('/.well-known/openid-configuration');
    expect(res.body.grant_types_supported).toContain('refresh_token');
  });

  it('lists refresh_token on client registration', async () => {
    const res = await request(app).post('/oauth/register').send({
      redirect_uris: ['https://client.example.com/callback'],
    });
    expect(res.body.grant_types).toContain('refresh_token');
  });
});

// ── PKCE ─────────────────────────────────────────────────────────────────────

describe('PKCE (S256)', () => {
  // Precomputed: verifier = 'test-verifier-string', challenge = SHA256(verifier) base64url
  const verifier  = 'test-verifier-string';
  // echo -n 'test-verifier-string' | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
  const challenge = 'LHKy4-q59ocwlltGr-0vD9UbiHBsIU09drZuupn1ghs';

  it('issues token when PKCE verifier is correct', async () => {
    const code = await getAuthCode({ apiKey: 'mb_pkce', codeChallenge: challenge });
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it('rejects token when PKCE verifier is wrong', async () => {
    const code = await getAuthCode({ apiKey: 'mb_pkce', codeChallenge: challenge });
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses an authorization request without PKCE', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://client.example.com/callback',
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'mb_key',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('PKCE');

    const page = await request(app).get('/oauth/authorize').query({ redirect_uri: 'https://client.example.com/callback' });
    expect(page.status).toBe(400);
  });

  it('refuses the plain PKCE method', async () => {
    const page = await request(app).get('/oauth/authorize')
      .query({ redirect_uri: 'https://client.example.com/callback', code_challenge: VERIFIER, code_challenge_method: 'plain' });
    expect(page.status).toBe(400);
  });

  it('rejects token when PKCE verifier is missing', async () => {
    const code = await getAuthCode({ apiKey: 'mb_pkce', codeChallenge: challenge });
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
      code,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });
});

// ── MCP proxy auth ────────────────────────────────────────────────────────────

describe('POST /mcp - authentication', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Bearer token required');
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer invalid.jwt.token')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('returns 401 for non-Bearer auth scheme', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
  });

  it('distinguishes an expired token from an invalid one', async () => {
    const expired = jwt.sign(
      { metabase_url: 'https://metabase.example.com', typ: 'access' },
      'test-secret-for-vitest',
      { expiresIn: '-1s' },
    );
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${expired}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error_description).toBe('Token expired');

    const bad = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not.a.jwt')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(bad.body.error_description).toBe('Token invalid');
  });

  it('refuses a refresh token used as a bearer credential', async () => {
    const code = await getAuthCode({ apiKey: 'mb_key' });
    const { body } = await exchange(code);
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${body.refresh_token}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error_description).toBe('Not an access token');
  });

  it('sends a WWW-Authenticate challenge so the client knows to renew', async () => {
    const expired = jwt.sign(
      { metabase_url: 'https://metabase.example.com', typ: 'access' },
      'test-secret-for-vitest',
      { expiresIn: '-1s' },
    );
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${expired}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');

    const none = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(none.headers['www-authenticate']).toContain('Bearer realm=');
  });
});

// ── Grants: rotation, reuse detection and revocation ─────────────────────────

describe('grants', () => {
  async function pair(apiKey = 'mb_grant_key') {
    const code = await getAuthCode({ apiKey });
    return (await exchange(code)).body;
  }
  const refreshWith = (refresh_token: string) =>
    request(app).post('/oauth/token').send({ grant_type: 'refresh_token', refresh_token });
  const callMcp = (access: string) =>
    request(app).post('/mcp').set('Authorization', `Bearer ${access}`)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  afterEach(() => vi.useRealTimers());

  it('keeps every credential out of the tokens', async () => {
    const body = await pair('mb_never_in_a_token');
    const readable = JSON.stringify(jwt.decode(body.access_token)) + JSON.stringify(jwt.decode(body.refresh_token));
    expect(readable).not.toContain('mb_never_in_a_token');
    expect(readable).not.toContain('metabase.example.com');
    expect(jwt.decode(body.access_token)).not.toHaveProperty('cred');
  });

  it('uses a short access token and a refresh token that dies when idle', async () => {
    const body = await pair();
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_expires_in).toBe(7 * 86400);
  });

  it('honours a replaced refresh token briefly, for a client retrying a lost response', async () => {
    const body = await pair();
    const first = await refreshWith(body.refresh_token);
    expect(first.status).toBe(200);
    const retry = await refreshWith(body.refresh_token);
    expect(retry.status).toBe(200);
  });

  it('revokes the whole grant when a replaced refresh token comes back later', async () => {
    const body = await pair();
    const rotated = (await refreshWith(body.refresh_token)).body;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);

    const replay = await refreshWith(body.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body.error_description).toBe('Refresh token revoked');

    // The legitimate holder is cut off too: nobody can tell which copy is the thief's.
    expect((await refreshWith(rotated.refresh_token)).body.error_description).toBe('Refresh token revoked');
    const mcp = await callMcp(rotated.access_token);
    expect(mcp.status).toBe(401);
    expect(mcp.body.error_description).toBe('Token revoked');
  });

  it('serializes concurrent refreshes so neither looks like a reuse', async () => {
    const body = await pair();
    const [a, b] = await Promise.all([refreshWith(body.refresh_token), refreshWith(body.refresh_token)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('ends a grant on revocation, effective at once for its access token', async () => {
    const body = await pair();
    expect((await callMcp(body.access_token)).status).toBe(202);

    const revoked = await request(app).post('/oauth/revoke').type('form').send({ token: body.refresh_token });
    expect(revoked.status).toBe(200);

    expect((await callMcp(body.access_token)).status).toBe(401);
    expect((await refreshWith(body.refresh_token)).status).toBe(400);
  });

  it('revokes with the access token too', async () => {
    const body = await pair();
    await request(app).post('/oauth/revoke').send({ token: body.access_token });
    expect((await refreshWith(body.refresh_token)).body.error_description).toBe('Refresh token revoked');
  });

  it('answers 200 to a revocation of an unknown token, revealing nothing', async () => {
    const res = await request(app).post('/oauth/revoke').send({ token: 'not.a.jwt' });
    expect(res.status).toBe(200);
  });

  it('advertises the revocation endpoint', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.revocation_endpoint).toBe('https://mcp.example.com/oauth/revoke');
  });

  it('refuses a token signed with another algorithm or issuer', async () => {
    const body = await pair();
    const { gid } = decode(body.access_token);
    const otherIssuer = jwt.sign({ gid, typ: 'access', aud: RESOURCE }, 'test-secret-for-vitest', { issuer: 'https://evil.example.com', expiresIn: '1h' });
    expect((await callMcp(otherIssuer)).status).toBe(401);
    const unsigned = jwt.sign({ gid, typ: 'access', aud: RESOURCE, iss: ISSUER }, '', { algorithm: 'none' } as any);
    expect((await callMcp(unsigned)).status).toBe(401);
  });
});

// ── Where codes may go ───────────────────────────────────────────────────────

describe('redirect_uri', () => {
  it('refuses to send a code to a host outside the allowlist', async () => {
    const res = await request(app).post('/oauth/authorize').send({
      redirect_uri: 'https://attacker.example.net/cb',
      ...PKCE,
      metabase_url: 'https://metabase.example.com',
      metabase_api_key: 'mb_key',
    });
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
  });

  it('refuses to register such a client', async () => {
    const res = await request(app).post('/oauth/register').send({ redirect_uris: ['https://attacker.example.net/cb'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('allows a loopback redirect, for local clients', async () => {
    const res = await request(app).post('/oauth/register').send({ redirect_uris: ['http://localhost:33418/callback'] });
    expect(res.status).toBe(201);
  });

  it('refuses plain http to a remote host', async () => {
    const res = await request(app).post('/oauth/register').send({ redirect_uris: ['http://client.example.com/cb'] });
    expect(res.status).toBe(400);
  });

  it('only redeems a code where it was sent', async () => {
    const code = await getAuthCode({ apiKey: 'mb_key' });
    const res = await exchange(code, { redirect_uri: 'https://client.example.com/other' });
    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe('redirect_uri mismatch');
  });
});

// ── Health ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
