import { query, type ModelInfo, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudePath } from './resolveClaudePath.js';

/**
 * The model list used to come from a hardcoded array that went stale every
 * time a new model shipped. The SDK already knows the real answer -- it is
 * whatever the installed Claude Code CLI reports for this account -- so we ask
 * it instead and keep a process-level cache.
 *
 * Two ways in:
 *   - primeFromQuery(): free. Any live session hands us its Query and we read
 *     the list off it without spawning anything.
 *   - getModelCatalog(): spawns a short-lived CLI subprocess purely to read
 *     the list, for the case where the UI asks before any session exists.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

let cached: ModelInfo[] | null = null;
let cachedAt = 0;
let inflight: Promise<ModelInfo[]> | null = null;

function isFresh(): boolean {
  return cached !== null && cached.length > 0 && Date.now() - cachedAt < CACHE_TTL_MS;
}

function store(models: ModelInfo[]): ModelInfo[] {
  if (models.length > 0) {
    cached = models;
    cachedAt = Date.now();
  }
  return models;
}

/** Cheap path: a session already has a Query, so read the list off it. */
export function primeFromQuery(q: Query | undefined): void {
  if (!q || isFresh()) return;
  void (async () => {
    try {
      store(await q.supportedModels());
    } catch {
      /* best effort -- the probe path or the client fallback will cover it */
    }
  })();
}

/** Blocks until aborted without ever yielding a turn, so the probe costs no tokens. */
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
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

async function probe(cwd: string): Promise<ModelInfo[]> {
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
    return store(await withTimeout(q.supportedModels(), PROBE_TIMEOUT_MS, 'supportedModels()'));
  } finally {
    abortController.abort();
  }
}

export async function getModelCatalog(cwd: string, refresh = false): Promise<ModelInfo[]> {
  if (!refresh && isFresh()) return cached as ModelInfo[];
  // Collapse concurrent callers onto one subprocess.
  if (!inflight) {
    inflight = probe(cwd).finally(() => { inflight = null; });
  }
  return inflight;
}

export function peekModelCatalog(): ModelInfo[] | null {
  return isFresh() ? cached : null;
}
