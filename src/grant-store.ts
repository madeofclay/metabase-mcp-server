/**
 * Server-side record of every connection ("grant") the gateway has authorized.
 *
 * The tokens handed to clients only point at a grant; the credentials live here,
 * sealed with AES-256-GCM, so a leaked token reveals nothing and every grant can
 * be revoked on the spot (OAuth 2.0 Security BCP, RFC 9700 §4.14):
 *
 *  - Refresh tokens rotate on every use and only the newest one is honoured. The
 *    store keeps an HMAC of its jti, never the token. Presenting an older one
 *    means two parties hold the same grant, so the whole grant is revoked.
 *  - Each grant has an absolute lifetime, however often it is refreshed.
 *  - Access tokens are checked against the grant on every call, so revoking takes
 *    effect immediately instead of when the access token expires.
 *
 * Persisted as a JSON file (mode 0600), rewritten atomically on every change, so
 * a restart does not disconnect anyone. `:memory:` keeps it in memory only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Credentials, CredentialSealer } from './credentials.js';

export interface Grant {
  id: string;
  /** Log label of the connection; never a credential. */
  sub: string;
  /** Sealed Credentials, bound to this grant's id. Emptied on revocation. */
  cred: string;
  created_at: number;
  /** Absolute end of the grant, in epoch seconds. */
  expires_at: number;
  /** HMAC of the jti of the only refresh token currently honoured. */
  refresh_hash: string;
  /** HMAC of the refresh token it replaced, honoured for a short grace period. */
  previous_hash?: string;
  rotated_at: number;
  revoked_at?: number;
  revoked_reason?: string;
}

export type RefreshCheck = 'current' | 'grace' | 'reused';

export const MEMORY = ':memory:';

const now = () => Math.floor(Date.now() / 1000);

export class GrantStore {
  private readonly grants = new Map<string, Grant>();
  private readonly hashKey: Buffer;

  constructor(
    private readonly file: string,
    secret: string,
    private readonly sealer: CredentialSealer,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
  ) {
    this.hashKey = Buffer.from(
      crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'metabase-mcp-gateway/refresh-hash/v1', 32),
    );
    this.load();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load() {
    if (this.file === MEMORY || !fs.existsSync(this.file)) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Grant[];
      for (const g of rows) this.grants.set(g.id, g);
      const purged = this.purge(false);
      this.log('info', `grant store loaded grants=${this.grants.size} purged=${purged}`);
    } catch (err) {
      // Failing closed: an unreadable store disconnects everyone, it never lets
      // an unknown token through. The file is kept aside for inspection.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      this.log('error', `grant store unreadable, moved to ${aside}: ${(err as Error).message}`);
    }
  }

  private save() {
    if (this.file === MEMORY) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.grants.values()]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Drops grants past their absolute end, revoked or not. */
  purge(persist = true): number {
    const t = now();
    let n = 0;
    for (const [id, g] of this.grants) {
      if (g.expires_at <= t) {
        this.grants.delete(id);
        n++;
      }
    }
    if (n && persist) this.save();
    return n;
  }

  // ── Grants ─────────────────────────────────────────────────────────────────

  hashJti(jti: string): string {
    return crypto.createHmac('sha256', this.hashKey).update(jti).digest('hex');
  }

  create(creds: Credentials, sub: string, maxAgeS: number, refreshJti: string): Grant {
    const id = crypto.randomBytes(16).toString('hex');
    const t = now();
    const grant: Grant = {
      id,
      sub,
      cred: this.sealer.seal(creds, id),
      created_at: t,
      expires_at: t + maxAgeS,
      refresh_hash: this.hashJti(refreshJti),
      rotated_at: t,
    };
    this.grants.set(id, grant);
    this.save();
    return grant;
  }

  /** The grant, unless it is unknown or past its absolute end. Revoked ones are returned. */
  get(id: string | undefined): Grant | undefined {
    if (!id) return undefined;
    const g = this.grants.get(id);
    if (!g || g.expires_at <= now()) return undefined;
    return g;
  }

  /** The grant's credentials. Throws when they were tampered with or the grant is revoked. */
  credentials(grant: Grant): Credentials {
    if (grant.revoked_at || !grant.cred) throw new Error('grant revoked');
    return this.sealer.open(grant.cred, grant.id);
  }

  /** Whether a refresh token's jti is the one this grant honours. */
  checkRefresh(grant: Grant, jti: string, graceS: number): RefreshCheck {
    const h = Buffer.from(this.hashJti(jti));
    const same = (stored?: string) =>
      Boolean(stored) && crypto.timingSafeEqual(h, Buffer.from(stored!));
    if (same(grant.refresh_hash)) return 'current';
    // A client that lost the response to its refresh retries with the token it
    // still has. Honour that briefly, instead of treating it as theft.
    if (same(grant.previous_hash) && now() - grant.rotated_at <= graceS) return 'grace';
    return 'reused';
  }

  /** Records new credentials and the jti of the refresh token that replaces the current one. */
  rotate(grant: Grant, creds: Credentials, refreshJti: string) {
    grant.cred = this.sealer.seal(creds, grant.id);
    grant.previous_hash = grant.refresh_hash;
    grant.refresh_hash = this.hashJti(refreshJti);
    grant.rotated_at = now();
    this.save();
  }

  /**
   * Revokes a grant and returns the credentials it held, so the caller can end
   * them upstream. The record stays (without credentials) until its absolute end,
   * so a later use of its tokens is reported as revoked, not unknown.
   */
  revoke(grant: Grant, reason: string): Credentials | undefined {
    if (grant.revoked_at) return undefined;
    let creds: Credentials | undefined;
    try {
      creds = this.credentials(grant);
    } catch { /* unreadable: nothing to end upstream */ }
    grant.revoked_at = now();
    grant.revoked_reason = reason;
    grant.cred = '';
    delete grant.previous_hash;
    this.save();
    return creds;
  }

  get size(): number {
    return this.grants.size;
  }
}
