/**
 * Metabase API Client
 * Handles all API interactions with Metabase
 */

import { explainMetabaseError, metabaseDetail } from "../utils/metabase-errors.js";
import { validateVisualization, effectiveSettings, columnsOf } from "../utils/viz-validation.js";
import axios, { AxiosInstance } from "axios";
import { ErrorCode, McpError } from "../types/errors.js";
import {
    Card,
    Collection,
    Dashboard,
    Database,
    MetabaseConfig,
    PermissionGroup,
    QueryResult,
    User
} from "../types/metabase.js";

import {
  TagOverride,
  buildTemplateTags,
  nativeQueryOf,
  tagObject,
  variableTypeForFilter,
} from "../utils/template-tags.js";

export interface SafePutResult {
  dashboard: any;
  previous_revision_id: number | null;
  diff: {
    dashcards: { added: number; kept: number; removed: number[] };
    tabs: { added: number; kept: number; removed: number[] };
  };
  warning?: string;
  dry_run?: true;
  payload?: any;
}

function tabList(tabs: any[]): string {
  return tabs.length ? tabs.map((t) => `${t.id} (${t.name})`).join(', ') : 'none';
}

const GRID_COLUMNS = 24;

/** The filter type that feeds each variable type when none is given. */
const DEFAULT_FILTER_TYPE: Record<string, string> = { date: 'date/single', text: 'category', number: 'number/=' };

/** A filter value as Metabase expects it: lists for string/* and number/*, a string for dates. */
function filterValue(type: string, value: unknown): unknown {
  if (type.startsWith('string/') || type.startsWith('number/')) return Array.isArray(value) ? value : [value];
  if (type.startsWith('date/')) return Array.isArray(value) ? String(value[0]) : String(value);
  return value;
}

function errorText(err: any): string {
  const data = err?.response?.data;
  if (data) return typeof data === 'string' ? data : data.message || data.error || JSON.stringify(data);
  if (typeof err === 'string') return err;
  return err?.message || JSON.stringify(err);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Maps with at most `limit` promises in flight, keeping the input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The new tab list with ids: existing tabs keep theirs, new ones get negative
 * ids. Verified on Metabase 0.63 (dashboard 621): one PUT with negative tab ids
 * and dashcards pointing at them (text cards with card_id null and negative
 * dashcard ids included) creates the tabs with their cards in place.
 */
function resolveTabs(dashboardId: number, currentTabs: any[], tabs: { id?: number; name: string }[]): { id: number; name: string }[] {
  const currentIds = new Set(currentTabs.map((t: any) => t.id));
  const taken = new Set<number>();
  for (const t of tabs) {
    if (t.id === undefined) continue;
    if (t.id === 0) throw new Error('Tab id 0 is not valid: omit the id for a new tab');
    if (t.id > 0 && !currentIds.has(t.id)) {
      throw new Error(`Tab ${t.id} is not in dashboard ${dashboardId}. Tabs: ${tabList(currentTabs)}`);
    }
    if (taken.has(t.id)) throw new Error(`Tab ${t.id} appears twice in the list`);
    taken.add(t.id);
  }
  let nextNew = -1;
  return tabs.map((t) => {
    const name = (t.name || '').trim();
    if (!name) throw new Error('Every tab needs a name');
    let id = t.id;
    if (id === undefined) {
      while (taken.has(nextNew)) nextNew--;
      id = nextNew;
      taken.add(id);
    }
    return { id, name };
  });
}

/** {text, display} shorthand → a virtual text or heading dashcard. Raw dashcards pass through. */
function expandTextCard(dc: any): any {
  if (dc.text === undefined) return dc;
  const { text, display = 'text', ...rest } = dc;
  const vs = rest.visualization_settings || {};
  return {
    ...rest,
    card_id: null,
    visualization_settings: {
      'dashcard.background': display !== 'heading',
      ...vs,
      virtual_card: { ...(vs.virtual_card || {}), display },
      text,
    },
  };
}

function dashcardLabel(dc: any): string {
  if (dc.card?.name) return dc.card.name;
  const text = dc.visualization_settings?.text;
  if (typeof text === 'string') return `text: ${text.replace(/\s+/g, ' ').slice(0, 40)}`;
  return dc.card_id ? `card ${dc.card_id}` : 'virtual card';
}

/** A dashboard's tabs in display order. */
function orderedTabs(tabs: any[] | undefined): any[] {
  return [...(tabs || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * The real id Metabase gave each new (negative id) dashcard of a layout. Metabase
 * does not echo the temporary ids, so each new dashcard is matched, after the
 * write, to the stored one in the same tab, position, size and card. Tabs match
 * by position: the layout's tab list and the stored one are in the same order.
 */
export function createdDashcardIds(
  layoutTabs: any[],
  storedTabs: any[],
  layoutDashcards: any[],
  storedDashcards: any[],
): { temp_id: number; id: number | null; card_id: number | null; tab: number | null }[] {
  const tabOf = new Map<number, number>();
  layoutTabs.forEach((t: any, i: number) => {
    if (storedTabs[i]) tabOf.set(t.id, storedTabs[i].id);
  });
  const layoutIds = new Set(layoutDashcards.map((dc) => dc.id));
  const taken = new Set<number>();
  // Existing dashcards keep their ids; only stored ones not in the layout are new.
  const candidates = storedDashcards.filter((s) => !layoutIds.has(s.id));
  return layoutDashcards
    .filter((dc) => typeof dc.id === 'number' && dc.id < 0)
    .map((dc) => {
      const tab = dc.dashboard_tab_id === undefined || dc.dashboard_tab_id === null
        ? null
        : dc.dashboard_tab_id < 0 ? tabOf.get(dc.dashboard_tab_id) ?? null : dc.dashboard_tab_id;
      const match = candidates.find((s) =>
        !taken.has(s.id) &&
        (s.dashboard_tab_id ?? null) === tab &&
        s.row === dc.row && s.col === dc.col && s.size_x === dc.size_x && s.size_y === dc.size_y &&
        (s.card_id ?? null) === (dc.card_id ?? null));
      if (match) taken.add(match.id);
      return { temp_id: dc.id, id: match ? match.id : null, card_id: dc.card_id ?? null, tab };
    });
}

export class MetabaseClient {
  private axiosInstance: AxiosInstance;
  private sessionToken: string | null = null;
  private config: MetabaseConfig;
  private authMode: 'api_key' | 'session_token' | 'password' = 'password';

  constructor(config: MetabaseConfig) {
    this.config = config;
    this.axiosInstance = axios.create({
      baseURL: config.url,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000, // 30 second timeout to prevent hanging requests
    });

    if (config.apiKey) {
      this.authMode = 'api_key';
      this.logInfo("Using Metabase API Key for authentication.");
      this.axiosInstance.defaults.headers.common["X-API-Key"] = config.apiKey;
      this.sessionToken = "api_key_used";
    } else if (config.sessionToken) {
      this.authMode = 'session_token';
      this.logInfo("Using pre-existing Metabase session token (e.g. Google SSO).");
      this.axiosInstance.defaults.headers.common["X-Metabase-Session"] = config.sessionToken;
      this.sessionToken = config.sessionToken;
    } else if (config.username && config.password) {
      this.logInfo("Using Metabase username/password for authentication.");
    } else {
      this.logError(
        "Metabase authentication credentials not configured properly.",
        {}
      );
      throw new Error(
        "Metabase authentication credentials not provided or incomplete."
      );
    }

    // Add request interceptor to handle authentication automatically
    this.axiosInstance.interceptors.request.use(
      async (config) => {
        // Skip authentication for the session endpoint itself
        if (config.url === "/api/session") {
          return config;
        }

        // Ensure authentication before making any API call
        await this.ensureAuthenticated();
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Every Metabase failure funnels through here. Without it the server logged
    // nothing above `info`, so a credential Metabase had stopped accepting was
    // invisible on this side: the tool error travels inside an HTTP 200 to the
    // client, and the only trace left here was a successful-looking request.
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const status = error?.response?.status;
        if (status) {
          this.logUpstream(
            status === 401 || status === 403 ? 'error' : 'warn',
            `Metabase returned ${status} for ${error?.config?.method?.toUpperCase() || '?'} ${error?.config?.url || '?'}`,
            status,
          );
        }
        // Replace axios' «Request failed with status code 403» with what was
        // refused, for whom, what Metabase said and what to do next.
        if (status === 401 || status === 403) {
          const user = status === 403 && error?.config?.url !== '/api/user/current'
            ? await this.currentUserEmail()
            : undefined;
          const message = explainMetabaseError({
            status,
            method: error?.config?.method,
            url: error?.config?.url,
            data: error?.config?.data,
            responseData: error?.response?.data,
            user,
          });
          if (message && error instanceof Error) error.message = message;
        } else if (status && status >= 400 && error instanceof Error) {
          // Any other failure: keep axios' status line, add the request and
          // what Metabase said, so a bare «status code 400» explains itself.
          const detail = metabaseDetail((error as any)?.response?.data);
          const where = `${((error as any)?.config?.method || 'GET').toUpperCase()} ${(error as any)?.config?.url || '?'}`;
          error.message = `${error.message} (${where})${detail ? `. Metabase said: "${detail}"` : ''}`;
        }
        return Promise.reject(error);
      }
    );

  }

  private userEmailLookup?: Promise<string | undefined>;

  /**
   * The signed-in user's email, for permission errors. Read once per client; a
   * failure (the credential may be the problem) just leaves it out.
   */
  private currentUserEmail(): Promise<string | undefined> {
    if (!this.userEmailLookup) {
      this.userEmailLookup = this.axiosInstance
        .get('/api/user/current')
        .then((r) => r?.data?.email || r?.data?.common_name || undefined)
        .catch(() => undefined);
    }
    return this.userEmailLookup;
  }

  /**
   * Records an upstream failure with the credential kind that produced it, so a
   * report of "it returns 401" can be traced to which auth path is failing.
   * The credential itself is never logged — only which of the three was used.
   */
  private logUpstream(level: 'warn' | 'error', message: string, status: number) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      status,
      auth_mode: this.authMode,
    };
    console.error(JSON.stringify(entry));
    console.error(`${level.toUpperCase()}: ${message} (auth_mode=${this.authMode})`);
  }

  private logInfo(message: string, data?: unknown) {
    const logMessage = {
      timestamp: new Date().toISOString(),
      level: "info",
      message,
      data,
    };
    console.error(JSON.stringify(logMessage));
    console.error(`INFO: ${message}`);
  }

  private logError(message: string, error: unknown) {
    const errorObj = error as Error;
    const logMessage = {
      timestamp: new Date().toISOString(),
      level: "error",
      message,
      error: errorObj.message || "Unknown error",
      stack: errorObj.stack,
    };
    console.error(JSON.stringify(logMessage));
    console.error(`ERROR: ${message} - ${errorObj.message || "Unknown error"}`);
  }

  /**
   * Get Metabase session token for username/password authentication
   */
  private async getSessionToken(): Promise<string> {
    if (this.sessionToken) {
      return this.sessionToken;
    }

    this.logInfo("Authenticating with Metabase using username/password...");
    try {
      const response = await this.axiosInstance.post("/api/session", {
        username: this.config.username,
        password: this.config.password,
      });

      this.sessionToken = response.data.id;

      // Set default request headers
      this.axiosInstance.defaults.headers.common["X-Metabase-Session"] =
        this.sessionToken;

      this.logInfo("Successfully authenticated with Metabase");
      return this.sessionToken as string;
    } catch (error) {
      this.logError("Authentication failed", error);
      throw new McpError(
        ErrorCode.InternalError,
        "Failed to authenticate with Metabase"
      );
    }
  }

  /**
   * Ensure authentication is ready
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.config.apiKey) {
      await this.getSessionToken();
    }
  }

  // Dashboard operations
  async getDashboards(): Promise<Dashboard[]> {
    const response = await this.axiosInstance.get("/api/dashboard");
    return response.data;
  }

  async getDashboard(id: number): Promise<Dashboard> {
    const response = await this.axiosInstance.get(`/api/dashboard/${id}`);
    return response.data;
  }

  async createDashboard(dashboard: Partial<Dashboard>): Promise<Dashboard> {
    const response = await this.axiosInstance.post("/api/dashboard", dashboard);
    return response.data;
  }

  async updateDashboard(
    id: number,
    updates: Partial<Dashboard>
  ): Promise<Dashboard> {
    const response = await this.axiosInstance.put(
      `/api/dashboard/${id}`,
      updates
    );
    return response.data;
  }

  async deleteDashboard(
    id: number,
    hardDelete: boolean = false
  ): Promise<void> {
    if (hardDelete) {
      await this.axiosInstance.delete(`/api/dashboard/${id}`);
    } else {
      await this.axiosInstance.put(`/api/dashboard/${id}`, { archived: true });
    }
  }

  async getDashboardRelatedEntities(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/dashboard/${id}/related`);
    return response.data;
  }

  async getDashboardRevisions(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/revision/dashboard/${id}`);
    return response.data;
  }

  async getEmbeddableDashboards(): Promise<any> {
    const response = await this.axiosInstance.get('/api/dashboard/embeddable');
    return response.data;
  }

  async getPublicDashboards(): Promise<any> {
    const response = await this.axiosInstance.get('/api/dashboard/public');
    return response.data;
  }

  async createDashboardPublicLink(id: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/dashboard/${id}/public_link`);
    return response.data;
  }

  async deleteDashboardPublicLink(id: number): Promise<void> {
    await this.axiosInstance.delete(`/api/dashboard/${id}/public_link`);
  }

  async copyDashboard(fromId: number, copyData: any = {}): Promise<any> {
    const response = await this.axiosInstance.post(`/api/dashboard/${fromId}/copy`, copyData);
    return response.data;
  }

  // ── Safe dashboard writes ────────────────────────────────────────────────
  // PUT /api/dashboard/:id diffs what it receives against what is stored: a
  // dashcard missing from `dashcards` is DELETED, one with a negative id is
  // created, and tabs work the same way. Sending `dashcards` without `tabs`
  // deletes every tab. So every write that touches the layout goes through
  // putDashboardSafe, which keeps the stored tabs unless new ones are given.

  static readonly DASHCARD_FIELDS = [
    'id', 'card_id', 'dashboard_tab_id', 'row', 'col', 'size_x', 'size_y', 'series',
    'action_id', 'inline_parameters', 'parameter_mappings', 'visualization_settings',
  ] as const;

  /** Only the fields PUT /api/dashboard/:id accepts for a dashcard (no nested `card`, no read-only fields). */
  normalizeDashcard(dc: any): any {
    const out: any = {};
    for (const field of MetabaseClient.DASHCARD_FIELDS) {
      if (dc[field] !== undefined) out[field] = dc[field];
    }
    if (out.card_id === undefined) out.card_id = null; // text and heading cards
    out.series = out.series || [];
    out.parameter_mappings = out.parameter_mappings || [];
    out.visualization_settings = out.visualization_settings || {};
    return out;
  }

  private normalizeTab(tab: any): any {
    return { id: tab.id, name: tab.name };
  }

  /** The newest revision id of a dashboard, or null when it cannot be read. */
  private async latestRevisionId(dashboardId: number): Promise<number | null> {
    try {
      const revisions = await this.getDashboardRevisions(dashboardId);
      const list = Array.isArray(revisions) ? revisions : revisions?.data;
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.reduce((max: number, r: any) => (typeof r.id === 'number' && r.id > max ? r.id : max), -Infinity);
    } catch {
      return null;
    }
  }

  /**
   * Writes a dashboard without losing tabs or dashcards by accident.
   *
   * 1. Reads the dashboard.
   * 2. When the body brings `dashcards` but no `tabs`, sends the stored tabs.
   * 3. When there are tabs, refuses dashcards without a `dashboard_tab_id`, or
   *    pointing at a tab that is not in the list.
   * 4. Records the revision before the write, so it can be undone with
   *    revert_dashboard, and returns it with a summary of what changed. When
   *    the revisions cannot be read it still writes, with a warning.
   *
   * With `dryRun`, validates and returns the summary and the payload it would
   * send, without writing. `current` skips the GET when the caller already has it.
   */
  async putDashboardSafe(
    dashboardId: number,
    body: { dashcards?: any[]; tabs?: any[]; [key: string]: any },
    opts: { dryRun?: boolean; current?: any } = {},
  ): Promise<SafePutResult> {
    const current: any = opts.current ?? await this.getDashboard(dashboardId);
    const currentDashcards: any[] = current.dashcards || [];
    const currentTabs: any[] = current.tabs || [];

    const { dashcards, tabs, ...rest } = body;
    const payload: any = { ...rest };

    const nextTabs = (tabs ?? currentTabs).map((t: any) => this.normalizeTab(t));
    if (tabs !== undefined || dashcards !== undefined) payload.tabs = nextTabs;

    let nextDashcards: any[] | undefined;
    if (dashcards !== undefined) {
      nextDashcards = dashcards.map((dc: any) => this.normalizeDashcard(dc));
      if (nextTabs.length > 0) {
        const tabIds = new Set(nextTabs.map((t: any) => t.id));
        const tabList = nextTabs.map((t: any) => `${t.id} (${t.name})`).join(', ');
        for (const dc of nextDashcards) {
          if (dc.dashboard_tab_id === undefined || dc.dashboard_tab_id === null) {
            throw new Error(
              `Dashboard ${dashboardId} has tabs, so every dashcard needs dashboard_tab_id (dashcard ${dc.id} has none). Tabs: ${tabList}`
            );
          }
          if (!tabIds.has(dc.dashboard_tab_id)) {
            throw new Error(
              `Dashcard ${dc.id} points at tab ${dc.dashboard_tab_id}, which is not in the dashboard. Tabs: ${tabList}`
            );
          }
        }
      }
      payload.dashcards = nextDashcards;
    }

    const diffOf = (before: any[], after: any[] | undefined) => {
      if (after === undefined) return { added: 0, kept: before.length, removed: [] as number[] };
      const afterIds = new Set(after.filter((x) => x.id > 0).map((x) => x.id));
      return {
        added: after.filter((x) => !(x.id > 0)).length,
        kept: before.filter((x) => afterIds.has(x.id)).length,
        removed: before.filter((x) => !afterIds.has(x.id)).map((x) => x.id),
      };
    };

    const diff = {
      dashcards: diffOf(currentDashcards, nextDashcards),
      tabs: diffOf(currentTabs, payload.tabs),
    };

    if (opts.dryRun) {
      return { dashboard: null, previous_revision_id: null, diff, dry_run: true, payload };
    }

    const previous_revision_id = await this.latestRevisionId(dashboardId);
    const response = await this.axiosInstance.put(`/api/dashboard/${dashboardId}`, payload);
    const result: SafePutResult = { dashboard: response.data, previous_revision_id, diff };
    if (previous_revision_id === null) {
      result.warning = 'no se pudo leer la revisión previa; no habrá revert automático';
    }
    return result;
  }

  async addCardToDashboard(dashboardId: number, cardData: any): Promise<any> {
    const dashboard: any = await this.getDashboard(dashboardId);
    const existing: any[] = dashboard.dashcards || [];

    // id -1: a new dashcard, per Metabase's convention.
    const newDashcard: any = {
      id: -1,
      row: cardData.row !== undefined ? cardData.row : 0,
      col: cardData.col !== undefined ? cardData.col : 0,
      size_x: cardData.size_x || cardData.sizeX || 12,
      size_y: cardData.size_y || cardData.sizeY || 8,
      series: cardData.series || [],
      visualization_settings: cardData.visualization_settings || {},
      parameter_mappings: cardData.parameter_mappings || [],
    };
    // card_id stays null for text and heading cards.
    const cardId = cardData.cardId ?? cardData.card_id;
    if (cardId !== undefined) newDashcard.card_id = cardId;
    if (cardData.inline_parameters !== undefined) newDashcard.inline_parameters = cardData.inline_parameters;
    if (cardData.action_id !== undefined) newDashcard.action_id = cardData.action_id;

    // On a dashboard with tabs every dashcard needs one: without an explicit tab
    // it goes to the first. An explicit tab that does not exist still fails.
    const tabs = orderedTabs(dashboard.tabs);
    let placedInTab: any;
    if (cardData.dashboard_tab_id !== undefined && cardData.dashboard_tab_id !== null) {
      newDashcard.dashboard_tab_id = cardData.dashboard_tab_id;
    } else if (tabs.length > 0) {
      newDashcard.dashboard_tab_id = tabs[0].id;
      placedInTab = { id: tabs[0].id, name: tabs[0].name, defaulted: true };
    }

    const result: any = await this.putDashboardSafe(
      dashboardId,
      { dashcards: [...existing, newDashcard] },
      { current: dashboard },
    );
    if (newDashcard.dashboard_tab_id !== undefined) {
      const tab = tabs.find((t: any) => t.id === newDashcard.dashboard_tab_id);
      result.placed_in_tab = placedInTab ?? { id: newDashcard.dashboard_tab_id, name: tab?.name };
    }
    return result;
  }

  /**
   * Sets a dashboard's tabs: `tabs` is the full list in the desired order. A
   * tab without id (or with a negative one) is created; an existing tab missing
   * from the list is deleted.
   *
   * Dashcards are never deleted in passing: when a deleted tab holds any, the
   * call fails unless `moveCardsFromDeletedTo` names where they go (an id from
   * the new list, or a position in it). A dashboard without tabs that gets some
   * moves all its dashcards to the first one, as Metabase requires. Removing
   * every tab (back to a dashboard without tabs) needs `confirm`.
   */
  async manageDashboardTabs(
    dashboardId: number,
    tabs: { id?: number; name: string }[],
    opts: { moveCardsFromDeletedTo?: number; dryRun?: boolean; confirm?: boolean } = {},
  ): Promise<any> {
    const current: any = await this.getDashboard(dashboardId);
    const currentTabs = orderedTabs(current.tabs);
    const dashcards: any[] = current.dashcards || [];
    const nextTabs = resolveTabs(dashboardId, currentTabs, tabs);

    const keptIds = new Set(nextTabs.filter((t) => t.id > 0).map((t) => t.id));
    const deleted = currentTabs.filter((t: any) => !keptIds.has(t.id));
    const moved: { from_tab: { id: number; name: string } | null; to_tab: { id: number; name: string }; cards: number }[] = [];
    let nextDashcards = dashcards;

    if (nextTabs.length === 0) {
      if (currentTabs.length === 0) throw new Error(`Dashboard ${dashboardId} has no tabs and the list is empty: nothing to do`);
      if (!opts.confirm) {
        throw new Error(
          `Removing every tab turns dashboard ${dashboardId} back into one without tabs, with its ${dashcards.length} cards on a single page. Pass confirm: true to do it.`
        );
      }
      nextDashcards = dashcards.map((dc) => ({ ...dc, dashboard_tab_id: null }));
    } else if (currentTabs.length === 0) {
      const first = nextTabs[0];
      nextDashcards = dashcards.map((dc) => ({ ...dc, dashboard_tab_id: first.id }));
      if (dashcards.length) moved.push({ from_tab: null, to_tab: first, cards: dashcards.length });
    } else {
      const holding = deleted
        .map((t: any) => ({ tab: t, cards: dashcards.filter((dc) => dc.dashboard_tab_id === t.id).length }))
        .filter((h) => h.cards > 0);
      if (holding.length) {
        const dest = opts.moveCardsFromDeletedTo;
        if (dest === undefined) {
          const detail = holding.map((h) => `"${h.tab.name}" (${h.tab.id}) has ${h.cards} cards`).join('; ');
          throw new Error(
            `Deleting these tabs would delete their cards: ${detail}. Pass move_cards_from_deleted_to with a tab id from the new list or its position (0 = first).`
          );
        }
        const target =
          nextTabs.find((t) => t.id === dest) ??
          (Number.isInteger(dest) && dest >= 0 && dest < nextTabs.length ? nextTabs[dest] : undefined);
        if (!target) {
          throw new Error(`move_cards_from_deleted_to=${dest} is neither a tab id in the new list nor a position in it`);
        }
        const fromIds = new Set(holding.map((h) => h.tab.id));
        nextDashcards = dashcards.map((dc) => (fromIds.has(dc.dashboard_tab_id) ? { ...dc, dashboard_tab_id: target.id } : dc));
        for (const h of holding) moved.push({ from_tab: { id: h.tab.id, name: h.tab.name }, to_tab: target, cards: h.cards });
      }
    }

    const result: any = await this.putDashboardSafe(
      dashboardId,
      { tabs: nextTabs, dashcards: nextDashcards },
      { current, dryRun: opts.dryRun },
    );
    result.moved_cards = moved;
    result.deleted_tabs = deleted.map((t: any) => ({ id: t.id, name: t.name }));

    if (opts.dryRun) {
      result.tabs = nextTabs;
      return result;
    }
    // New tabs only get their real ids from Metabase: read them back.
    const after: any = await this.getDashboard(dashboardId);
    result.tabs = orderedTabs(after.tabs).map((t: any) => ({ id: t.id, name: t.name, position: t.position }));
    return result;
  }

  /**
   * Writes a dashboard's whole layout in one PUT: tabs, every dashcard and,
   * optionally, the filters and width. `dashcards` is the COMPLETE list: a
   * positive id keeps that dashcard, a negative one creates it, and a current
   * dashcard missing from the list is deleted, which needs `confirmRemovals`
   * (as does deleting a tab). Text and heading cards can be written short, as
   * {id, text, display: "text" | "heading", ...}.
   *
   * Everything is validated before writing: grid bounds (24 columns), tabs,
   * unique ids, text cards, and filter mappings against the filters that will
   * be in place. With `dryRun` it returns the diff, what would be removed and
   * the payload, without writing.
   */
  async putDashboardLayout(
    dashboardId: number,
    layout: { tabs?: { id?: number; name: string }[]; dashcards: any[]; parameters?: any[]; width?: 'fixed' | 'full' },
    opts: { dryRun?: boolean; confirmRemovals?: boolean } = {},
  ): Promise<any> {
    const current: any = await this.getDashboard(dashboardId);
    const currentTabs = orderedTabs(current.tabs);
    const currentDashcards: any[] = current.dashcards || [];

    const nextTabs = layout.tabs ? resolveTabs(dashboardId, currentTabs, layout.tabs) : currentTabs.map((t: any) => ({ id: t.id, name: t.name }));
    const tabIds = new Set(nextTabs.map((t: any) => t.id));
    const parameters: any[] = layout.parameters ?? current.parameters ?? [];
    const paramIds = new Set(parameters.map((p: any) => p.id));
    const currentDashcardIds = new Set(currentDashcards.map((dc) => dc.id));

    const errors: string[] = [];
    const seen = new Set<number>();
    const dashcards = layout.dashcards.map((raw: any) => expandTextCard(raw));

    for (const dc of dashcards) {
      const label = `dashcard ${dc.id}`;
      if (typeof dc.id !== 'number' || dc.id === 0) {
        errors.push(`${label}: id must be a positive (existing) or negative (new) number`);
        continue;
      }
      if (seen.has(dc.id)) errors.push(`${label}: id appears twice`);
      seen.add(dc.id);
      if (dc.id > 0 && !currentDashcardIds.has(dc.id)) {
        errors.push(`${label}: not on the dashboard (use a negative id for a new dashcard)`);
      }

      const { row, col, size_x, size_y } = dc;
      if (![row, col, size_x, size_y].every((n) => Number.isInteger(n))) {
        errors.push(`${label}: row, col, size_x and size_y are required integers`);
      } else {
        if (col < 0 || row < 0) errors.push(`${label}: row and col must be >= 0`);
        if (size_x < 1 || size_y < 1) errors.push(`${label}: size_x and size_y must be >= 1`);
        if (col + size_x > GRID_COLUMNS) errors.push(`${label}: col + size_x = ${col + size_x}, past the ${GRID_COLUMNS}-column grid`);
      }

      if (nextTabs.length > 0) {
        if (dc.dashboard_tab_id === undefined || dc.dashboard_tab_id === null) {
          errors.push(`${label}: needs dashboard_tab_id (tabs: ${tabList(nextTabs)})`);
        } else if (!tabIds.has(dc.dashboard_tab_id)) {
          errors.push(`${label}: tab ${dc.dashboard_tab_id} is not in the layout (tabs: ${tabList(nextTabs)})`);
        }
      }

      const isVirtual = dc.card_id === null || dc.card_id === undefined;
      if (isVirtual && !dc.visualization_settings?.virtual_card?.display) {
        errors.push(`${label}: a card without card_id needs visualization_settings.virtual_card.display (text, heading...), or use {text, display}`);
      }

      for (const m of dc.parameter_mappings || []) {
        if (!paramIds.has(m.parameter_id)) {
          errors.push(`${label}: maps filter "${m.parameter_id}", which is not among the dashboard filters (${[...paramIds].join(', ') || 'none'})`);
        }
        if (m.card_id !== dc.card_id) {
          errors.push(`${label}: mapping for "${m.parameter_id}" has card_id ${m.card_id}, but the dashcard shows card ${dc.card_id}`);
        }
      }
    }
    if (errors.length) {
      throw new Error(`Layout for dashboard ${dashboardId} is not valid:\n- ${errors.join('\n- ')}`);
    }

    const keptDashcards = new Set(dashcards.filter((dc) => dc.id > 0).map((dc) => dc.id));
    const removedDashcards = currentDashcards
      .filter((dc) => !keptDashcards.has(dc.id))
      .map((dc) => ({ id: dc.id, card_id: dc.card_id ?? null, name: dashcardLabel(dc), tab: dc.dashboard_tab_id ?? null }));
    const keptTabs = new Set(nextTabs.filter((t: any) => t.id > 0).map((t: any) => t.id));
    const removedTabs = currentTabs.filter((t: any) => !keptTabs.has(t.id)).map((t: any) => ({ id: t.id, name: t.name }));
    const removals = { dashcards: removedDashcards, tabs: removedTabs };
    const removesSomething = removedDashcards.length > 0 || removedTabs.length > 0;

    if (removesSomething && !opts.confirmRemovals && !opts.dryRun) {
      const parts = [
        ...removedDashcards.map((d) => `dashcard ${d.id} (${d.name})`),
        ...removedTabs.map((t) => `tab ${t.id} (${t.name})`),
      ];
      throw new Error(
        `This layout deletes ${parts.length} item(s) from dashboard ${dashboardId}: ${parts.join(', ')}. Pass confirm_removals: true to apply it, or include them in the layout.`
      );
    }

    const body: any = { tabs: nextTabs, dashcards };
    if (layout.parameters !== undefined) body.parameters = layout.parameters;
    if (layout.width !== undefined) body.width = layout.width;

    const result: any = await this.putDashboardSafe(dashboardId, body, { current, dryRun: opts.dryRun });
    result.removals = removals;
    if (opts.dryRun) {
      result.tabs = nextTabs;
      if (removesSomething) result.needs_confirm_removals = true;
      return result;
    }
    const after: any = await this.getDashboard(dashboardId);
    const afterTabs = orderedTabs(after.tabs);
    result.tabs = afterTabs.map((t: any) => ({ id: t.id, name: t.name, position: t.position }));
    result.dashcards = (after.dashcards || []).length;
    result.created = createdDashcardIds(nextTabs, afterTabs, dashcards, after.dashcards || []);
    return result;
  }

  /**
   * Sets a dashboard's filters and connects them to the variables of its native
   * cards. `parameters` is the full filter list; `mapByTag` says which variable
   * each filter feeds ({f_mes: 'p_mes'}). Every native card that has that
   * variable gets the mapping, unless `exclude` lists the pair. Mappings of
   * other filters are kept, except those pointing at a filter no longer in the
   * list, which Metabase would reject.
   *
   * The target has no third element: with {"stage-number": 0} Metabase 0.63
   * answers "invalid tuple size" for variables. Verified on 0.63: a
   * 'date/month-year' filter on a 'date' variable arrives as '2026-09-01', and a
   * 'string/=' static-list filter works on a 'text' variable.
   */
  async setDashboardFilters(
    dashboardId: number,
    parameters: any[],
    mapByTag: Record<string, string>,
    opts: { exclude?: { dashcard_id: number; parameter_id: string }[]; dryRun?: boolean } = {},
  ): Promise<any> {
    const current: any = await this.getDashboard(dashboardId);
    const dashcards: any[] = current.dashcards || [];
    const errors: string[] = [];

    const paramById = new Map<string, any>();
    for (const p of parameters) {
      if (!p?.id) errors.push('every filter needs an id');
      else if (paramById.has(p.id)) errors.push(`filter "${p.id}" appears twice`);
      else paramById.set(p.id, p);
    }
    for (const pid of Object.keys(mapByTag)) {
      if (!paramById.has(pid)) errors.push(`map_by_tag names filter "${pid}", which is not in parameters`);
    }
    const exclude = opts.exclude || [];
    for (const e of exclude) {
      if (!dashcards.some((dc) => dc.id === e.dashcard_id)) errors.push(`exclude names dashcard ${e.dashcard_id}, which is not on the dashboard`);
    }
    const excluded = (dcId: number, pid: string) => exclude.some((e) => e.dashcard_id === dcId && e.parameter_id === pid);
    const fail = (): never => {
      throw new Error(`Filters for dashboard ${dashboardId} are not valid:\n- ${errors.join('\n- ')}`);
    };
    // Wrong input fails before any card is fetched.
    if (errors.length) fail();

    // Each card's variables, from the GET when it embeds the card, else fetched once.
    const tagsByCard = new Map<number, Map<string, string> | null>();
    const variablesOf = async (dc: any): Promise<Map<string, string> | null> => {
      if (tagsByCard.has(dc.card_id)) return tagsByCard.get(dc.card_id)!;
      const dq = dc.card?.dataset_query ?? (await this.getCard(dc.card_id) as any).dataset_query;
      const native = nativeQueryOf(dq);
      const vars = native ? new Map(native.tags.map((t) => [t.name, t.type])) : null;
      tagsByCard.set(dc.card_id, vars);
      return vars;
    };

    const report: any[] = [];
    const mapped = new Set(Object.keys(mapByTag));
    const nextDashcards: any[] = [];
    let dropped = 0;

    for (const dc of dashcards) {
      const kept = (dc.parameter_mappings || []).filter((m: any) => {
        if (mapped.has(m.parameter_id)) return false; // replaced below
        if (!paramById.has(m.parameter_id)) { dropped++; return false; }
        return true;
      });
      if (dc.card_id === null || dc.card_id === undefined) {
        nextDashcards.push({ ...dc, parameter_mappings: kept });
        continue;
      }
      const vars = await variablesOf(dc);
      const entry: any = { dashcard_id: dc.id, card_id: dc.card_id, mapped: [], not_applicable: [], excluded: [] };
      const fresh: any[] = [];
      for (const [pid, tag] of Object.entries(mapByTag)) {
        if (excluded(dc.id, pid)) { entry.excluded.push(pid); continue; }
        const varType = vars?.get(tag);
        if (varType === undefined) { entry.not_applicable.push(pid); continue; }
        const filter = paramById.get(pid);
        const wants = filter ? variableTypeForFilter(String(filter.type || '')) : undefined;
        if (filter && wants !== varType) {
          errors.push(
            `filter "${pid}" (type ${filter.type}) cannot feed variable {{${tag}}} of card ${dc.card_id}, which is ${varType}${wants ? `; it needs a ${wants} variable` : ''}`
          );
          continue;
        }
        fresh.push({ parameter_id: pid, card_id: dc.card_id, target: ['variable', ['template-tag', tag]] });
        entry.mapped.push({ parameter_id: pid, tag });
      }
      if (!vars) entry.note = 'not a native question: only its existing mappings of other filters are kept';
      report.push(entry);
      nextDashcards.push({ ...dc, parameter_mappings: [...kept, ...fresh] });
    }

    if (errors.length) fail();

    const result: any = await this.putDashboardSafe(
      dashboardId,
      { parameters, dashcards: nextDashcards },
      { current, dryRun: opts.dryRun },
    );
    result.mappings = report;
    result.dropped_mappings = dropped;
    for (const pid of mapped) {
      if (!report.some((r) => r.mapped.some((m: any) => m.parameter_id === pid))) {
        (result.unmapped_filters ||= []).push(pid);
      }
    }
    return result;
  }

  /**
   * Runs every question of a dashboard the way the dashboard runs it: through
   * the dashcard endpoint, which applies that dashcard's filter mappings. Only
   * the filters given in `values` are sent. Text cards are skipped. Runs at
   * most `concurrency` (3) queries at a time, to go easy on the warehouse.
   *
   * Verified on 0.63: with target ['variable', ['template-tag', x]] and a
   * 'date/month-year' value '2026-12', the 16 cards of dashboard 621 ran
   * without error (13 empty, as expected for a month with no data).
   */
  async runDashcards(
    dashboardId: number,
    opts: { tab?: number | string; values?: Record<string, unknown>; concurrency?: number } = {},
  ): Promise<any> {
    const dashboard: any = await this.getDashboard(dashboardId);
    const tabs = orderedTabs(dashboard.tabs);
    const tabPos = new Map(tabs.map((t: any, i: number) => [t.id, i]));
    const tabName = new Map(tabs.map((t: any) => [t.id, t.name]));
    const filters = new Map<string, any>((dashboard.parameters || []).map((p: any) => [p.id, p]));
    const values = opts.values || {};

    const unknown = Object.keys(values).filter((id) => !filters.has(id));
    if (unknown.length) {
      throw new Error(`values names filters not on dashboard ${dashboardId}: ${unknown.join(', ')}. Filters: ${[...filters.keys()].join(', ') || 'none'}`);
    }

    let tabId: number | undefined;
    if (opts.tab !== undefined) {
      const match = tabs.find((t: any) => t.id === opts.tab || String(t.name).toLowerCase() === String(opts.tab).toLowerCase());
      if (!match) throw new Error(`Tab "${opts.tab}" is not in dashboard ${dashboardId}. Tabs: ${tabList(tabs)}`);
      tabId = match.id;
    }

    const toRun = (dashboard.dashcards || [])
      .filter((dc: any) => dc.card_id !== null && dc.card_id !== undefined)
      .filter((dc: any) => tabId === undefined || dc.dashboard_tab_id === tabId)
      .sort((a: any, b: any) =>
        (tabPos.get(a.dashboard_tab_id) ?? 0) - (tabPos.get(b.dashboard_tab_id) ?? 0) || a.row - b.row || a.col - b.col);

    const runOne = async (dc: any) => {
      const parameters = (dc.parameter_mappings || [])
        .filter((m: any) => m.parameter_id in values)
        .map((m: any) => {
          const filter = filters.get(m.parameter_id);
          return { id: m.parameter_id, type: filter.type, target: m.target, value: filterValue(filter.type, values[m.parameter_id]) };
        });
      const base: any = {
        tab: dc.dashboard_tab_id !== undefined && dc.dashboard_tab_id !== null ? tabName.get(dc.dashboard_tab_id) ?? dc.dashboard_tab_id : null,
        dashcard_id: dc.id,
        card_id: dc.card_id,
        name: dc.card?.name ?? null,
        display: dc.card?.display ?? null,
        hide_empty: Boolean(dc.visualization_settings?.['card.hide_empty']),
      };
      try {
        // Run the card's own query ad hoc (POST /api/dataset) with the values
        // the dashboard would send. The dashcard endpoint would also store them
        // as the user's «last used» filter values, so a check with a future
        // month left the real dashboard empty for that user.
        const card = dc.card?.dataset_query ? dc.card : await this.getCard(dc.card_id);
        const res = await this.axiosInstance.post('/api/dataset', { ...card.dataset_query, parameters });
        const data = res.data || {};
        if (data.status === 'failed' || data.error) {
          return { ...base, status: 'error', rows: 0, error: truncate(errorText(data.error ?? data)) };
        }
        const rows = Array.isArray(data.data?.rows) ? data.data.rows.length : (data.row_count ?? 0);
        const viz = validateVisualization(
          card.display ?? dc.card?.display,
          effectiveSettings(card.visualization_settings ?? dc.card?.visualization_settings, dc.visualization_settings),
          columnsOf(data),
        );
        const out: any = { ...base, rows };
        if (viz.errors.length) {
          out.status = 'chart_error';
          out.chart_errors = viz.errors;
        } else {
          out.status = rows === 0 ? 'empty' : 'ok';
        }
        if (viz.warnings.length) out.chart_warnings = viz.warnings;
        return out;
      } catch (err) {
        return { ...base, status: 'error', rows: 0, error: truncate(errorText(err)) };
      }
    };

    const results = await mapLimited(toRun, Math.max(1, Math.min(opts.concurrency ?? 3, 3)), runOne);
    const totals = { ok: 0, empty: 0, chart_errors: 0, errors: 0 };
    for (const r of results) {
      if (r.status === 'ok') totals.ok++;
      else if (r.status === 'empty') totals.empty++;
      else if (r.status === 'chart_error') totals.chart_errors++;
      else totals.errors++;
    }
    return {
      dashboard_id: dashboardId,
      values,
      totals,
      checks: 'Each query runs and its result fits the chart settings. The drawn chart is not inspected (Metabase 0.63 has no API to render a card as an image): look at doubtful cards in the browser. Nothing is saved as the user\'s filter values.',
      cards: results,
    };
  }

  /**
   * Runs a native query without saving it, sending filter values the way a
   * dashboard would. For SQL it builds an MBQL 5 query with a template tag per
   * {{variable}}; each value goes as a parameter whose type is `filterTypes`
   * for that variable (e.g. 'date/month-year', 'string/='), or the plain type of
   * the variable. Optional [[ ]] clauses whose variable gets no value drop out.
   * With `collection` it runs a MongoDB pipeline instead.
   *
   * Verified on 0.63: this MBQL 5 body with 'date/month-year' and 'string/='
   * parameters on date and text variables runs.
   */
  async testNativeQuery(
    databaseId: number,
    sql: string,
    opts: {
      templateTags?: Record<string, TagOverride>;
      values?: Record<string, unknown>;
      filterTypes?: Record<string, string>;
      collection?: string;
      limitRows?: number;
    } = {},
  ): Promise<any> {
    const limit = opts.limitRows ?? 20;
    const values = opts.values || {};
    let body: any;
    if (opts.collection) {
      if (Object.keys(values).length) throw new Error('values are not supported for MongoDB queries');
      body = { type: 'native', database: databaseId, native: { query: sql, collection: opts.collection }, parameters: [] };
    } else {
      const tags = buildTemplateTags(sql, 'test', opts.templateTags || {});
      const tagType = new Map(tags.map((t) => [t.name, t.type]));
      const parameters = Object.entries(values).map(([tag, value]) => {
        const varType = tagType.get(tag);
        if (!varType) throw new Error(`values names {{${tag}}}, which the query does not have`);
        const type = opts.filterTypes?.[tag] ?? DEFAULT_FILTER_TYPE[varType] ?? 'category';
        return { type, value: filterValue(type, value), target: ['variable', ['template-tag', tag]] };
      });
      body = {
        'lib/type': 'mbql/query',
        database: databaseId,
        stages: [{ 'lib/type': 'mbql.stage/native', native: sql, 'template-tags': tags }],
        parameters,
      };
    }

    try {
      const res = await this.axiosInstance.post('/api/dataset', body);
      const data = res.data || {};
      const nativeSql = data.data?.native_form?.query;
      if (data.status === 'failed' || data.error) {
        return { status: 'error', error: truncate(errorText(data.error ?? data), 1000), ...(nativeSql && { native_sql: nativeSql }) };
      }
      const rows: any[] = data.data?.rows || [];
      return {
        status: rows.length ? 'ok' : 'empty',
        columns: (data.data?.cols || []).map((c: any) => c.display_name || c.name),
        rows: rows.slice(0, limit),
        row_count: data.row_count ?? rows.length,
        truncated: rows.length > limit,
        ...(nativeSql && { native_sql: nativeSql }),
      };
    } catch (err) {
      return { status: 'error', error: truncate(errorText(err), 1000) };
    }
  }

  /** Replaces ALL dashcards: any existing dashcard missing from `cards` is deleted. */
  async updateDashboardCards(dashboardId: number, cards: any[]): Promise<any> {
    return this.putDashboardSafe(dashboardId, { dashcards: cards });
  }

  async updateDashcard(
    dashboardId: number,
    dashcardId: number,
    updates: any,
    opts: { replaceVisualizationSettings?: boolean } = {},
  ): Promise<any> {
    const dashboard: any = await this.getDashboard(dashboardId);
    const dashcards: any[] = dashboard.dashcards || [];
    if (!dashcards.some((dc) => dc.id === dashcardId)) {
      throw new Error(`Dashcard with id ${dashcardId} not found in dashboard ${dashboardId}`);
    }
    // The id cannot be changed through updates: that would delete the dashcard.
    // visualization_settings merge into the current ones unless asked to replace:
    // sending {text} to change a heading must not wipe virtual_card or the rest.
    const updated = dashcards.map((dc) => {
      if (dc.id !== dashcardId) return dc;
      const next = { ...dc, ...updates, id: dashcardId };
      if (updates?.visualization_settings && !opts.replaceVisualizationSettings) {
        next.visualization_settings = effectiveSettings(dc.visualization_settings, updates.visualization_settings);
      }
      return next;
    });
    return this.putDashboardSafe(dashboardId, { dashcards: updated });
  }

  async removeCardsFromDashboard(dashboardId: number, dashcardIds: number[]): Promise<any> {
    const dashboard: any = await this.getDashboard(dashboardId);
    const dashcards: any[] = dashboard.dashcards || [];
    const missing = dashcardIds.filter((id) => !dashcards.some((dc) => dc.id === id));
    if (missing.length) {
      throw new Error(`Dashcards ${missing.join(', ')} not found in dashboard ${dashboardId}`);
    }
    return this.putDashboardSafe(dashboardId, {
      dashcards: dashcards.filter((dc) => !dashcardIds.includes(dc.id)),
    });
  }

  async favoriteDashboard(id: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/dashboard/${id}/favorite`);
    return response.data;
  }

  async unfavoriteDashboard(id: number): Promise<any> {
    const response = await this.axiosInstance.delete(`/api/dashboard/${id}/favorite`);
    return response.data;
  }

  async revertDashboard(id: number, revisionId: number): Promise<any> {
    const response = await this.axiosInstance.post('/api/revision/revert', {
      entity: 'dashboard',
      id,
      revision_id: revisionId,
    });
    return response.data;
  }

  async saveDashboard(dashboard: any): Promise<any> {
    const response = await this.axiosInstance.post('/api/dashboard/save', dashboard);
    return response.data;
  }

  async saveDashboardToCollection(parentCollectionId: number, dashboard: any): Promise<any> {
    const response = await this.axiosInstance.post(`/api/dashboard/save/collection/${parentCollectionId}`, dashboard);
    return response.data;
  }

  // Card operations
  async getCards(options: { f?: string; model_id?: number } = {}): Promise<Card[]> {
    const params = new URLSearchParams();
    
    if (options.f !== undefined) {
      params.append('f', options.f);
    }
    if (options.model_id !== undefined) {
      params.append('model_id', options.model_id.toString());
    }
    
    const url = params.toString() ? `/api/card?${params.toString()}` : '/api/card';
    const response = await this.axiosInstance.get(url);
    return response.data;
  }

  async getCard(id: number): Promise<Card> {
    const response = await this.axiosInstance.get(`/api/card/${id}`);
    return response.data;
  }

  async createCard(card: Partial<Card>): Promise<Card> {
    const response = await this.axiosInstance.post("/api/card", card);
    return response.data;
  }

  /**
   * Replaces a native card's SQL, declaring a template tag for every {{variable}}
   * in it. Keeps the query's format: MBQL 5 (stages, tags as a list, what 0.63
   * returns) or legacy (native.query, tags as an object). Variables that already
   * had a tag keep it unless `templateTags` says otherwise.
   */
  async updateCardSql(
    id: number,
    sql: string,
    templateTags: Record<string, TagOverride> = {},
    otherUpdates: Record<string, any> = {},
  ): Promise<any> {
    if (otherUpdates.dataset_query !== undefined) {
      throw new Error('Pass either sql or updates.dataset_query, not both');
    }
    const card: any = await this.getCard(id);
    const native = nativeQueryOf(card.dataset_query);
    if (!native) throw new Error(`Card ${id} is not a native SQL question`);

    const tags = buildTemplateTags(sql, id, templateTags, native.tags);
    const datasetQuery = structuredClone(card.dataset_query);
    if (native.format === 'mbql5') {
      datasetQuery.stages[0].native = sql;
      datasetQuery.stages[0]['template-tags'] = tags;
    } else {
      datasetQuery.native.query = sql;
      datasetQuery.native['template-tags'] = tagObject(tags);
    }
    const response = await this.axiosInstance.put(`/api/card/${id}`, { ...otherUpdates, dataset_query: datasetQuery });
    return {
      card: response.data,
      template_tags: tags.map((t) => ({ name: t.name, type: t.type, id: t.id })),
      format: native.format,
    };
  }

  async updateCard(id: number, updates: Partial<Card>, queryParams?: any): Promise<Card> {
    let url = `/api/card/${id}`;
    
    if (queryParams && Object.keys(queryParams).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(queryParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, value.toString());
        }
      });
      url += `?${searchParams.toString()}`;
    }
    
    const response = await this.axiosInstance.put(url, updates);
    return response.data;
  }

  async deleteCard(id: number, hardDelete: boolean = false): Promise<void> {
    if (hardDelete) {
      await this.axiosInstance.delete(`/api/card/${id}`);
    } else {
      await this.axiosInstance.put(`/api/card/${id}`, { archived: true });
    }
  }

  async executeCard(id: number, options: { ignore_cache?: boolean; collection_preview?: boolean; dashboard_id?: number } = {}): Promise<QueryResult> {
    const requestBody: any = {
      ignore_cache: options.ignore_cache || false,
    };
    
    if (options.collection_preview !== undefined) {
      requestBody.collection_preview = options.collection_preview;
    }
    
    if (options.dashboard_id !== undefined) {
      requestBody.dashboard_id = options.dashboard_id;
    }

    const response = await this.axiosInstance.post(`/api/card/${id}/query`, requestBody);
    return response.data;
  }

  async moveCards(cardIds: number[], collectionId?: number, dashboardId?: number): Promise<any> {
    const data: any = { card_ids: cardIds };
    
    if (collectionId) {
      data.collection_id = collectionId;
    }
    if (dashboardId) {
      data.dashboard_id = dashboardId;
    }
    
    const response = await this.axiosInstance.post("/api/cards/move", data);
    return response.data;
  }

  // Card collection operations
  async moveCardsToCollection(cardIds: number[], collectionId?: number): Promise<any> {
    const requestBody: any = { card_ids: cardIds };
    
    if (collectionId !== undefined) {
      requestBody.collection_id = collectionId;
    }
    
    const response = await this.axiosInstance.post("/api/card/collections", requestBody);
    return response.data;
  }

  // Card embeddable operations
  async getEmbeddableCards(): Promise<any> {
    const response = await this.axiosInstance.get("/api/card/embeddable");
    return response.data;
  }

  // Card pivot query operations
  async executePivotCardQuery(cardId: number, parameters: any = {}): Promise<any> {
    const response = await this.axiosInstance.post(`/api/card/pivot/${cardId}/query`, parameters);
    return response.data;
  }

  // Card public operations
  async getPublicCards(): Promise<any> {
    const response = await this.axiosInstance.get("/api/card/public");
    return response.data;
  }

  // Card parameter operations
  async getCardParamValues(cardId: number, paramKey: string): Promise<any> {
    const response = await this.axiosInstance.get(`/api/card/${cardId}/params/${paramKey}/values`);
    return response.data;
  }

  async searchCardParamValues(cardId: number, paramKey: string, query: string): Promise<any> {
    const response = await this.axiosInstance.get(`/api/card/${cardId}/params/${paramKey}/search/${query}`);
    return response.data;
  }

  async getCardParamRemapping(cardId: number, paramKey: string, value: string): Promise<any> {
    const response = await this.axiosInstance.get(`/api/card/${cardId}/params/${paramKey}/remapping?value=${encodeURIComponent(value)}`);
    return response.data;
  }

  // Card public link operations
  async createCardPublicLink(cardId: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/card/${cardId}/public_link`);
    return response.data;
  }

  async deleteCardPublicLink(cardId: number): Promise<any> {
    await this.axiosInstance.delete(`/api/card/${cardId}/public_link`);
    return { success: true };
  }

  // Card query operations
  async executeCardQueryWithFormat(cardId: number, exportFormat: string, parameters: any = {}): Promise<any> {
    const response = await this.axiosInstance.post(`/api/card/${cardId}/query/${exportFormat}`, parameters);
    return response.data;
  }

  // Card copy operations
  async copyCard(cardId: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/card/${cardId}/copy`);
    return response.data;
  }

  // Card dashboard operations
  async getCardDashboards(cardId: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/card/${cardId}/dashboards`);
    return response.data;
  }

  // Card metadata operations
  async getCardQueryMetadata(cardId: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/card/${cardId}/query_metadata`);
    return response.data;
  }

  // Card series operations
  async getCardSeries(cardId: number, options: any = {}): Promise<any> {
    const params = new URLSearchParams();
    
    if (options.last_cursor !== undefined) {
      params.append('last_cursor', options.last_cursor.toString());
    }
    if (options.query !== undefined && options.query !== '') {
      params.append('query', options.query);
    }
    if (options.exclude_ids !== undefined && Array.isArray(options.exclude_ids)) {
      options.exclude_ids.forEach((id: number) => {
        params.append('exclude_ids', id.toString());
      });
    }
    
    const url = params.toString() ? `/api/card/${cardId}/series?${params.toString()}` : `/api/card/${cardId}/series`;
    const response = await this.axiosInstance.get(url);
    return response.data;
  }

  // Database operations
  async getDatabases(): Promise<Database[]> {
    const response = await this.axiosInstance.get("/api/database");
    return response.data;
  }

  async getDatabase(id: number): Promise<Database> {
    const response = await this.axiosInstance.get(`/api/database/${id}`);
    return response.data;
  }

  async createDatabase(payload: any): Promise<Database> {
    const response = await this.axiosInstance.post("/api/database", payload);
    return response.data;
  }

  async updateDatabase(id: number, updates: any): Promise<Database> {
    const response = await this.axiosInstance.put(`/api/database/${id}`, updates);
    return response.data;
  }

  async deleteDatabase(id: number): Promise<void> {
    await this.axiosInstance.delete(`/api/database/${id}`);
  }

  async validateDatabase(engine: string, details: any): Promise<any> {
    const response = await this.axiosInstance.post(`/api/database/validate`, { engine, details });
    return response.data;
  }

  async addSampleDatabase(): Promise<Database> {
    const response = await this.axiosInstance.post(`/api/database/sample_database`);
    return response.data;
  }

  async checkDatabaseHealth(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/database/${id}/healthcheck`);
    return response.data;
  }

  async getDatabaseMetadata(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/database/${id}/metadata`);
    return response.data;
  }

  async getDatabaseSchemas(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/database/${id}/schemas`);
    return response.data;
  }

  async getDatabaseSchema(id: number, schema: string): Promise<any> {
    const response = await this.axiosInstance.get(`/api/database/${id}/schema/${encodeURIComponent(schema)}`);
    return response.data;
  }

  async syncDatabaseSchema(id: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/database/${id}/sync_schema`);
    return response.data;
  }

  /**
   * Runs a native query. For a MongoDB database, `query` is the aggregation
   * pipeline as a JSON string and `collection` names the collection it runs on:
   * Metabase rejects a Mongo native query without it.
   */
  async executeQuery(
    databaseId: number,
    query: string,
    parameters: any[] = [],
    collection?: string
  ): Promise<QueryResult> {
    const native: Record<string, unknown> = {
      query: query,
      template_tags: {},
    };
    if (collection) native.collection = collection;
    const queryData = {
      type: "native",
      native,
      parameters: parameters,
      database: databaseId,
    };
    const response = await this.axiosInstance.post("/api/dataset", queryData);
    return response.data;
  }

  // Collection operations
  async getCollections(archived: boolean = false): Promise<Collection[]> {
    const params = archived ? { archived: true } : {};
    const response = await this.axiosInstance.get("/api/collection", {
      params,
    });
    return response.data;
  }

  async getCollection(id: number): Promise<Collection> {
    const response = await this.axiosInstance.get(`/api/collection/${id}`);
    return response.data;
  }

  async createCollection(collection: Partial<Collection>): Promise<Collection> {
    const response = await this.axiosInstance.post(
      "/api/collection",
      collection
    );
    return response.data;
  }

  async updateCollection(
    id: number,
    updates: Partial<Collection>
  ): Promise<Collection> {
    const response = await this.axiosInstance.put(
      `/api/collection/${id}`,
      updates
    );
    return response.data;
  }

  async deleteCollection(id: number): Promise<void> {
    await this.axiosInstance.delete(`/api/collection/${id}`);
  }

  // User operations
  async getUsers(includeDeactivated: boolean = false): Promise<User[]> {
    const params = includeDeactivated ? { include_deactivated: true } : {};
    const response = await this.axiosInstance.get("/api/user", { params });
    return response.data;
  }

  async getUser(id: number): Promise<User> {
    const response = await this.axiosInstance.get(`/api/user/${id}`);
    return response.data;
  }

  async createUser(user: Partial<User>): Promise<User> {
    const response = await this.axiosInstance.post("/api/user", user);
    return response.data;
  }

  async updateUser(id: number, updates: Partial<User>): Promise<User> {
    const response = await this.axiosInstance.put(`/api/user/${id}`, updates);
    return response.data;
  }

  async deleteUser(id: number): Promise<void> {
    await this.axiosInstance.delete(`/api/user/${id}`);
  }

  // Permission operations
  async getPermissionGroups(): Promise<PermissionGroup[]> {
    const response = await this.axiosInstance.get("/api/permissions/group");
    return response.data;
  }

  async createPermissionGroup(name: string): Promise<PermissionGroup> {
    const response = await this.axiosInstance.post("/api/permissions/group", {
      name,
    });
    return response.data;
  }

  async updatePermissionGroup(
    id: number,
    name: string
  ): Promise<PermissionGroup> {
    const response = await this.axiosInstance.put(
      `/api/permissions/group/${id}`,
      { name }
    );
    return response.data;
  }

  async deletePermissionGroup(id: number): Promise<void> {
    await this.axiosInstance.delete(`/api/permissions/group/${id}`);
  }

  // Activity operations
  async getMostRecentlyViewedDashboard(): Promise<any> {
    const response = await this.axiosInstance.get("/api/activity/most_recently_viewed_dashboard");
    return response.data;
  }

  async getPopularItems(): Promise<any> {
    const response = await this.axiosInstance.get("/api/activity/popular_items");
    return response.data;
  }

  async getRecentViews(): Promise<any> {
    const response = await this.axiosInstance.get("/api/activity/recent_views");
    return response.data;
  }

  async getRecents(context: string[], includeMetadata: boolean = false): Promise<any> {
    const params = new URLSearchParams();
    
    context.forEach(ctx => {
      params.append('context', ctx);
    });
    
    params.append('include_metadata', includeMetadata.toString());
    
    const response = await this.axiosInstance.get(`/api/activity/recents?${params.toString()}`);
    return response.data;
  }

  async postRecents(data: any): Promise<any> {
    const response = await this.axiosInstance.post("/api/activity/recents", data);
    return response.data;
  }

  async executeQueryExport(
    exportFormat: string,
    query: any,
    formatRows: boolean = false,
    pivotResults: boolean = false,
    visualizationSettings: any = {}
  ): Promise<any> {
    const data = {
      format_rows: formatRows,
      pivot_results: pivotResults,
      query,
      visualization_settings: visualizationSettings
    };
    
    const response = await this.axiosInstance.post(`/api/dataset/${exportFormat}`, data);
    return response.data;
  }

  // Table operations
  async getTables(ids?: number[]): Promise<any> {
    const params = ids ? { ids: ids.join(',') } : {};
    const response = await this.axiosInstance.get("/api/table", { params });
    return response.data;
  }

  async updateTables(ids: number[], updates: any): Promise<any> {
    const data = { ids, ...updates };
    const response = await this.axiosInstance.put("/api/table", data);
    return response.data;
  }

  async getCardTableFks(cardId: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/table/card__${cardId}/fks`);
    return response.data;
  }

  async getCardTableQueryMetadata(cardId: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/table/card__${cardId}/query_metadata`);
    return response.data;
  }

  async getTable(id: number, options: any = {}): Promise<any> {
    const params = new URLSearchParams();
    
    if (options.include_sensitive_fields !== undefined) {
      params.append('include_sensitive_fields', options.include_sensitive_fields.toString());
    }
    if (options.include_hidden_fields !== undefined) {
      params.append('include_hidden_fields', options.include_hidden_fields.toString());
    }
    if (options.include_editable_data_model !== undefined) {
      params.append('include_editable_data_model', options.include_editable_data_model.toString());
    }
    
    const url = params.toString() ? `/api/table/${id}?${params.toString()}` : `/api/table/${id}`;
    const response = await this.axiosInstance.get(url);
    return response.data;
  }

  async updateTable(id: number, updateData: any): Promise<any> {
    const response = await this.axiosInstance.put(`/api/table/${id}`, updateData);
    return response.data;
  }

  async appendCsvToTable(id: number, filename: string, fileContent: string): Promise<any> {
    const formData = new FormData();
    
    const blob = new Blob([fileContent], { type: 'text/csv' });
    formData.append('file', blob, filename);
    
    const response = await this.axiosInstance.post(`/api/table/${id}/append-csv`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  }

  async discardTableFieldValues(id: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/table/${id}/discard_values`);
    return response.data;
  }

  async reorderTableFields(id: number, fieldOrder: number[]): Promise<any> {
    const response = await this.axiosInstance.put(`/api/table/${id}/fields/order`, fieldOrder);
    return response.data;
  }

  async getTableFks(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/table/${id}/fks`);
    return response.data;
  }

  async getTableQueryMetadata(id: number, options: any = {}): Promise<any> {
    const params = new URLSearchParams();
    
    if (options.include_sensitive_fields !== undefined) {
      params.append('include_sensitive_fields', options.include_sensitive_fields.toString());
    }
    if (options.include_hidden_fields !== undefined) {
      params.append('include_hidden_fields', options.include_hidden_fields.toString());
    }
    if (options.include_editable_data_model !== undefined) {
      params.append('include_editable_data_model', options.include_editable_data_model.toString());
    }
    
    const url = params.toString() ? `/api/table/${id}/query_metadata?${params.toString()}` : `/api/table/${id}/query_metadata`;
    const response = await this.axiosInstance.get(url);
    return response.data;
  }

  async getFieldByName(tableId: number, columnName: string): Promise<any> {
    const metadata = await this.getTableQueryMetadata(tableId);
    const fields = metadata.fields || [];
    
    // Search by exact name match first, then display_name
    const lowerColumnName = columnName.toLowerCase();
    const field = fields.find((f: any) => 
      f.name?.toLowerCase() === lowerColumnName || 
      f.display_name?.toLowerCase() === lowerColumnName
    );
    
    if (!field) {
      // Provide helpful error with available field names
      const availableFields = fields.map((f: any) => f.name).slice(0, 20);
      throw new Error(
        `Field '${columnName}' not found in table ${tableId}. ` +
        `Available fields: ${availableFields.join(', ')}${fields.length > 20 ? '...' : ''}`
      );
    }
    
    return {
      field_id: field.id,
      name: field.name,
      display_name: field.display_name,
      base_type: field.base_type,
      semantic_type: field.semantic_type,
      table_id: tableId,
    };
  }

  async getTableRelated(id: number): Promise<any> {
    const response = await this.axiosInstance.get(`/api/table/${id}/related`);
    return response.data;
  }

  async replaceTableCsv(id: number, csvFile: string): Promise<any> {
    const formData = new FormData();
    formData.append('csv_file', csvFile);
    const response = await this.axiosInstance.post(`/api/table/${id}/replace-csv`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  }

  async rescanTableFieldValues(id: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/table/${id}/rescan_values`);
    return response.data;
  }

  async syncTableSchema(id: number): Promise<any> {
    const response = await this.axiosInstance.post(`/api/table/${id}/sync_schema`);
    return response.data;
  }

  async getTableData(tableId: number, limit?: number): Promise<any> {
    const params = new URLSearchParams();
    
    if (limit !== undefined) {
      params.append('limit', limit.toString());
    } else {
      params.append('limit', '1000');
    }
    
    const url = `/api/table/${tableId}/data?${params.toString()}`;
    const response = await this.axiosInstance.get(url);
    return response.data;
  }


  // Generic API method for other operations
  async apiCall(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    data?: any
  ): Promise<any> {
    const response = await this.axiosInstance.request({
      method,
      url: endpoint,
      data,
    });
    return response.data;
  }
}
