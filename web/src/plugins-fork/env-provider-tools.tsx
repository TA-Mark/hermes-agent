// Env-page provider tools — CUSTOM (non-upstream), fork-owned.
//
// Merges the useful-but-unique bits of the removed /providers page into the
// Keys tab (/env) WITHOUT editing the upstream EnvPage.tsx: it renders into the
// `env:bottom` PluginSlot (EnvPage.tsx already hosts it) via registerSlot at the
// bottom of this file. main.tsx imports this module once so the registration
// runs before first paint.
//
// Two capabilities the raw env-var rows in EnvPage don't have:
//   1. Test an API key live before saving — POST /api/providers/validate.
//      Backend only probes 4 keys (OPENROUTER/OPENAI/XAI/GEMINI); others return
//      {reachable:false} → "can't verify" rather than a hard fail.
//   2. Connect a custom OpenAI-compatible endpoint — probe /v1/models, auto-pick
//      the first model, and set it as the main model (base_url + api_key).
//
// Strings are hardcoded Vietnamese, matching the existing custom pages' i18n
// convention (adding required keys to types.ts would force all 16 locale files).

import { useState } from "react";
import { KeyRound, Zap, Check, X, AlertTriangle } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { registerSlot } from "@/plugins";
import { api } from "@/lib/api";
import { validateProviderCredential, setModelWithKey } from "@/lib/providerApi";

// The 4 providers the backend can actually live-probe (_CREDENTIAL_PROBES in
// web_server.py). Keeping this list in sync with the backend is intentional —
// offering "Test key" for a provider the backend can't probe would always
// return "can't verify", which is worse than not offering it.
const TESTABLE_PROVIDERS: { keyEnv: string; label: string }[] = [
  { keyEnv: "OPENROUTER_API_KEY", label: "OpenRouter" },
  { keyEnv: "OPENAI_API_KEY", label: "OpenAI" },
  { keyEnv: "XAI_API_KEY", label: "xAI" },
  { keyEnv: "GEMINI_API_KEY", label: "Gemini" },
];

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "valid" }
  | { kind: "rejected"; message: string }
  | { kind: "unreachable"; message: string };

function TestKeyCard() {
  const [keyEnv, setKeyEnv] = useState(TESTABLE_PROVIDERS[0].keyEnv);
  const [value, setValue] = useState("");
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const runTest = async () => {
    const v = value.trim();
    if (!v) return;
    setTest({ kind: "testing" });
    try {
      const r = await validateProviderCredential(keyEnv, v);
      if (r.ok) {
        setTest({ kind: "valid" });
      } else if (r.reachable) {
        setTest({ kind: "rejected", message: r.message || "Key bị từ chối." });
      } else {
        setTest({
          kind: "unreachable",
          message: r.message || "Không kiểm tra được (không kết nối được provider).",
        });
      }
    } catch (e) {
      setTest({
        kind: "unreachable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const save = async () => {
    const v = value.trim();
    if (!v) return;
    setSaving(true);
    setSaved(false);
    try {
      await api.setEnvVar(keyEnv, v);
      setSaved(true);
      setValue("");
      setTest({ kind: "idle" });
    } catch {
      // Non-fatal; the row in the provider groups above still lets them retry.
      setTest({ kind: "unreachable", message: "Lưu key thất bại." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Kiểm tra &amp; lưu API key</CardTitle>
        </div>
        <CardDescription>
          Kiểm tra key còn sống trước khi lưu. Hỗ trợ 4 provider: OpenRouter, OpenAI, xAI, Gemini.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3 pt-4">
        <div className="grid gap-2">
          <Label htmlFor="fork-test-provider">Provider</Label>
          <Select
            id="fork-test-provider"
            value={keyEnv}
            onValueChange={(v) => {
              setKeyEnv(v);
              setTest({ kind: "idle" });
              setSaved(false);
            }}
          >
            {TESTABLE_PROVIDERS.map((p) => (
              <SelectOption key={p.keyEnv} value={p.keyEnv}>
                {p.label} · {p.keyEnv}
              </SelectOption>
            ))}
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="fork-test-key">API key</Label>
          <Input
            id="fork-test-key"
            type="password"
            placeholder="sk-…"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTest({ kind: "idle" });
              setSaved(false);
            }}
            className="font-mono-ui text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            outlined
            size="sm"
            disabled={!value.trim() || test.kind === "testing"}
            onClick={() => void runTest()}
          >
            {test.kind === "testing" ? <Spinner className="size-4" /> : "Kiểm tra key"}
          </Button>
          <Button size="sm" disabled={!value.trim() || saving} onClick={() => void save()}>
            {saving ? <Spinner className="size-4" /> : "Lưu key"}
          </Button>

          {test.kind === "valid" && (
            <Badge tone="success" className="gap-1">
              <Check className="size-3" /> Key hợp lệ
            </Badge>
          )}
          {test.kind === "rejected" && (
            <Badge tone="destructive" className="gap-1">
              <X className="size-3" /> Bị từ chối
            </Badge>
          )}
          {test.kind === "unreachable" && (
            <Badge tone="outline" className="gap-1">
              <AlertTriangle className="size-3" /> Không kiểm tra được
            </Badge>
          )}
          {saved && (
            <Badge tone="success" className="gap-1">
              <Check className="size-3" /> Đã lưu
            </Badge>
          )}
        </div>

        {(test.kind === "rejected" || test.kind === "unreachable") && (
          <p className="text-xs text-text-tertiary">{test.message}</p>
        )}
      </CardContent>
    </Card>
  );
}

function CustomEndpointCard() {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const connect = async () => {
    const base = url.trim();
    if (!base) return;
    setBusy(true);
    setMsg(null);
    try {
      const probe = await validateProviderCredential("OPENAI_BASE_URL", base, key.trim());
      if (!probe.reachable) {
        setMsg({ tone: "err", text: probe.message || `Không kết nối được ${base}.` });
        return;
      }
      const model = (probe.models?.[0] ?? "").trim();
      if (!model) {
        setMsg({ tone: "err", text: "Endpoint không liệt kê model nào ở /v1/models." });
        return;
      }
      const res = await setModelWithKey({
        scope: "main",
        provider: "custom",
        model,
        base_url: base,
        api_key: key.trim(),
      });
      if (!res.ok) {
        setMsg({ tone: "err", text: res.confirm_message || "Lưu model thất bại." });
        return;
      }
      setMsg({ tone: "ok", text: `Đã kết nối. Model: ${model}` });
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Custom OpenAI-compatible endpoint</CardTitle>
        </div>
        <CardDescription>
          Probe <code>/v1/models</code> để lấy model rồi đặt làm model chính.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3 pt-4">
        <div className="grid gap-2">
          <Label htmlFor="fork-custom-url">Base URL</Label>
          <Input
            id="fork-custom-url"
            placeholder="https://api.example.com/v1"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setMsg(null);
            }}
            className="font-mono-ui text-xs"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="fork-custom-key">API key (tùy chọn)</Label>
          <Input
            id="fork-custom-key"
            type="password"
            placeholder="sk-…"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setMsg(null);
            }}
            className="font-mono-ui text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button disabled={!url.trim() || busy} onClick={() => void connect()}>
            {busy ? <Spinner className="size-4" /> : "Probe & Kết nối"}
          </Button>
        </div>

        {msg && (
          <p
            className={
              msg.tone === "ok"
                ? "text-xs text-success"
                : "text-xs text-destructive"
            }
          >
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function EnvProviderTools() {
  return (
    <div className="grid gap-6">
      <TestKeyCard />
      <CustomEndpointCard />
    </div>
  );
}

registerSlot("fork-env-provider-tools", "env:bottom", EnvProviderTools);
