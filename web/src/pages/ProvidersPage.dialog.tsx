// Connect-provider dialog — CUSTOM (non-upstream), new file only.
// Renders the right connection UI per auth flow. Companion to ProvidersPage.tsx.

import { useState } from "react";
import { createPortal } from "react-dom";
import { X, ExternalLink, Copy } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { useProviderConnect } from "@/lib/useProviderConnect";
import type { MergedProvider } from "@/pages/ProvidersPage";

interface Props {
  provider: MergedProvider;
  onClose: () => void;
  onConnected: () => void;
  onGotoPicker: () => void;
}

export function ConnectProviderDialog({ provider, onClose, onConnected, onGotoPicker }: Props) {
  const conn = useProviderConnect(onConnected);
  const isCustom = provider.id.startsWith("custom") || provider.authType === "custom";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg border border-border bg-card shadow-2xl">
        <Button
          ghost
          size="icon"
          onClick={onClose}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X />
        </Button>
        <header className="border-b border-border p-5 pb-3">
          <h2 className="text-base tracking-wider">Kết nối {provider.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{provider.authType}</p>
        </header>

        <div className="p-5">
          {isCustom ? (
            <CustomEndpointForm conn={conn} onDone={onConnected} />
          ) : provider.authType === "api_key" ? (
            <ApiKeyForm provider={provider} conn={conn} onDone={onConnected} />
          ) : (
            <OAuthFlow provider={provider} conn={conn} onGotoPicker={onGotoPicker} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Conn = ReturnType<typeof useProviderConnect>;

function ErrorLine({ conn }: { conn: Conn }) {
  if (conn.status.kind !== "error") return null;
  return <div className="mt-3 rounded bg-destructive/10 p-2 text-xs text-destructive">{conn.status.message}</div>;
}

function CustomEndpointForm({ conn, onDone }: { conn: Conn; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await conn.saveCustomEndpoint(url, key);
      if (r.ok) {
        setMsg(`Đã kết nối. Model: ${r.model}`);
        onDone();
      } else {
        setMsg(r.message || "Thất bại.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-tertiary">
        Endpoint OpenAI-compatible. Sẽ probe <code>/v1/models</code> để lấy model.
      </p>
      <label className="text-xs">Base URL</label>
      <Input
        placeholder="https://api.example.com/v1"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <label className="text-xs">API key (tùy chọn)</label>
      <Input type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
      <Button disabled={busy || !url.trim()} onClick={() => void save()}>
        {busy ? <Spinner /> : "Probe & Kết nối"}
      </Button>
      {msg && <div className="text-xs text-text-secondary">{msg}</div>}
    </div>
  );
}

function ApiKeyForm({
  provider,
  conn,
  onDone,
}: {
  provider: MergedProvider;
  conn: Conn;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const keyEnv = provider.keyEnv || `${provider.id.toUpperCase()}_API_KEY`;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await conn.saveApiKey(keyEnv, value);
      setMsg("Đã lưu key.");
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs">
        API key → <code>{keyEnv}</code>
      </label>
      <Input type="password" placeholder="sk-…" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button disabled={busy || !value.trim()} onClick={() => void save()}>
        {busy ? <Spinner /> : "Lưu key"}
      </Button>
      {msg && <div className="text-xs text-text-secondary">{msg}</div>}
    </div>
  );
}

function OAuthFlow({
  provider,
  conn,
  onGotoPicker,
}: {
  provider: MergedProvider;
  conn: Conn;
  onGotoPicker: () => void;
}) {
  const s = conn.status;

  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  const start = () => {
    if (provider.oauth) void conn.startConnect(provider.oauth);
  };

  return (
    <div className="flex flex-col gap-3">
      {s.kind === "idle" && (
        <>
          {provider.flow === "external" ? (
            <p className="text-xs text-text-tertiary">
              Provider này đăng nhập qua CLI. Bấm bắt đầu để xem lệnh.
            </p>
          ) : (
            <p className="text-xs text-text-tertiary">
              Bấm để mở trang đăng nhập trong tab mới.
            </p>
          )}
          <Button onClick={start}>Bắt đầu đăng nhập</Button>
        </>
      )}

      {s.kind === "starting" && (
        <div className="flex items-center gap-2 text-sm">
          <Spinner /> Đang khởi tạo…
        </div>
      )}

      {s.kind === "polling" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-tertiary">
            Nhập mã này ở trang đã mở, rồi chờ xác nhận:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted/40 p-2 text-center text-lg tracking-widest">
              {s.start.user_code}
            </code>
            <Button ghost size="icon" onClick={() => copy(s.start.user_code)} aria-label="Copy">
              <Copy />
            </Button>
          </div>
          <a
            href={s.start.verification_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary"
          >
            <ExternalLink className="size-3" /> Mở lại trang đăng nhập
          </a>
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <Spinner className="size-3" /> Đang chờ xác nhận…
          </div>
          <Button ghost size="sm" onClick={() => void conn.cancel()}>
            Hủy
          </Button>
        </div>
      )}

      {s.kind === "awaiting_user" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-tertiary">
            Đăng nhập ở tab đã mở, dán code trả về vào đây:
          </p>
          <a
            href={s.start.auth_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary"
          >
            <ExternalLink className="size-3" /> Mở lại trang đăng nhập
          </a>
          <Input
            placeholder="Dán authorization code"
            value={s.code}
            onChange={(e) => conn.setCode(e.target.value)}
          />
          <Button disabled={!s.code.trim()} onClick={() => void conn.submitCode()}>
            Gửi code
          </Button>
          <Button ghost size="sm" onClick={() => void conn.cancel()}>
            Hủy
          </Button>
        </div>
      )}

      {s.kind === "submitting" && (
        <div className="flex items-center gap-2 text-sm">
          <Spinner /> Đang trao đổi token…
        </div>
      )}

      {s.kind === "external_pending" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-tertiary">
            Chạy lệnh này trong terminal, rồi bấm "Tôi đã đăng nhập":
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted/40 p-2 text-xs">{s.cliCommand}</code>
            <Button ghost size="icon" onClick={() => copy(s.cliCommand)} aria-label="Copy">
              <Copy />
            </Button>
          </div>
          <Button onClick={() => void conn.recheckExternal(provider.id)}>Tôi đã đăng nhập</Button>
        </div>
      )}

      {s.kind === "success" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-success">Đã kết nối {provider.name}.</p>
          <Button outlined size="sm" onClick={onGotoPicker}>
            Chọn model
          </Button>
        </div>
      )}

      <ErrorLine conn={conn} />
    </div>
  );
}
