import { useCallback, useEffect, useState } from 'react';
import { appUrl } from '../appUrl';

type Props = {
  token: string;
  cwd: string;
  /** Parent session id, as Claude Code knows it. */
  claudeSessionId?: string;
};

type Message = {
  type?: string;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
};

/**
 * A Task tool result is a summary written by the subagent; everything it
 * actually did is in a separate transcript the main conversation never shows.
 * This reads it, so the work can be checked rather than taken on trust.
 *
 * The SDK addresses subagents by id and does not say which Task call produced
 * which one, so they are listed rather than matched — showing a guessed
 * pairing would be worse than showing the ids.
 */
export function SubagentTranscript({ token, cwd, claudeSessionId }: Props) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const base = `t=${encodeURIComponent(token)}&cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(claudeSessionId ?? '')}`;

  useEffect(() => {
    if (!claudeSessionId) return;
    let cancelled = false;
    setLoading(true);
    fetch(appUrl(`/api/subagents?${base}`))
      .then(async (r) => {
        const body = (await r.json()) as { subagents?: string[]; error?: string };
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        if (!cancelled) setIds(body.subagents ?? []);
      })
      .catch((e) => { if (!cancelled) setError(String((e as Error).message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [base, claudeSessionId]);

  const open = useCallback(async (agentId: string) => {
    if (openId === agentId) {
      setOpenId(null);
      return;
    }
    setOpenId(agentId);
    setMessages(null);
    setError(null);
    try {
      const r = await fetch(appUrl(`/api/subagent?${base}&agentId=${encodeURIComponent(agentId)}`));
      const body = (await r.json()) as { messages?: Message[]; error?: string };
      if (!r.ok) throw new Error(body.error ?? r.statusText);
      setMessages(body.messages ?? []);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, [base, openId]);

  if (!claudeSessionId) return null;
  if (loading && !ids) return <div className="px-3.5 py-2 text-[11px] text-text-muted">Looking for subagent transcripts…</div>;
  if (error && !ids) return <div className="px-3.5 py-2 text-[11px] text-danger">{error}</div>;
  if (!ids || ids.length === 0) return null;

  return (
    <div className="border-t border-border-subtle px-3.5 py-2.5">
      <div className="text-[10px] uppercase tracking-[.06em] font-semibold text-text-muted">
        Subagent transcripts ({ids.length})
      </div>
      <div className="mt-1.5 space-y-1">
        {ids.map((id) => (
          <div key={id}>
            <button
              type="button"
              onClick={() => void open(id)}
              className="w-full truncate rounded-sm px-2 py-1 text-left font-mono text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
            >
              {openId === id ? '▾' : '▸'} {id}
            </button>
            {openId === id && (
              <div className="mt-1 max-h-64 overflow-y-auto rounded border border-border-subtle bg-bg-base p-2 text-[11px]">
                {error && <div className="text-danger">{error}</div>}
                {!error && !messages && <div className="text-text-muted">Loading…</div>}
                {messages?.length === 0 && <div className="text-text-muted">No messages recorded.</div>}
                {messages?.map((m, i) => (
                  <div key={i} className="mb-1.5 last:mb-0">
                    <span className="mr-1.5 text-text-muted">{roleOf(m)}</span>
                    <span className="whitespace-pre-wrap text-text-secondary">{textOf(m)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function roleOf(m: Message): string {
  const role = m.message?.role ?? m.type;
  return typeof role === 'string' ? role : '?';
}

/** Subagent messages are SDK messages: content is a string or a part array. */
export function textOf(m: Message): string {
  const content = m.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') out.push(part.text);
    else if (part.type === 'tool_use' && typeof part.name === 'string') out.push(`[${part.name}]`);
    else if (part.type === 'tool_result') out.push('[result]');
  }
  return out.join(' ');
}
