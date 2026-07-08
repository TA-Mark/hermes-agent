// Providers page — CUSTOM (non-upstream), new file only.
//
// Full LLM/provider connection surface for the web dashboard: connect via
// OAuth (device_code / pkce), external CLI, API key, or a custom OpenAI-
// compatible endpoint; disconnect / rotate keys. Reaches parity with the
// Electron app's Settings→Providers. Backend endpoints all pre-exist. See
// apps/desktop-lite/CUSTOM_ROADMAP.md Phase 2.5.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Check } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { usePageHeader } from "@/contexts/usePageHeader";
import type { OAuthProvider } from "@/lib/api";
import { providerApi, type ProviderOption } from "@/lib/providerApi";
import { ConnectProviderDialog } from "@/pages/ProvidersPage.dialog";

// A merged view row: an OAuth-catalog provider and/or a model-options provider.
export interface MergedProvider {
  id: string;
  name: string;
  authType: string; // "oauth" | "api_key" | "external" | "custom"
  flow?: "pkce" | "device_code" | "external";
  cliCommand?: string;
  docsUrl?: string;
  keyEnv?: string;
  baseUrl?: string; // for user-defined custom providers
  connected: boolean;
  statusLabel?: string;
  oauth?: OAuthProvider;
}

function mergeProviders(
  oauth: OAuthProvider[],
  options: ProviderOption[],
  customs: { name?: string; base_url?: string }[],
): MergedProvider[] {
  const rows: MergedProvider[] = [];
  const seen = new Set<string>();

  // OAuth / external providers from the catalog.
  for (const p of oauth) {
    seen.add(p.id);
    rows.push({
      id: p.id,
      name: p.name,
      authType: p.flow === "external" ? "external" : "oauth",
      flow: p.flow,
      cliCommand: p.cli_command,
      docsUrl: p.docs_url,
      connected: !!p.status?.logged_in,
      statusLabel: p.status?.source_label || undefined,
      oauth: p,
    });
  }

  // Map a user-defined custom provider slug ("custom:api.xpiki.com") back to
  // its base_url from config, so disconnect can target the right entry.
  const baseUrlByName = new Map<string, string>();
  for (const c of customs) {
    if (c.name && c.base_url) baseUrlByName.set(c.name, c.base_url);
  }

  // API-key + custom providers from model options (skip catalog OAuth slugs).
  for (const o of options) {
    if (seen.has(o.slug)) continue;
    const isUserCustom = o.slug.startsWith("custom:");
    const authType = isUserCustom ? "custom" : o.auth_type || "api_key";
    // The bare "custom" skeleton row isn't a real connection — skip it.
    if (o.slug === "custom") continue;
    if (authType !== "api_key" && !isUserCustom) continue;
    rows.push({
      id: o.slug,
      name: o.name,
      authType,
      keyEnv: o.key_env,
      baseUrl: isUserCustom ? baseUrlByName.get(o.name) : undefined,
      connected: !!o.authenticated,
      statusLabel: o.is_current ? "current" : undefined,
    });
  }

  rows.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export default function ProvidersPage() {
  const navigate = useNavigate();
  const { setTitle } = usePageHeader();
  const [providers, setProviders] = useState<MergedProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<MergedProvider | null>(null);

  useEffect(() => {
    setTitle("Providers");
    return () => setTitle(null);
  }, [setTitle]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [oauthResp, opts, cfg] = await Promise.all([
        providerApi.getOAuthProviders(),
        providerApi.getProviderOptions(),
        providerApi.getConfigCustomProviders(),
      ]);
      setProviders(mergeProviders(oauthResp.providers || [], opts.providers || [], cfg));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const { connected, available } = useMemo(
    () => ({
      connected: providers.filter((p) => p.connected),
      available: providers.filter((p) => !p.connected),
    }),
    [providers],
  );

  const onDisconnect = useCallback(
    async (p: MergedProvider) => {
      if (!confirm(`Ngắt kết nối ${p.name}?`)) return;
      try {
        if (p.authType === "custom") {
          if (!p.baseUrl) throw new Error("Không xác định được base_url của provider custom");
          await providerApi.removeCustomProvider(p.baseUrl);
        } else if (p.authType === "api_key" && p.keyEnv) {
          await providerApi.deleteEnvVar(p.keyEnv);
        } else {
          await providerApi.disconnectOAuthProvider(p.id);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Button ghost size="sm" prefix={<RefreshCw />} onClick={() => void load()} disabled={loading}>
          Làm mới
        </Button>
        {loading && <Spinner className="size-4" />}
        <span className="ml-auto text-xs text-text-tertiary">
          Kết nối áp dụng trên máy chạy backend
        </span>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
      )}

      <ProviderSection
        title={`Đã kết nối (${connected.length})`}
        rows={connected}
        onConnect={setConnecting}
        onDisconnect={onDisconnect}
      />
      <ProviderSection
        title={`Có thể kết nối (${available.length})`}
        rows={available}
        onConnect={setConnecting}
        onDisconnect={onDisconnect}
      />

      {connecting && (
        <ConnectProviderDialog
          provider={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            void load();
          }}
          onGotoPicker={() => navigate("/")}
        />
      )}
    </div>
  );
}

function ProviderSection({
  title,
  rows,
  onConnect,
  onDisconnect,
}: {
  title: string;
  rows: MergedProvider[];
  onConnect: (p: MergedProvider) => void;
  onDisconnect: (p: MergedProvider) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 && (
          <div className="p-4 text-xs text-text-tertiary">Không có.</div>
        )}
        {rows.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              {p.connected && <Check className="size-4 shrink-0 text-success" />}
              <div className="min-w-0">
                <div className="truncate text-sm">{p.name}</div>
                <div className="truncate text-xs text-text-tertiary">
                  {p.authType}
                  {p.keyEnv ? ` · ${p.keyEnv}` : ""}
                  {p.statusLabel ? ` · ${p.statusLabel}` : ""}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              {p.connected ? (
                <Button ghost destructive size="sm" onClick={() => onDisconnect(p)}>
                  Ngắt
                </Button>
              ) : (
                <Button outlined size="sm" onClick={() => onConnect(p)}>
                  Kết nối
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
