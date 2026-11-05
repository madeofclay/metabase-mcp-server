/**
 * Explicit messages for Metabase 401 and 403 responses.
 *
 * Axios reports them as «Request failed with status code 403», which tells the
 * reader nothing: not what was refused, not for whom, not what to do. A routine
 * that posts to Slack then says «error 403 por permisos» and nobody knows which
 * permission to ask for. These messages name the resource (from the request
 * path), the signed-in user when known, what Metabase said, and the next step.
 */

const KINDS: Record<string, string> = {
  card: 'card',
  dashboard: 'dashboard',
  database: 'database',
  collection: 'collection',
  table: 'table',
  field: 'field',
  user: 'user',
  'native-query-snippet': 'snippet',
};

/** What a request touched: «card 6537», «database 40», or a fallback. */
export function describeResource(method: string | undefined, url: string | undefined, data?: unknown): string {
  const path = (url || '').split('?')[0];
  const m = path.match(/\/api\/([a-z-]+)\/(\d+)/);
  if (m && KINDS[m[1]]) return `${KINDS[m[1]]} ${m[2]}`;
  if (/\/api\/dataset/.test(path)) {
    let body: any = data;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = undefined; }
    }
    const db = body?.database;
    return db ? `a query on database ${db}` : 'a query';
  }
  const kind = path.match(/\/api\/([a-z-]+)/)?.[1];
  if (kind && KINDS[kind]) return `${KINDS[kind]}s`;
  return `${(method || 'GET').toUpperCase()} ${path || '?'}`;
}

/** Metabase's own explanation, when its response carries one. */
export function metabaseDetail(responseData: unknown): string | undefined {
  if (!responseData) return undefined;
  if (typeof responseData === 'string') return responseData.trim().slice(0, 300) || undefined;
  const d: any = responseData;
  const msg = d.message || d.error || (typeof d.errors === 'string' ? d.errors : undefined);
  if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300);
  if (d.errors && typeof d.errors === 'object') return JSON.stringify(d.errors).slice(0, 300);
  return undefined;
}

/**
 * The message for a 401 or 403, or undefined for any other status. `user` is the
 * signed-in user's email when it could be read.
 */
export function explainMetabaseError(opts: {
  status?: number;
  method?: string;
  url?: string;
  data?: unknown;
  responseData?: unknown;
  user?: string;
}): string | undefined {
  const { status } = opts;
  if (status !== 401 && status !== 403) return undefined;
  const what = describeResource(opts.method, opts.url, opts.data);
  const detail = metabaseDetail(opts.responseData);
  const said = detail ? ` Metabase said: "${detail}".` : '';
  if (status === 401) {
    return (
      `Metabase rejected the credentials (401) while accessing ${what}: the session expired or the API key is no longer valid.` +
      `${said} Reconnect the Metabase MCP (in Claude Code: /mcp → reconnect → Continue with Google) and try again.`
    );
  }
  const who = opts.user ? `the signed-in user (${opts.user})` : 'the signed-in user';
  return (
    `Metabase denied access (403) to ${what}: ${who} has no permission on it.${said} ` +
    `Ask a Metabase administrator for access to that ${what.replace(/^a query on /, '')}, ` +
    `or use content in a collection you can see.`
  );
}
