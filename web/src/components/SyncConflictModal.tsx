import { useRef, useState } from 'react';
import { appUrl } from '../appUrl';
import type { SyncItem, SyncResult } from '../types';
import { Icon } from './Icon';
import { useFocusTrap } from '../hooks/useFocusTrap';

type Props = {
  token: string;
  cwd: string;
  result: SyncResult;
  onClose: () => void;
  /** Send a prompt into the live session. Used by "let Claude merge" — the
   *  merge needs to understand the code, so it is a prompt, not an algorithm. */
  onAskClaude: (prompt: string) => boolean;
};

type RowState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string };

/**
 * Conflicts are the one thing sync refuses to decide on its own: both sides
 * changed the same file, so either copy would destroy real work. This is where
 * a person says which one wins — or hands both to Claude.
 */
export function SyncConflictModal({ token, cwd, result, onClose, onAskClaude }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  useFocusTrap(ref, onClose, true);

  const setRow = (path: string, state: RowState) => setRows((prev) => ({ ...prev, [path]: state }));

  const keep = async (path: string, side: 'server' | 'client') => {
    setRow(path, { kind: 'working' });
    try {
      const r = await fetch(appUrl(`/api/sync/resolve?t=${encodeURIComponent(token)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, path, side }),
      });
      const body = (await r.json()) as SyncResult & { error?: string };
      if (!r.ok) throw new Error(body.error ?? body.message ?? r.statusText);
      if (body.outcome !== 'ok') throw new Error(body.message);
      setRow(path, {
        kind: 'done',
        message: side === 'server' ? "Kept the server's version" : "Kept your computer's version",
      });
    } catch (e) {
      setRow(path, { kind: 'failed', message: String((e as Error).message || e) });
    }
  };

  const merge = async (path: string) => {
    setRow(path, { kind: 'working' });
    try {
      const r = await fetch(appUrl(`/api/sync/client-version?t=${encodeURIComponent(token)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, path }),
      });
      const body = (await r.json()) as { path?: string; error?: string };
      if (!r.ok || !body.path) throw new Error(body.error ?? r.statusText);
      if (!onAskClaude(mergePrompt(cwd, path, body.path))) {
        throw new Error('Not connected — reconnect and try again');
      }
      setRow(path, { kind: 'done', message: 'Handed both versions to Claude' });
      onClose();
    } catch (e) {
      setRow(path, { kind: 'failed', message: String((e as Error).message || e) });
    }
  };

  const conflicts: SyncItem[] = result.conflicts;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Sync conflicts"
        className="w-[640px] max-w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-surface shadow-modal"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-raised/70 px-4 py-3">
          <Icon name="shield" size={15} className="shrink-0 text-warning" />
          <h2 className="text-sm font-medium text-text-primary">
            {conflicts.length} file{conflicts.length === 1 ? '' : 's'} changed on both sides
          </h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
            aria-label="Close"
          >
            <Icon name="x" size={13} />
          </button>
        </div>

        <p className="px-4 pt-3 text-[11px] text-text-muted">
          Nothing has been overwritten. Pick which copy wins, or hand both to Claude to merge.
        </p>

        <div className="max-h-[50vh] overflow-y-auto p-4 space-y-3">
          {conflicts.map((c) => {
            const state = rows[c.path] ?? { kind: 'idle' };
            return (
              <div key={c.path} className="rounded-md border border-border-subtle bg-bg-base p-3">
                <div className="truncate font-mono text-[12px] text-text-primary" title={c.path}>{c.path}</div>
                {c.reason && <div className="mt-0.5 text-[11px] text-text-muted">{c.reason}</div>}

                {state.kind === 'done' ? (
                  <div className="mt-2 text-[11px] text-success">{state.message}</div>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={state.kind === 'working'}
                      onClick={() => void keep(c.path, 'server')}
                      className="h-7 rounded-sm border border-border-subtle px-2.5 text-[11px] text-text-secondary hover:border-border hover:bg-bg-hover hover:text-text-primary disabled:opacity-45 transition-colors duration-hover"
                    >
                      Keep server's
                    </button>
                    <button
                      type="button"
                      disabled={state.kind === 'working'}
                      onClick={() => void keep(c.path, 'client')}
                      className="h-7 rounded-sm border border-border-subtle px-2.5 text-[11px] text-text-secondary hover:border-border hover:bg-bg-hover hover:text-text-primary disabled:opacity-45 transition-colors duration-hover"
                    >
                      Keep my computer's
                    </button>
                    <button
                      type="button"
                      disabled={state.kind === 'working'}
                      onClick={() => void merge(c.path)}
                      className="h-7 rounded-sm bg-accent px-2.5 text-[11px] font-medium text-text-inverse hover:bg-accent-hi disabled:opacity-45 transition-colors duration-hover"
                    >
                      Let Claude merge
                    </button>
                    {state.kind === 'working' && <span className="text-[11px] text-text-muted">Working…</span>}
                  </div>
                )}
                {state.kind === 'failed' && (
                  <div className="mt-2 rounded border border-danger/25 bg-danger/10 p-2 text-[11px] text-danger">
                    {state.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end border-t border-border-subtle bg-bg-raised/45 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm bg-bg-hover px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary transition-colors duration-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Exported for tests: the prompt is the whole of "let Claude merge", so its
 *  shape matters more than the button that sends it. */
export function mergePrompt(cwd: string, path: string, clientVersionPath: string): string {
  const serverFile = `${cwd.replace(/\/$/, '')}/${path}`;
  return [
    `Two versions of \`${path}\` diverged and file sync refused to overwrite either.`,
    '',
    `- the server's version: ${serverFile}`,
    `- the version from my computer: ${clientVersionPath}`,
    '',
    'Read both, reconcile them into one correct file, and write the result to',
    `${serverFile}. Then tell me briefly what differed and how you resolved it.`,
    'Do not delete either input file.',
  ].join('\n');
}
