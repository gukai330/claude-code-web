import { useCallback, useEffect, useState } from 'react';
import { appUrl } from '../appUrl';
import { DEFAULT_SYNC_IGNORES, type SyncClientConfig, type SyncStatus } from '../types';
import { Icon } from './Icon';

type Props = {
  token: string;
  /** The folder on the server being set up — the one about to be opened. */
  cwd: string;
  onClose: () => void;
};

type Form = {
  user: string;
  host: string;
  port: string;
  localPath: string;
  syncOnSend: boolean;
  syncOnIdle: boolean;
};

const EMPTY: Form = { user: '', host: '', port: '', localPath: '', syncOnSend: true, syncOnIdle: true };

/**
 * Sets up two-way sync between a server folder and a folder on the machine
 * you are sitting at. The path you type here is a *client* path: the server
 * composes it with the shared connection below into a unison root, so a
 * reverse tunnel (localhost:2222) and a direct LAN address (192.168.0.30:22)
 * differ only in these fields.
 */
export function SyncFolderPanel({ token, cwd, onClose }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(appUrl(`/api/sync?t=${encodeURIComponent(token)}&cwd=${encodeURIComponent(cwd)}`));
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SyncStatus;
      setStatus(j);
      setForm({
        user: j.client?.user ?? '',
        host: j.client?.host ?? '',
        port: j.client?.port ? String(j.client.port) : '',
        localPath: j.config?.localPath ?? '',
        syncOnSend: j.config?.syncOnSend ?? true,
        syncOnIdle: j.config?.syncOnIdle ?? true,
      });
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, [cwd, token]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const host = form.host.trim();
      if (!host) throw new Error('The address of this computer is required');
      if (!form.localPath.trim()) throw new Error('The folder on this computer is required');
      const port = form.port.trim() ? Number(form.port.trim()) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error('Port must be a number between 1 and 65535');
      }

      // The connection is shared, so it is written first: a project entry with
      // a localPath and no connection cannot resolve.
      const client: SyncClientConfig = {
        host,
        ...(form.user.trim() ? { user: form.user.trim() } : {}),
        ...(port !== undefined ? { port } : {}),
      };
      const clientRes = await fetch(appUrl(`/api/sync/client?t=${encodeURIComponent(token)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client }),
      });
      if (!clientRes.ok) throw new Error(await readError(clientRes));

      const projectRes = await fetch(appUrl(`/api/sync/project?t=${encodeURIComponent(token)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cwd,
          localPath: form.localPath.trim(),
          // An explicit `remote` outranks localPath on the server, so leaving
          // one in place would silently ignore the path just typed here.
          remote: null,
          enabled: true,
          syncOnSend: form.syncOnSend,
          syncOnIdle: form.syncOnIdle,
          // Only seed the ignore list on first setup; never clobber an edited one.
          ...(status?.config?.ignore?.length ? {} : { ignore: DEFAULT_SYNC_IGNORES }),
        }),
      });
      if (!projectRes.ok) throw new Error(await readError(projectRes));
      setStatus((await projectRes.json()) as SyncStatus);
      setSaved(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(
        appUrl(`/api/sync/project?t=${encodeURIComponent(token)}&cwd=${encodeURIComponent(cwd)}`),
        { method: 'DELETE' }
      );
      if (!r.ok) throw new Error(await readError(r));
      setSaved(false);
      await load();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  const preview = previewRemote(form);

  return (
    <section className="mt-3 rounded-md border border-border-subtle bg-bg-base p-3">
      <header className="flex items-center gap-2">
        <Icon name="copy" size={15} className="shrink-0 text-accent" />
        <h3 className="text-sm font-medium text-text-primary">Keep this folder on your computer too</h3>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
          aria-label="Close sync setup"
          title="Close"
        >
          <Icon name="x" size={13} />
        </button>
      </header>

      <p className="mt-1 text-[11px] text-text-muted">
        Files are pulled from your computer before each message and pushed back when Claude finishes.
        Conflicts are reported, never overwritten.
      </p>

      {loading ? (
        <div className="mt-3 h-20 animate-pulse rounded bg-bg-raised" />
      ) : (
        <>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_84px] gap-2">
            <Field label="User on your computer" value={form.user} placeholder="gukai" onChange={(user) => setForm((f) => ({ ...f, user }))} />
            <Field label="Its address" value={form.host} placeholder="192.168.0.30 or localhost" onChange={(host) => setForm((f) => ({ ...f, host }))} />
            <Field label="SSH port" value={form.port} placeholder="22" onChange={(port) => setForm((f) => ({ ...f, port }))} />
          </div>

          <div className="mt-2">
            <Field
              label="Folder on your computer"
              value={form.localPath}
              placeholder="C:\\Users\\you\\projects\\foo"
              onChange={(localPath) => setForm((f) => ({ ...f, localPath }))}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Toggle label="Pull before each message" checked={form.syncOnSend} onChange={(syncOnSend) => setForm((f) => ({ ...f, syncOnSend }))} />
            <Toggle label="Push when Claude finishes" checked={form.syncOnIdle} onChange={(syncOnIdle) => setForm((f) => ({ ...f, syncOnIdle }))} />
          </div>

          {preview && (
            <div className="mt-2 truncate font-mono text-[10px] text-text-muted" title={preview}>
              → {preview}
            </div>
          )}

          {status && !status.unison.available && (
            <div className="mt-2 rounded border border-warning/25 bg-warning/10 p-2 text-[11px] text-warning">
              unison is not installed on the server, so sync cannot run yet.
              {status.unison.error ? ` (${status.unison.error})` : ''} It must also be installed on this
              computer, at a matching version.
            </div>
          )}
          {status?.configError && (
            <div className="mt-2 rounded border border-danger/25 bg-danger/10 p-2 text-[11px] text-danger">{status.configError}</div>
          )}
          {error && (
            <div className="mt-2 rounded border border-danger/25 bg-danger/10 p-2 text-[11px] text-danger">{error}</div>
          )}
          {saved && !error && (
            <div className="mt-2 rounded border border-success/25 bg-success/10 p-2 text-[11px] text-success">
              Saved. This folder will sync with {status?.remote ?? 'your computer'}.
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="h-7 rounded-sm bg-accent px-2.5 text-xs font-medium text-text-inverse hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-45 transition-colors duration-hover"
            >
              {saving ? 'Saving' : status?.configured ? 'Update' : 'Enable sync'}
            </button>
            {status?.configured && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={saving}
                className="h-7 rounded-sm border border-border-subtle px-2.5 text-xs text-text-secondary hover:border-danger/40 hover:text-danger disabled:opacity-45 transition-colors duration-hover"
              >
                Stop syncing
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Mirrors the server's composition so the UI can show it before saving. */
export function previewRemote(form: { user: string; host: string; localPath: string }): string | null {
  const host = form.host.trim();
  const path = form.localPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!host || !path) return null;
  const userAt = form.user.trim() ? `${form.user.trim()}@` : '';
  return `ssh://${userAt}${host}/${path.startsWith('/') ? path : `/${path}`}`;
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <label className="block min-w-0">
      <span className="block text-[10px] uppercase tracking-[.06em] font-semibold text-text-muted">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-border-subtle bg-bg-surface px-2 py-1 font-mono text-[11px] text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  );
}

async function readError(r: Response): Promise<string> {
  try {
    const parsed = (await r.json()) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? r.statusText;
  } catch {
    return r.statusText || 'Request failed';
  }
}
