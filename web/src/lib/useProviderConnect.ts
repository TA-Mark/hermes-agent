// Provider connection state machine — CUSTOM (non-upstream), new file only.
//
// Ported from apps/desktop/src/store/onboarding.ts, reshaped as a React hook.
// Drives the 4 auth flows (device_code / pkce OAuth, external CLI, api_key,
// custom endpoint) for ProvidersPage. See apps/desktop-lite/CUSTOM_ROADMAP.md.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OAuthProvider,
  OAuthStartResponse,
} from "@/lib/api";
import {
  providerApi,
  validateProviderCredential,
  setModelWithKey,
} from "@/lib/providerApi";

const POLL_MS = 2000;

export type ConnectStatus =
  | { kind: "idle" }
  | { kind: "starting"; providerId: string }
  | { kind: "awaiting_user"; providerId: string; start: Extract<OAuthStartResponse, { flow: "pkce" }>; code: string }
  | { kind: "polling"; providerId: string; start: Extract<OAuthStartResponse, { flow: "device_code" }> }
  | { kind: "submitting"; providerId: string }
  | { kind: "external_pending"; providerId: string; cliCommand: string }
  | { kind: "success"; providerId: string }
  | { kind: "error"; message: string; providerId?: string };

// Open a URL in a new tab. Web has no Electron openExternal; use an anchor
// click (more reliable against popup blockers than window.open).
function openUrl(url: string) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

export function useProviderConnect(onConnected?: () => void) {
  const [status, setStatusRaw] = useState<ConnectStatus>({ kind: "idle" });
  const statusRef = useRef<ConnectStatus>(status);
  const setStatus = useCallback((next: ConnectStatus) => {
    statusRef.current = next;
    setStatusRaw(next);
  }, []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<string | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

  const pollSession = useCallback(
    async (providerId: string, sessionId: string) => {
      try {
        const r = await providerApi.pollOAuthSession(providerId, sessionId);
        if (r.status === "approved") {
          clearPoll();
          sessionRef.current = null;
          setStatus({ kind: "success", providerId });
          onConnected?.();
        } else if (r.status !== "pending") {
          clearPoll();
          sessionRef.current = null;
          setStatus({
            kind: "error",
            providerId,
            message: r.error_message || `Đăng nhập ${r.status}.`,
          });
        }
        // pending → keep polling
      } catch (e) {
        clearPoll();
        setStatus({
          kind: "error",
          providerId,
          message: `Poll lỗi: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [clearPoll, onConnected, setStatus],
  );

  const startConnect = useCallback(
    async (provider: OAuthProvider) => {
      clearPoll();
      if (provider.flow === "external") {
        setStatus({
          kind: "external_pending",
          providerId: provider.id,
          cliCommand: provider.cli_command,
        });
        return;
      }
      setStatus({ kind: "starting", providerId: provider.id });
      try {
        const start = await providerApi.startOAuthLogin(provider.id);
        sessionRef.current = start.session_id;
        if (start.flow === "pkce") {
          openUrl(start.auth_url);
          setStatus({ kind: "awaiting_user", providerId: provider.id, start, code: "" });
        } else {
          openUrl(start.verification_url);
          setStatus({ kind: "polling", providerId: provider.id, start });
          pollRef.current = setInterval(
            () => void pollSession(provider.id, start.session_id),
            POLL_MS,
          );
        }
      } catch (e) {
        setStatus({
          kind: "error",
          providerId: provider.id,
          message: `Không bắt đầu được đăng nhập: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [clearPoll, pollSession, setStatus],
  );

  const setCode = useCallback(
    (code: string) => {
      const s = statusRef.current;
      if (s.kind === "awaiting_user") setStatus({ ...s, code });
    },
    [setStatus],
  );

  const submitCode = useCallback(async () => {
    const s = statusRef.current;
    if (s.kind !== "awaiting_user" || !s.code.trim()) return;
    const providerId = s.providerId;
    setStatus({ kind: "submitting", providerId });
    try {
      const resp = await providerApi.submitOAuthCode(
        providerId,
        s.start.session_id,
        s.code.trim(),
      );
      if (resp.ok && resp.status === "approved") {
        setStatus({ kind: "success", providerId });
        onConnected?.();
      } else {
        setStatus({ kind: "error", providerId, message: resp.message || "Trao đổi token thất bại." });
      }
    } catch (e) {
      setStatus({
        kind: "error",
        providerId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [onConnected, setStatus]);

  // External CLI recheck: re-fetch model options; provider authenticated → done.
  const recheckExternal = useCallback(
    async (providerId: string) => {
      try {
        const opts = await providerApi.getProviderOptions();
        const p = (opts.providers || []).find(
          (x) => x.slug === providerId || x.slug.endsWith(providerId),
        );
        if (p?.authenticated) {
          setStatus({ kind: "success", providerId });
          onConnected?.();
        } else {
          setStatus({
            kind: "error",
            providerId,
            message: "Chưa thấy đăng nhập. Chạy lệnh CLI ở terminal rồi thử lại.",
          });
        }
      } catch (e) {
        setStatus({
          kind: "error",
          providerId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [onConnected, setStatus],
  );

  const saveApiKey = useCallback(
    async (keyEnv: string, value: string) => {
      await providerApi.setEnvVar(keyEnv, value.trim());
      onConnected?.();
    },
    [onConnected],
  );

  // Custom / local OpenAI-compatible endpoint: probe → discover model → set.
  // Ported from saveOnboardingLocalEndpoint (onboarding.ts:801).
  const saveCustomEndpoint = useCallback(
    async (baseUrl: string, apiKey: string): Promise<{ ok: boolean; message?: string; model?: string }> => {
      const url = baseUrl.trim();
      if (!url) return { ok: false, message: "Nhập endpoint URL trước." };
      const probe = await validateProviderCredential("OPENAI_BASE_URL", url, apiKey.trim());
      if (!probe.ok && probe.reachable) return { ok: false, message: probe.message };
      if (!probe.reachable) return { ok: false, message: probe.message || `Không kết nối được ${url}.` };
      const model = (probe.models?.[0] ?? "").trim();
      if (!model) return { ok: false, message: "Endpoint không liệt kê model nào ở /v1/models." };
      const res = await setModelWithKey({
        scope: "main",
        provider: "custom",
        model,
        base_url: url,
        api_key: apiKey.trim(),
      });
      if (!res.ok) return { ok: false, message: res.confirm_message || "Lưu model thất bại." };
      onConnected?.();
      return { ok: true, model };
    },
    [onConnected],
  );

  const disconnect = useCallback(
    async (provider: { id: string; authType?: string; keyEnv?: string }) => {
      if (provider.authType === "api_key" && provider.keyEnv) {
        await providerApi.deleteEnvVar(provider.keyEnv);
      } else {
        await providerApi.disconnectOAuthProvider(provider.id);
      }
      onConnected?.();
    },
    [onConnected],
  );

  const cancel = useCallback(async () => {
    clearPoll();
    const sid = sessionRef.current;
    sessionRef.current = null;
    if (sid) {
      try {
        await providerApi.cancelOAuthSession(sid);
      } catch {
        /* best-effort */
      }
    }
    setStatus({ kind: "idle" });
  }, [clearPoll, setStatus]);

  return {
    status,
    startConnect,
    setCode,
    submitCode,
    recheckExternal,
    saveApiKey,
    saveCustomEndpoint,
    disconnect,
    cancel,
  };
}
