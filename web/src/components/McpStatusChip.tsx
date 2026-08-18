import { useEffect, useState } from 'react';
import { appUrl } from '../appUrl';
import type { McpServerInfo } from '../types';

type Props = {
  token: string;
  /** Internal session id, not the Claude one: only a live query knows whether
   *  its MCP servers actually connected. */
  sessionId?: string;
};

const POLL_MS = 30_000;

/**
 * MCP servers are configured somewhere else and fail quietly; a tool simply
 * never appears. This says so.
 */
export function McpStatusChip({ token, sessionId }: Props) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setServers(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetch(appUrl(`/api/session/mcp?t=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`))
        .then((r) => (r.ok ? r.json() : { servers: [] }))
        .then((j: { servers?: McpServerInfo[] }) => {
          if (!cancelled) setServers(j.servers ?? []);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, token]);

  const summary = summarise(servers);
  if (!summary) return null;

  return (
    <span
      className={`tabular-nums ${summary.tone === 'danger' ? 'text-danger' : summary.tone === 'warning' ? 'text-warning' : ''}`}
      title={servers!.map((srv) => `${srv.name}: ${srv.status}`).join('\n')}
    >
      {summary.label}
    </span>
  );
}

/** Exported for tests: what the chip says is the whole feature. */
export function summarise(
  servers: McpServerInfo[] | null
): { label: string; tone: 'neutral' | 'warning' | 'danger' } | null {
  // No servers configured is not a status worth a chip.
  if (!servers || servers.length === 0) return null;
  const failed = servers.filter((s) => s.status === 'failed');
  const needsAuth = servers.filter((s) => s.status === 'needs-auth');
  const connected = servers.filter((s) => s.status === 'connected');
  if (failed.length > 0) return { label: `MCP ${failed.length} failed`, tone: 'danger' };
  if (needsAuth.length > 0) return { label: `MCP ${needsAuth.length} need auth`, tone: 'warning' };
  const pending = servers.filter((s) => s.status === 'pending');
  if (pending.length > 0 && connected.length === 0) return { label: 'MCP connecting…', tone: 'neutral' };
  if (connected.length === 0) return null;
  return { label: `MCP ${connected.length}`, tone: 'neutral' };
}
