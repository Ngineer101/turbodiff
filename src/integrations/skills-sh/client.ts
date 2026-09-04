import { isJsonArray, isJsonObject, isNumber, isString, type JsonValue } from '../../shared/json.ts';

// skills.sh catalog adapter. Endpoints, params, and response shapes below
// follow https://www.skills.sh/docs/api (verified against the published docs
// 2026-09-04): list endpoints wrap results as { data: [...] }, the
// leaderboard view is selected with ?view=, skill detail serves
// { hash, files: [{ path, contents }] | null }, and the audit endpoint
// returns { audits: [{ provider, status, ... }] } or 404 until the first
// audit exists. All egress to skills.sh happens through this Worker-side
// client — the browser only ever sees the normalized shapes below, and the
// bearer token (a Vercel OIDC token, per the docs) never leaves the server.
// The token is optional: an unconfigured client reports so and the routes
// fall back to GitHub-direct import.

const API = 'https://skills.sh/api/v1';

export class SkillsShApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SkillsShApiError';
  }
}

function apiUrl(path: string): string {
  const url = new URL(`${API}${path}`);
  if (url.origin !== 'https://skills.sh') {
    throw new Error(`refusing skills.sh API request to unexpected origin: ${url.origin}`);
  }
  return url.href;
}

export interface CatalogSkill {
  source: string; // "owner/repo"
  slug: string;
  name: string;
  description: string | null;
  installs: number | null;
}

export interface CatalogSkillDetail extends CatalogSkill {
  hash: string | null; // skills.sh snapshot sha-256
  files: { path: string; contents: string }[] | null;
}

export interface AuditVerdict {
  auditor: string;
  verdict: string;
}

export type CatalogSort = 'all-time' | 'trending' | 'hot';

export interface SkillsShClient {
  configured(): boolean;
  search(q: string, limit?: number): Promise<CatalogSkill[]>;
  leaderboard(sort: CatalogSort): Promise<CatalogSkill[]>;
  detail(source: string, slug: string): Promise<CatalogSkillDetail>;
  // null when the skill has no audit yet (the API 404s until the first one).
  audit(source: string, slug: string): Promise<AuditVerdict[] | null>;
}

// Defensive normalization: pluck only the fields we use and tolerate
// missing or extra ones, so upstream response drift degrades to nulls
// instead of crashing the proxy.
function catalogSkill(value: JsonValue): CatalogSkill | null {
  if (!isJsonObject(value)) return null;
  const source = isString(value.source) ? value.source : null;
  const slug = isString(value.slug) ? value.slug : null;
  if (!source || !slug) return null;
  return {
    source,
    slug,
    name: isString(value.name) && value.name ? value.name : slug,
    description: isString(value.description) ? value.description : null,
    installs: isNumber(value.installs) ? value.installs : null,
  };
}

function catalogSkills(value: JsonValue): CatalogSkill[] {
  // The documented list envelope is { data: [...] }; tolerate a bare array.
  const list = isJsonObject(value) && isJsonArray(value.data) ? value.data : isJsonArray(value) ? value : [];
  return list.map(catalogSkill).filter((s): s is CatalogSkill => s !== null);
}

function skillFiles(value: JsonValue): { path: string; contents: string }[] | null {
  if (!isJsonArray(value)) return null;
  const files: { path: string; contents: string }[] = [];
  for (const entry of value) {
    if (isJsonObject(entry) && isString(entry.path) && isString(entry.contents)) {
      files.push({ path: entry.path, contents: entry.contents });
    }
  }
  return files;
}

export function createSkillsShClient(token: string | undefined): SkillsShClient {
  async function request(path: string): Promise<Response> {
    if (!token) throw new Error('skills.sh API token is not configured');
    const response = await fetch(apiUrl(path), {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'turbodiff',
      },
    });
    if (!response.ok) {
      throw new SkillsShApiError(
        response.status,
        `skills.sh API ${response.status} on ${path}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    return response;
  }

  async function requestJson(path: string): Promise<JsonValue> {
    // SAFETY: request() has rejected non-2xx responses; the catalog API
    // serves JSON, and the normalizers below re-check every field anyway.
    return (await request(path)).json() as Promise<JsonValue>;
  }

  return {
    configured: () => Boolean(token),

    async search(q, limit = 30) {
      const payload = await requestJson(
        `/skills/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      );
      return catalogSkills(payload);
    },

    async leaderboard(sort) {
      const payload = await requestJson(`/skills?view=${encodeURIComponent(sort)}`);
      return catalogSkills(payload);
    },

    async detail(source, slug) {
      const payload = await requestJson(`/skills/${source}/${encodeURIComponent(slug)}`);
      const base = catalogSkill(isJsonObject(payload) && isJsonObject(payload.skill) ? payload.skill : payload);
      if (!base) {
        throw new SkillsShApiError(502, `skills.sh returned an unrecognized skill shape for ${source}/${slug}`);
      }
      const body = isJsonObject(payload) ? payload : {};
      return {
        ...base,
        hash: isString(body.hash) ? body.hash : null,
        files: skillFiles(body.files ?? null),
      };
    },

    async audit(source, slug) {
      let payload: JsonValue;
      try {
        payload = await requestJson(`/skills/audit/${source}/${encodeURIComponent(slug)}`);
      } catch (err) {
        // The audit endpoint 404s until a skill's first audit exists.
        if (err instanceof SkillsShApiError && err.status === 404) return null;
        throw err;
      }
      const list = isJsonArray(payload)
        ? payload
        : isJsonObject(payload) && isJsonArray(payload.audits)
          ? payload.audits
          : [];
      const verdicts: AuditVerdict[] = [];
      for (const entry of list) {
        if (!isJsonObject(entry)) continue;
        // Documented audit rows carry { provider, status: "pass" | "warn" | "fail" }.
        const auditor = isString(entry.provider) ? entry.provider : isString(entry.auditor) ? entry.auditor : null;
        const verdict = isString(entry.status) ? entry.status : isString(entry.verdict) ? entry.verdict : null;
        if (auditor && verdict) verdicts.push({ auditor, verdict });
      }
      return verdicts;
    },
  };
}
