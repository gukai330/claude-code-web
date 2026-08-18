import { query, type Query, type SDKUserMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudePath } from './resolveClaudePath.js';

/**
 * The slash palette used to be a hardcoded list of UI actions, so nothing the
 * user had actually installed -- skills, plugins, project commands -- was
 * reachable from it. The CLI already knows the real list; ask it.
 *
 * Unlike the model list, this is cached *per cwd*: commands come from project
 * settings and plugins as well as the user's own, so two projects legitimately
 * disagree. Same two ways in as modelCatalog: free from a live session, or a
 * short-lived probe whose prompt never yields a turn.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

type Entry = { commands: SlashCommand[]; at: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SlashCommand[]>>();

function fresh(cwd: string): SlashCommand[] | null {
  const entry = cache.get(cwd);
  if (!entry || entry.commands.length === 0) return null;
  return Date.now() - entry.at < CACHE_TTL_MS ? entry.commands : null;
}

function store(cwd: string, commands: SlashCommand[]): SlashCommand[] {
  if (commands.length > 0) cache.set(cwd, { commands, at: Date.now() });
  return commands;
}

/** Cheap path: a session already has a Query, so read the list off it. */
export function primeCommandsFromQuery(q: Query | undefined, cwd: string): void {
  if (!q || fresh(cwd)) return;
  void (async () => {
    try {
      store(cwd, await q.supportedCommands());
    } catch {
      /* best effort — the probe path covers the cold case */
    }
  })();
}

export function peekCommandCatalog(cwd: string): SlashCommand[] | null {
  return fresh(cwd);
}

export async function getCommandCatalog(cwd: string, refresh = false): Promise<SlashCommand[]> {
  if (!refresh) {
    const hit = fresh(cwd);
    if (hit) return hit;
  }
  // Collapse concurrent callers for the same project onto one subprocess.
  let pending = inflight.get(cwd);
  if (!pending) {
    pending = probe(cwd).finally(() => inflight.delete(cwd));
    inflight.set(cwd, pending);
  }
  return pending;
}

/** Blocks until aborted without ever yielding a turn, so the probe costs no tokens. */
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probe(cwd: string): Promise<SlashCommand[]> {
  const claudePath = resolveClaudePath();
  const abortController = new AbortController();
  try {
    const q = query({
      prompt: idlePrompt(abortController.signal),
      options: {
        cwd,
        abortController,
        permissionMode: 'default',
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      },
    });
    return store(cwd, await withTimeout(q.supportedCommands(), PROBE_TIMEOUT_MS, 'supportedCommands()'));
  } finally {
    abortController.abort();
  }
}
