// Provider connection API client — CUSTOM (non-upstream), new file only.
//
// Wrappers + extended types NOT present in lib/api.ts, kept here to keep the
// upstream-shared api.ts at zero edits (mirrors gitReviewApi.ts). Backs the
// full LLM/provider connection surface (ProvidersPage). Every endpoint already
// exists in hermes_cli/web_server.py — this is pure frontend. See
// apps/desktop-lite/CUSTOM_ROADMAP.md Phase 2.5.
//
// fetchJSON auto-injects the session token from window.__HERMES_SESSION_TOKEN__
// and handles 401, so we never touch tokens manually here.

import { fetchJSON, api } from "@/lib/api";

// ── Extended types (superset of api.ts's ModelOptionProvider) ───────────────
// api.ts's ModelOptionProvider omits auth_type + key_env; the backend
// (/api/model/options) returns them (web_server inventory.py). We parse them
// here without editing api.ts.
export interface ProviderOption {
  slug: string;
  name: string;
  models?: string[];
  total_models?: number;
  is_current?: boolean;
  authenticated?: boolean;
  auth_type?: string; // "api_key" | "oauth*" | "external" | ...
  key_env?: string; // e.g. "OPENROUTER_API_KEY"
  warning?: string;
}

export interface ModelOptionsRaw {
  model?: string;
  provider?: string;
  providers?: ProviderOption[];
}

export interface ValidateResult {
  ok: boolean;
  reachable: boolean;
  message: string;
  models?: string[];
}

export interface RecommendedDefault {
  provider: string;
  model: string;
  free_tier: boolean | null;
}

// ── Wrappers for endpoints api.ts doesn't cover ─────────────────────────────

// POST /api/providers/validate. For key === "OPENAI_BASE_URL" the backend
// probes <value>/models and returns discovered models[]; for keyed providers
// it returns {ok, reachable, message} only.
export function validateProviderCredential(
  key: string,
  value: string,
  apiKey = "",
): Promise<ValidateResult> {
  return fetchJSON<ValidateResult>("/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, api_key: apiKey }),
  });
}

// GET /api/model/recommended-default?provider=
export function getRecommendedDefault(provider: string): Promise<RecommendedDefault> {
  return fetchJSON<RecommendedDefault>(
    `/api/model/recommended-default?provider=${encodeURIComponent(provider)}`,
  );
}

// POST /api/model/set — built here (not api.setModelAssignment) because that
// wrapper's ModelAssignmentRequest type omits api_key, which custom/local
// endpoints require. Backend's ModelAssignment accepts it (web_server.py:942).
export interface SetModelBody {
  scope: "main" | "auxiliary";
  provider: string;
  model: string;
  base_url?: string;
  api_key?: string;
  task?: string;
  confirm_expensive_model?: boolean;
}

export function setModelWithKey(body: SetModelBody): Promise<{
  ok: boolean;
  confirm_required?: boolean;
  confirm_message?: string;
  provider?: string;
  model?: string;
}> {
  return fetchJSON("/api/model/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Raw /api/model/options (typed with auth_type + key_env, unlike api.getModelOptions).
export function getProviderOptions(): Promise<ModelOptionsRaw> {
  return fetchJSON<ModelOptionsRaw>("/api/model/options");
}

interface CustomProviderEntry {
  name?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
}

// Read the configured custom providers (name + base_url) so the UI can map a
// "custom:host" slug back to its base_url for disconnect.
export async function getConfigCustomProviders(): Promise<CustomProviderEntry[]> {
  const cfg = await fetchJSON<{ config?: Record<string, unknown> }>("/api/config");
  const list = (cfg.config?.custom_providers as CustomProviderEntry[] | undefined) ?? [];
  return Array.isArray(list) ? list : [];
}

// Remove a user-defined custom provider from config.yaml/custom_providers.
// There's no dedicated REST endpoint (backend's _remove_custom_provider is
// CLI-interactive only), so we read config, drop the matching entry by
// base_url, and write the filtered list back. _deep_merge replaces a list
// value wholesale (config.py:6128), so sending the filtered array replaces it.
export async function removeCustomProvider(baseUrl: string): Promise<{ ok: boolean }> {
  const cfg = await fetchJSON<{ config?: Record<string, unknown> }>("/api/config");
  const config = cfg.config ?? {};
  const list = (config.custom_providers as CustomProviderEntry[] | undefined) ?? [];
  const filtered = list.filter(
    (e) => (e.base_url || "").replace(/\/+$/, "") !== baseUrl.replace(/\/+$/, ""),
  );
  return fetchJSON<{ ok: boolean }>("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: { custom_providers: filtered } }),
  });
}

// ── Re-export the OAuth + env wrappers already in api.ts, so ProvidersPage
// imports everything provider-related from one module. ──────────────────────
export const providerApi = {
  getOAuthProviders: api.getOAuthProviders,
  startOAuthLogin: api.startOAuthLogin,
  submitOAuthCode: api.submitOAuthCode,
  pollOAuthSession: api.pollOAuthSession,
  cancelOAuthSession: api.cancelOAuthSession,
  disconnectOAuthProvider: api.disconnectOAuthProvider,
  setEnvVar: api.setEnvVar,
  deleteEnvVar: api.deleteEnvVar,
  getModelOptions: api.getModelOptions,
  // custom wrappers above
  validateProviderCredential,
  getRecommendedDefault,
  setModelWithKey,
  getProviderOptions,
  getConfigCustomProviders,
  removeCustomProvider,
};
