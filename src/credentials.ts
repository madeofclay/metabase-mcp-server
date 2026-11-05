/**
 * Metabase credentials of a connection, and how they are sealed at rest.
 *
 * They never travel in a token: the gateway keeps them in its grant store
 * (src/grant-store.ts), sealed with AES-256-GCM under a key derived from
 * JWT_SECRET. Each ciphertext is bound to its grant id (GCM additional data), so
 * it cannot be moved to another grant in the store file.
 */

import crypto from 'crypto';

export interface Credentials {
  metabase_url: string;
  metabase_api_key?: string;
  metabase_username?: string;
  metabase_password?: string;
  metabase_session_token?: string;
  /** When the Metabase session was created, in epoch seconds. */
  metabase_session_issued_at?: number;
  /**
   * Google refresh token from the server-side SSO flow. It lets the gateway mint
   * a new Metabase session when the current one ages out, instead of making the
   * user sign in again every MAX_SESSION_AGE (14 days by default in Metabase).
   */
  google_refresh_token?: string;
  /** Google's stable account id (`sub`), used to keep the log subject stable. */
  google_subject?: string;
}

const STRING_FIELDS = [
  'metabase_url',
  'metabase_api_key',
  'metabase_username',
  'metabase_password',
  'metabase_session_token',
  'google_refresh_token',
  'google_subject',
] as const;

/** Copies only the credential fields, dropping JWT claims and empty values. */
export function pickCredentials(src: Record<string, any>): Credentials {
  const creds: Record<string, any> = {};
  for (const field of STRING_FIELDS) {
    if (typeof src[field] === 'string' && src[field]) creds[field] = src[field];
  }
  if (typeof src.metabase_session_issued_at === 'number') {
    creds.metabase_session_issued_at = src.metabase_session_issued_at;
  }
  return creds as Credentials;
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialSealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    // A dedicated key, so the signing secret is never used directly as a cipher key.
    this.key = Buffer.from(
      crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'metabase-mcp-gateway/credentials/v1', 32),
    );
  }

  /** `context` is authenticated, not encrypted: opening needs the same value. */
  seal(creds: Credentials, context = ''): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
  }

  /** Throws when the value was not sealed with this key and context, or was tampered with. */
  open(sealed: string, context = ''): Credentials {
    const [version, body] = sealed.split('.');
    if (version !== VERSION || !body) throw new Error('unknown credential format');
    const raw = Buffer.from(body, 'base64url');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return pickCredentials(JSON.parse(plain.toString('utf8')));
  }
}
