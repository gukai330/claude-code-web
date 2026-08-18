import { useCallback, useEffect, useState } from 'react';
import { appUrl } from '../appUrl';
import { DEFAULT_SYNC_IGNORES, type SyncClientConfig, type SyncResult, type SyncStatus } from '../types';
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

/** The connect command in the README opens `-R 2222:127.0.0.1:22`, so from the
 *  server this machine is reachable at localhost:2222. Defaulting to it means
 *  the common setup needs no address typed at all. */
const DEFAULT_TUNNEL_HOST = 'localhost';
const DEFAULT_TUNNEL_PORT = '2222';

const EMPTY: Form = {
  user: '',
  host: DEFAULT_TUNNEL_HOST,
  port: DEFAULT_TUNNEL_PORT,
  localPath: '',
  syncOnSend: true,
  syncOnIdle: true,
};

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
  // The connection is shared by every project, so it is shown as a summary
  // once it exists. Editing it here changes it everywhere, which the previous
  // always-expanded form did not admit.
  const [editingClient, setEditingClient] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

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
        // Nothing configured yet: assume the reverse tunnel, because the
        // connect command carries `-R 2222:127.0.0.1:22` and that makes the
        // server's own localhost:2222 the way back to this machine.
        host: j.client?.host ?? DEFAULT_TUNNEL_HOST,
        port: j.client?.port ? String(j.client.port) : j.client ? '' : DEFAULT_TUNNEL_PORT,
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

  /** Persist just the connection. Separated from save() because browsing needs
   *  it to exist, and the folder is exactly what browsing is for — requiring
   *  both at once made the two mutually blocking. */
  const saveClient = async (): Promise<SyncStatus | null> => {
    const host = form.host.trim();
    if (!host) throw new Error('The address of this computer is required');
    const port = form.port.trim() ? Number(form.port.trim()) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error('Port must be a number between 1 and 65535');
    }
    const client: SyncClientConfig = {
      host,
      ...(form.user.trim() ? { user: form.user.trim() } : {}),
      ...(port !== undefined ? { port } : {}),
    };
    const r = await fetch(appUrl(`/api/sync/client?t=${encodeURIComponent(token)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client }),
    });
    if (!r.ok) throw new Error(await readError(r));
    // Re-read so `status.client` reflects what was stored, which is what the
    // collapsed summary and the browse gate both key off.
    const fresh = await fetch(
      appUrl(`/api/sync?t=${encodeURIComponent(token)}&cwd=${encodeURIComponent(cwd)}`)
    );
    if (!fresh.ok) return null;
    const next = (await fresh.json()) as SyncStatus;
    setStatus(next);
    setEditingClient(false);
    return next;
  };

  /** Browsing implies the connection is settled, so commit it on the way in. */
  const openBrowser = async () => {
    setError(null);
    try {
      if (!status?.client || editingClient) await saveClient();
      setBrowsing(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

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

      // Written only when it is new or being changed. Re-posting an unchanged
      // shared value on every project save is how one project's form ends up
      // quietly rewriting another's connection.
      if (!status?.client || editingClient) await saveClient();

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
      setEditingClient(false);
      setSaved(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  /** Run it once, now. Setting a folder up and then having to send a message
   *  to find out whether it works is a bad way to learn you mistyped a path —
   *  and at hook ① a bad sync blocks the message anyway. */
  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const r = await fetch(appUrl(`/api/sync?t=${encodeURIComponent(token)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      const body = (await r.json()) as SyncResult & { error?: string };
      if (body.outcome) setSyncResult(body);
      else throw new Error(body.error ?? r.statusText);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSyncing(false);
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
  // Once the connection is known, the only per-project question is the folder.
  const connectionKnown = !!status?.client && !editingClient;

  return (
    // The launcher toolbar does not scroll, so a panel taller than the space
    // left simply loses its bottom — buttons included. Carry a scrollbar.
    <section className="mt-3 max-h-[46vh] overflow-y-auto overscroll-contain rounded-md border border-border-subtle bg-bg-base p-3">
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
          {status?.client && !editingClient ? (
            <div className="mt-3 flex items-center gap-2 rounded border border-border-subtle bg-bg-surface px-2 py-1.5">
              <span className="text-[10px] uppercase tracking-[.06em] font-semibold text-text-muted">This computer</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
                {status.client.user ? `${status.client.user}@` : ''}{status.client.host}
                {status.client.port && status.client.port !== 22 ? `:${status.client.port}` : ''}
              </span>
              <button
                type="button"
                onClick={() => setEditingClient(true)}
                className="rounded-sm px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_84px] gap-2">
                <Field label="Address of your computer" value={form.host} placeholder="192.168.0.30, or an ssh alias" onChange={(host) => setForm((f) => ({ ...f, host }))} />
                <Field label="User on that machine" value={form.user} placeholder="your account there" onChange={(user) => setForm((f) => ({ ...f, user }))} />
                <Field label="Port (opt.)" value={form.port} placeholder="22" onChange={(port) => setForm((f) => ({ ...f, port }))} />
              </div>
              <div className="mt-1 text-[10px] text-text-muted">
                Defaults assume you connect with <code className="font-mono">-R 2222:127.0.0.1:22</code>,
                which makes this machine reachable from the server at localhost:2222. On a LAN you can
                use its address directly, or an alias from the server's{' '}
                <code className="font-mono">~/.ssh/config</code>. Leave the user blank only if your
                account here has the same name as on the server. Shared by every synced project.
              </div>
            </>
          )}

          <div className={connectionKnown ? 'mt-3' : 'mt-2'}>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field
                  label="Folder on your computer"
                  value={form.localPath}
                  placeholder={String.raw`C:\Users\you\projects\foo` + "  —  paste it, quotes and all"}
                  onChange={(localPath) => setForm((f) => ({ ...f, localPath }))}
                />
              </div>
              <button
                type="button"
                disabled={!form.host.trim()}
                onClick={() => (browsing ? setBrowsing(false) : void openBrowser())}
                // Browsing goes over the same ssh the sync will use, so an
                // address is the only prerequisite — and clicking saves it.
                title={form.host.trim() ? 'Browse folders on your computer' : 'Enter the address above first'}
                className="h-[26px] shrink-0 rounded-sm border border-border-subtle px-2 text-[11px] text-text-secondary hover:border-border hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 transition-colors duration-hover"
              >
                {browsing ? 'Close' : 'Browse…'}
              </button>
            </div>
            {browsing && (
              <ClientFolderPicker
                token={token}
                initialPath={form.localPath}
                onPick={(picked) => {
                  setForm((f) => ({ ...f, localPath: picked }));
                  setBrowsing(false);
                }}
              />
            )}
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

          {syncResult && (
            <div
              className={`mt-2 rounded border p-2 text-[11px] ${
                syncResult.outcome === 'ok'
                  ? 'border-success/25 bg-success/10 text-success'
                  : syncResult.outcome === 'conflicts'
                    ? 'border-warning/25 bg-warning/10 text-warning'
                    : 'border-danger/25 bg-danger/10 text-danger'
              }`}
            >
              {syncResult.message}
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
                onClick={() => void syncNow()}
                disabled={saving || syncing}
                className="h-7 rounded-sm border border-border-subtle px-2.5 text-xs text-text-secondary hover:border-border hover:bg-bg-hover hover:text-text-primary disabled:opacity-45 transition-colors duration-hover"
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            )}
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

type DirListing = { path: string; parent: string | null; dirs: string[] };

/**
 * Browses the *other* machine. The server lists it over the same ssh
 * connection it will sync with, which is why this is unavailable until that
 * connection is set — and why the connection itself still has to be typed.
 */
function ClientFolderPicker({
  token,
  initialPath,
  onPick,
}: {
  token: string;
  initialPath: string;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath.trim());
  const [data, setData] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = path ? `&path=${encodeURIComponent(path)}` : '';
    fetch(appUrl(`/api/sync/client-dirs?t=${encodeURIComponent(token)}${query}`))
      .then(async (r) => {
        const body = (await r.json()) as DirListing & { error?: string };
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        if (!cancelled) setData(body);
      })
      .catch((e) => { if (!cancelled) { setData(null); setError(String((e as Error).message || e)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, token]);

  const join = (dir: string) => `${(data?.path ?? '').replace(/\/$/, '')}/${dir}`;

  return (
    <div className="mt-2 rounded border border-border-subtle bg-bg-surface">
      <div className="flex items-center gap-2 border-b border-border-subtle px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary" title={data?.path}>
          {loading ? 'Listing…' : data?.path ?? path ?? '~'}
        </span>
        {data && (
          <button
            type="button"
            onClick={() => onPick(data.path)}
            className="shrink-0 rounded-sm bg-accent px-2 py-0.5 text-[11px] font-medium text-text-inverse hover:bg-accent-hi transition-colors duration-hover"
          >
            Use this folder
          </button>
        )}
      </div>
      {error && <div className="px-2 py-2 text-[11px] text-danger">{error}</div>}
      <div className="max-h-48 overflow-y-auto py-1">
        {data?.parent && (
          <button
            type="button"
            onClick={() => setPath(data.parent as string)}
            className="block w-full truncate px-2 py-1 text-left font-mono text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
          >
            ..
          </button>
        )}
        {data?.dirs.length === 0 && <div className="px-2 py-2 text-[11px] text-text-muted">No subfolders.</div>}
        {data?.dirs.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setPath(join(d))}
            className="block w-full truncate px-2 py-1 text-left font-mono text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
          >
            {d}
          </button>
        ))}
      </div>
    </div>
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
