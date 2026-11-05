/**
 * Server-side Google sign-in for Metabase.
 *
 * Metabase's own Google SSO hands the browser a short-lived Google ID token,
 * which Metabase trades for a session that lives MAX_SESSION_AGE (14 days by
 * default). Once that session expires nothing can renew it without the user, so
 * every MCP connection built on it died two weeks after sign-in.
 *
 * Here the gateway runs the OAuth authorization-code flow itself, with offline
 * access, using Metabase's own Google client. That yields a Google refresh token
 * from which the gateway can later obtain a fresh ID token — with the audience
 * Metabase expects — and a new Metabase session, without asking the user again.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Google refused the grant (revoked, expired or reused): the user must sign in again. */
export class GoogleGrantRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleGrantRejected';
  }
}

/** Metabase refused to open a session for this Google account. */
export class MetabaseRejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'MetabaseRejected';
  }
}

export function googleAuthUrl(cfg: GoogleConfig, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  // offline + consent: Google only returns a refresh token on a consented grant.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GoogleTokens {
  idToken: string;
  /** Present on the first exchange; Google may also rotate it on refresh. */
  refreshToken?: string;
  subject?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    // Only the error code: the description can echo request details.
    if (data.error === 'invalid_grant') throw new GoogleGrantRejected('Google answered invalid_grant');
    throw new Error(`Google token endpoint answered ${res.status}${data.error ? ` (${data.error})` : ''}`);
  }
  if (typeof data.id_token !== 'string') throw new Error('Google returned no id_token');
  return {
    idToken: data.id_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    subject: subjectOfIdToken(data.id_token),
  };
}

export function exchangeGoogleCode(cfg: GoogleConfig, code: string): Promise<GoogleTokens> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
}

export function refreshGoogleIdToken(cfg: GoogleConfig, refreshToken: string): Promise<GoogleTokens> {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
}

/**
 * The ID token's `sub`. Not verified here: the token comes straight from Google's
 * token endpoint over TLS, and it is used only as a log label. Metabase verifies
 * the token itself before opening a session.
 */
function subjectOfIdToken(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Revokes a Google refresh token, so a revoked connection cannot mint Metabase
 * sessions anymore even from a copy of the store. Best effort: false when Google
 * could not be told.
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    // 400 invalid_token: already revoked or expired, which is the goal anyway.
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

function apiUrl(metabaseUrl: string, path: string): string {
  return `${metabaseUrl.replace(/\/$/, '')}${path}`;
}

/** Trades a Google ID token for a Metabase session id. */
export async function metabaseSessionFromGoogle(metabaseUrl: string, idToken: string): Promise<string> {
  const res = await fetch(apiUrl(metabaseUrl, '/api/session/google_auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: idToken }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new MetabaseRejected(res.status, `Metabase answered ${res.status} to google_auth`);
  const data = (await res.json()) as Record<string, any>;
  if (typeof data.id !== 'string') throw new Error('Metabase returned no session id');
  return data.id;
}

/**
 * Ends a session in Metabase. A session lives MAX_SESSION_AGE however often it
 * is replaced, so renewing without this would only add live sessions. Best
 * effort: returns false when Metabase could not be told.
 */
export async function metabaseLogout(metabaseUrl: string, session: string): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(metabaseUrl, '/api/session'), {
      method: 'DELETE',
      headers: { 'X-Metabase-Session': session },
      signal: AbortSignal.timeout(5000),
    });
    // 401: the session was already gone, which is the goal anyway.
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Whether Metabase still honours a session: true or false when it says so,
 * undefined when it could not be asked (network error, 5xx).
 */
export async function metabaseSessionAlive(metabaseUrl: string, session: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(apiUrl(metabaseUrl, '/api/user/current'), {
      headers: { 'X-Metabase-Session': session },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return true;
    if (res.status === 401) return false;
    return undefined;
  } catch {
    return undefined;
  }
}
