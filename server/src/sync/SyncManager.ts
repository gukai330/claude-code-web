// Bidirectional project sync — engine half. See design/sync.md.
//
// unison is the tool because it keeps an archive of the previous run, so it
// can tell "only one side changed" from "both sides changed" and refuses to
// guess on the latter. This module owns configuration, invocation and output
// parsing only; it knows nothing about sessions or the websocket. The two
// lifecycle hooks live in SyncCoordinator, which is built on top of `sync()`.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_DIR, ensureConfigDir } from '../paths.js';
import type { SyncItem, SyncOutcome, SyncPreference, SyncResult } from '../protocol.js';

export type { SyncItem, SyncOutcome, SyncPreference, SyncResult };

/** Server-side, keyed by project path — never a file inside the project. */
export const SYNC_CONFIG_FILE = join(CONFIG_DIR, 'sync.json');

const DEFAULT_UNISON_COMMAND = ['unison'];
const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
/** How long a failed probe is trusted. Short, so installing unison takes
 *  effect without a restart; non-zero, so a status poll does not spawn a
 *  process per request while it is missing. */
const UNISON_MISS_TTL_MS = 30_000;
/** Ignore specs go to unison verbatim and a typo is a fatal unison error, so
 *  reject the obvious ones while the config is being read instead. */
const IGNORE_SPEC = /^(Path|Name|Regex|BelowPath)\s+\S/;
/** unison has no machine-readable mode, so its text output is the only
 *  diagnostic. Keep the tail: the summary and the skipped/failed detail lines
 *  are printed at the end. */
const OUTPUT_LIMIT = 256 * 1024;
const OUTPUT_TAIL_LIMIT = 8 * 1024;
/** BatchMode cannot answer the "unknown host, continue?" prompt, so an
 *  unconfigured pair fails with "Host key verification failed" and no way
 *  forward. `accept-new` trusts a first sighting and still refuses a key that
 *  has *changed*, which is the case actually worth refusing. */
const HOST_KEY_ARGS = ['-o', 'StrictHostKeyChecking=accept-new'];

/** Drive letter, leading slash, or UNC share. */
const ABSOLUTE_CLIENT_PATH = /^([A-Za-z]:[\\/]|[\\/])/;

/** How the server reaches the client. One entry for the whole file: whether
 *  the link is a reverse tunnel (`localhost:2222`) or a direct LAN address
 *  (`192.168.0.30:22`) only changes these values, never the code. */
export type SyncClientConfig = {
  user?: string;
  host: string;
  port?: number;
};

export type SyncProjectConfig = {
  enabled: boolean;
  /** Path on the client machine, composed into a unison root using the shared
   *  client connection. Windows separators are accepted and normalised. */
  localPath?: string;
  /** Full unison root, overriding `localPath`. Also the way to point both
   *  roots at the server, which is how sync gets tested without a second
   *  machine. */
  remote?: string;
  ignore: string[];
  syncOnSend: boolean;
  syncOnIdle: boolean;
  /** Extra ssh arguments. Composed from the client port when absent. */
  sshargs: string[];
  timeoutMs: number;
};

export type UnisonInfo = {
  available: boolean;
  command: string[];
  version?: string;
  error?: string;
};

export type SyncStatus = {
  cwd: string;
  configFile: string;
  configured: boolean;
  enabled: boolean;
  config?: SyncProjectConfig;
  /** What unison will actually be pointed at. Absent when the entry cannot be
   *  resolved — the UI should show `configError` instead. */
  remote?: string;
  client?: SyncClientConfig;
  configError?: string;
  unison: UnisonInfo;
  running: boolean;
  last?: SyncResult;
};

export type SyncManagerOptions = {
  configFile?: string;
  /** unison archive + log directory. Kept out of ~/.unison so this tool's
   *  state never collides with a hand-run unison. */
  stateDir?: string;
  /** Command plus fixed leading arguments. Overridable so a deployment can
   *  point at a wrapper script, and so tests can substitute a stub. */
  unisonCommand?: string[];
};

/** A project entry with `remote`/`sshargs` already composed — what actually
 *  gets handed to unison. */
export type ResolvedProject = {
  config: SyncProjectConfig;
  remote: string;
  ignore: string[];
  sshargs: string[];
  /** The same client root, structured — needed to read one file back out of
   *  it, which the composed unison URI cannot do. */
  clientRoot: ClientRoot;
};

/** Where the client copy actually lives. `local` covers two paths on the
 *  server, which is how sync is tested without a second machine. */
export type ClientRoot =
  | { kind: 'local'; path: string }
  | { kind: 'ssh'; host: string; user?: string; port?: number; path: string };

/** Which copy of a conflicting file wins. There is no 'merge' here: merging
 *  needs to understand the code, so it is handed to Claude on explicit user
 *  action rather than decided mechanically. */
export type ConflictSide = 'server' | 'client';

type LoadedConfig = {
  client?: SyncClientConfig;
  projects: Map<string, SyncProjectConfig>;
  /** Per-project validation failures, keyed the same way as `projects`. */
  errors: Map<string, string>;
  /** Missing/unreadable/unparseable file — affects every project. */
  fileError?: string;
};

export type ProjectPatch = {
  enabled?: boolean;
  localPath?: string | null;
  remote?: string | null;
  ignore?: string[];
  syncOnSend?: boolean;
  syncOnIdle?: boolean;
  timeoutMs?: number;
};

export class SyncManager {
  private readonly configFile: string;
  private readonly stateDir: string;
  private readonly unisonCommand: string[];
  private unisonInfo: UnisonInfo | undefined;
  private unisonProbedAt = 0;
  /** host → which shell answers there. Probing costs an ssh round trip. */
  private readonly clientShells = new Map<string, 'posix' | 'windows'>();
  private readonly lastResults = new Map<string, SyncResult>();
  private readonly running = new Set<string>();
  /** Per-root tail of the queue. Two syncs of the same tree must never
   *  overlap: unison would fail on its own archive lock, and the second run
   *  would see a half-propagated tree. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Serialises read-modify-write of the config file against itself. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: SyncManagerOptions = {}) {
    this.configFile = opts.configFile ?? SYNC_CONFIG_FILE;
    this.stateDir = opts.stateDir ?? join(CONFIG_DIR, 'unison');
    this.unisonCommand =
      opts.unisonCommand ??
      (process.env.CLAUDECODE_WEB_UNISON ? [process.env.CLAUDECODE_WEB_UNISON] : DEFAULT_UNISON_COMMAND);
  }

  async loadConfig(): Promise<LoadedConfig> {
    const projects = new Map<string, SyncProjectConfig>();
    const errors = new Map<string, string>();

    let raw: string;
    try {
      raw = await readFile(this.configFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { projects, errors };
      return { projects, errors, fileError: (e as Error).message };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripLineComments(raw));
    } catch (e) {
      return { projects, errors, fileError: `${this.configFile}: ${(e as Error).message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { projects, errors, fileError: `${this.configFile}: expected an object` };
    }

    // Two shapes. The original was a bare map of project path → entry; adding
    // a shared client connection needs a home that is not a project path, so
    // the current shape nests projects under `projects`. Both are read; only
    // the current one is written.
    const root = parsed as Record<string, unknown>;
    const nested = root.projects && typeof root.projects === 'object' && !Array.isArray(root.projects);
    const entries = nested ? (root.projects as Record<string, unknown>) : root;

    let client: SyncClientConfig | undefined;
    if (root.client !== undefined && root.client !== null) {
      const parsedClient = parseClientConfig(root.client);
      if (!parsedClient.ok) return { projects, errors, fileError: `${this.configFile}: client — ${parsedClient.error}` };
      client = parsedClient.value;
    }

    for (const [key, value] of Object.entries(entries)) {
      if (!nested && (key === 'client' || key === 'projects')) continue;
      if (!isAbsolute(key)) {
        errors.set(key, `Project key must be an absolute path, got "${key}"`);
        continue;
      }
      const project = parseProjectConfig(value);
      if (project.ok) projects.set(resolve(key), project.config);
      else errors.set(resolve(key), project.error);
    }
    return { client, projects, errors };
  }

  async status(cwd: string): Promise<SyncStatus> {
    const root = resolve(cwd);
    const { client, projects, errors, fileError } = await this.loadConfig();
    const config = projects.get(root);
    let configError = fileError ?? errors.get(root);
    let remote: string | undefined;
    if (config && !configError) {
      const resolved = resolveProject(config, client);
      if (resolved.ok) remote = resolved.value.remote;
      else configError = resolved.error;
    }
    return {
      cwd: root,
      configFile: this.configFile,
      configured: config !== undefined || errors.has(root),
      enabled: config?.enabled ?? false,
      config,
      remote,
      client,
      configError,
      unison: await this.detectUnison(),
      running: this.running.has(root),
      last: this.lastResults.get(root),
    };
  }

  /** A hit is cached forever, a miss for `UNISON_MISS_TTL_MS`, so installing
   *  unison takes effect without restarting the server. */
  async detectUnison(refresh = false): Promise<UnisonInfo> {
    if (!refresh && this.unisonInfo) {
      if (this.unisonInfo.available) return this.unisonInfo;
      if (Date.now() - this.unisonProbedAt < UNISON_MISS_TTL_MS) return this.unisonInfo;
    }
    const info = await probeUnison(this.unisonCommand);
    this.unisonInfo = info;
    this.unisonProbedAt = Date.now();
    return info;
  }

  /** Run a sync for one project. Resolves with a result for every outcome —
   *  callers get a `SyncResult`, not an exception, so the UI has something to
   *  render either way. */
  async sync(cwd: string, opts: { prefer?: SyncPreference } = {}): Promise<SyncResult> {
    const root = resolve(cwd);
    const prefer = opts.prefer ?? 'none';
    const startedAt = Date.now();
    const fail = (outcome: SyncOutcome, message: string): SyncResult =>
      emptyResult(root, prefer, outcome, message, startedAt);

    const prepared = await this.prepare(root);
    if (!prepared.ok) return fail(prepared.outcome, prepared.error);

    return this.enqueue(root, () => this.run(root, prepared.plan, prefer));
  }

  /** Resolve one conflicting file by letting a chosen side win, without
   *  touching the rest of the tree: unison is restricted to that path and
   *  given a `-prefer`. This is the only place last-writer-wins is allowed,
   *  because here a person has explicitly asked for it. */
  async resolveConflict(cwd: string, relPath: string, side: ConflictSide): Promise<SyncResult> {
    const root = resolve(cwd);
    const startedAt = Date.now();
    const prefer: SyncPreference = side;
    const fail = (outcome: SyncOutcome, message: string): SyncResult =>
      emptyResult(root, prefer, outcome, message, startedAt);

    const safe = safeRelativePath(relPath);
    if (!safe.ok) return fail('error', safe.error);

    const prepared = await this.prepare(root);
    if (!prepared.ok) return fail(prepared.outcome, prepared.error);

    return this.enqueue(root, () => this.run(root, prepared.plan, prefer, [safe.value]));
  }

  /** Materialise the client's copy of one file on the server, so the two
   *  versions can be handed to Claude. Returns a path under the OS temp dir —
   *  never inside the project, which is still mid-conflict. */
  async clientVersion(
    cwd: string,
    relPath: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const root = resolve(cwd);
    const safe = safeRelativePath(relPath);
    if (!safe.ok) return { ok: false, error: safe.error };

    const prepared = await this.prepare(root, { requireUnison: false });
    if (!prepared.ok) return { ok: false, error: prepared.error };

    const dir = await mkdtemp(join(tmpdir(), 'ccw-sync-theirs-'));
    const target = join(dir, safe.value.split('/').pop() || 'client-version');
    const clientRoot = prepared.plan.clientRoot;
    try {
      if (clientRoot.kind === 'local') {
        await copyFile(join(clientRoot.path, ...safe.value.split('/')), target);
        return { ok: true, path: target };
      }
      // posix.join: the client path is remote, so the server's separator is
      // irrelevant — and a Windows client still takes forward slashes over ssh.
      const remoteFile = posix.join(clientRoot.path, safe.value);
      const args = [
        ...sshArgs({ host: clientRoot.host, user: clientRoot.user, port: clientRoot.port }),
        'cat',
        '--',
        remoteFile,
      ];
      const exec = await runProcess('ssh', args, { timeoutMs: prepared.plan.config.timeoutMs });
      if (exec.code !== 0) {
        return {
          ok: false,
          error: explainSshFailure(exec.output) || lastMeaningfulLine(exec.output) || `ssh exited ${exec.code}`,
        };
      }
      await writeFile(target, exec.output);
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** List directories on the client machine, so the folder can be picked
   *  rather than typed. Needs only the shared connection — not a project
   *  entry — because it is used while setting the first one up. */
  async listClientDirs(
    path?: string
  ): Promise<
    | { ok: true; path: string; parent: string | null; dirs: string[] }
    | { ok: false; error: string }
  > {
    const { client, fileError } = await this.loadConfig();
    if (fileError) return { ok: false, error: fileError };
    if (!client) return { ok: false, error: 'No client connection configured yet' };

    const target = (path ?? '').trim();
    try {
      const shell = await this.clientShell(client);
      const command =
        shell === 'posix' ? posixListCommand(target) : windowsListCommand(target);
      if (!command.ok) return { ok: false, error: command.error };

      const exec = await runProcess('ssh', [...sshArgs(client), command.value], { timeoutMs: 20_000 });
      if (exec.code !== 0) {
        return {
          ok: false,
          error: explainSshFailure(exec.output) || lastMeaningfulLine(exec.output) || `ssh exited ${exec.code}`,
        };
      }

      const lines = exec.output.split(/\r?\n/).map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
      const rawPath = lines.shift() ?? target;
      // Report forward slashes whatever the far side used: that is the form
      // the config stores and unison's root wants.
      const resolved = rawPath.replace(/\\/g, '/').replace(/(.)\/$/, '$1');
      const dirs = (shell === 'posix'
        ? lines.filter((l) => l.endsWith('/')).map((l) => l.slice(0, -1))
        : lines
      )
        .map((name) => name.trim())
        .filter((name) => name && !name.startsWith('.'))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 500);

      return { ok: true, path: resolved, parent: parentOf(resolved), dirs };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Which shell answers on the far side. Windows OpenSSH defaults to cmd.exe,
   *  where every POSIX form here is a syntax error. Probed once per host —
   *  `uname` exists on one and not the other. */
  private async clientShell(client: SyncClientConfig): Promise<'posix' | 'windows'> {
    const key = `${client.user ?? ''}@${client.host}:${client.port ?? 22}`;
    const cached = this.clientShells.get(key);
    if (cached) return cached;
    let shell: 'posix' | 'windows' = 'posix';
    try {
      const exec = await runProcess('ssh', [...sshArgs(client), 'uname -s'], { timeoutMs: 20_000 });
      if (exec.code !== 0 || !/linux|darwin|bsd|cygwin|mingw/i.test(exec.output)) shell = 'windows';
    } catch {
      /* leave it POSIX; the listing itself will report the real failure */
    }
    this.clientShells.set(key, shell);
    return shell;
  }

  /** Shared preflight for the run paths: config, resolution, unison, root. */
  private async prepare(
    root: string,
    opts: { requireUnison?: boolean } = {}
  ): Promise<{ ok: true; plan: ResolvedProject } | { ok: false; outcome: SyncOutcome; error: string }> {
    const { client, projects, errors, fileError } = await this.loadConfig();
    if (fileError) return { ok: false, outcome: 'error', error: fileError };
    const configError = errors.get(root);
    if (configError) return { ok: false, outcome: 'error', error: configError };

    const config = projects.get(root);
    if (!config) {
      return { ok: false, outcome: 'not_configured', error: `No sync entry for ${root} in ${this.configFile}` };
    }
    if (!config.enabled) return { ok: false, outcome: 'disabled', error: `Sync is disabled for ${root}` };

    const resolved = resolveProject(config, client);
    if (!resolved.ok) return { ok: false, outcome: 'error', error: resolved.error };

    if (opts.requireUnison !== false) {
      const unison = await this.detectUnison();
      if (!unison.available) {
        return { ok: false, outcome: 'unavailable', error: unison.error ?? 'unison is not available' };
      }
    }

    try {
      const st = await stat(root);
      if (!st.isDirectory()) return { ok: false, outcome: 'error', error: `${root} is not a directory` };
    } catch {
      return { ok: false, outcome: 'error', error: `${root} does not exist` };
    }
    return { ok: true, plan: resolved.value };
  }

  /** Create or update one project entry. Returns the stored config so the
   *  caller can echo back what was actually persisted. */
  async upsertProject(
    cwd: string,
    patch: ProjectPatch
  ): Promise<{ ok: true; cwd: string; config: SyncProjectConfig } | { ok: false; error: string }> {
    const root = resolve(cwd);
    if (!isAbsolute(root)) return { ok: false, error: 'cwd must be an absolute path' };
    return this.mutate((doc) => {
      const existing = doc.projects[root];
      const merged: Record<string, unknown> = { ...(typeof existing === 'object' && existing ? existing : {}) };
      if (patch.enabled !== undefined) merged.enabled = patch.enabled;
      if (patch.syncOnSend !== undefined) merged.syncOnSend = patch.syncOnSend;
      if (patch.syncOnIdle !== undefined) merged.syncOnIdle = patch.syncOnIdle;
      if (patch.ignore !== undefined) merged.ignore = patch.ignore;
      if (patch.timeoutMs !== undefined) merged.timeoutMs = patch.timeoutMs;
      // null clears; undefined leaves the stored value alone.
      if (patch.localPath !== undefined) {
        if (patch.localPath === null) delete merged.localPath;
        else merged.localPath = patch.localPath;
      }
      if (patch.remote !== undefined) {
        if (patch.remote === null) delete merged.remote;
        else merged.remote = patch.remote;
      }

      const validated = parseProjectConfig(merged);
      if (!validated.ok) return { ok: false as const, error: validated.error };
      // Store the validated form, not the raw patch: a Windows path typed with
      // backslashes is normalised once here rather than on every read.
      doc.projects[root] = validated.config as unknown as Record<string, unknown>;
      return { ok: true as const, cwd: root, config: validated.config };
    });
  }

  async removeProject(cwd: string): Promise<{ ok: true; removed: boolean }> {
    const root = resolve(cwd);
    return this.mutate((doc) => {
      const removed = doc.projects[root] !== undefined;
      delete doc.projects[root];
      return { ok: true as const, removed };
    });
  }

  /** `null` clears the connection, which leaves every `localPath` entry
   *  unresolvable — deliberately, so the failure is visible rather than
   *  silently syncing somewhere else. */
  async setClient(
    client: SyncClientConfig | null
  ): Promise<{ ok: true; client?: SyncClientConfig } | { ok: false; error: string }> {
    return this.mutate((doc) => {
      if (client === null) {
        delete doc.client;
        return { ok: true as const, client: undefined };
      }
      const validated = parseClientConfig(client);
      if (!validated.ok) return { ok: false as const, error: validated.error };
      doc.client = validated.value as unknown as Record<string, unknown>;
      return { ok: true as const, client: validated.value };
    });
  }

  /** Read-modify-write the config file under a single-writer chain. Rewrites
   *  in the nested shape, and drops `//` comments — the file is hand-editable,
   *  but not hand-editable *and* machine-written without losing something. */
  private mutate<T extends { ok: boolean }>(
    fn: (doc: { client?: Record<string, unknown>; projects: Record<string, unknown> }) => T
  ): Promise<T> {
    const run = this.writeChain.then(async () => {
      let doc: { client?: Record<string, unknown>; projects: Record<string, unknown> } = { projects: {} };
      try {
        const raw = await readFile(this.configFile, 'utf8');
        const parsed = JSON.parse(stripLineComments(raw)) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const nested = parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects);
          const entries = nested
            ? { ...(parsed.projects as Record<string, unknown>) }
            : Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'client' && k !== 'projects'));
          doc = {
            client: parsed.client as Record<string, unknown> | undefined,
            projects: entries,
          };
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }

      const result = fn(doc);
      if (!result.ok) return result;

      const out: Record<string, unknown> = {};
      if (doc.client) out.client = doc.client;
      out.projects = doc.projects;
      ensureConfigDir();
      // Write-then-rename: a crash mid-write must not leave a truncated config
      // that would read as "no projects configured".
      const tmp = `${this.configFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.configFile);
      return result;
    });
    this.writeChain = run.then(noop, noop);
    return run;
  }

  /** Serialise per root rather than rejecting: the lifecycle hooks want to
   *  await their turn, not to be told the tree was busy. */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(key) ?? Promise.resolve();
    const run = tail.then(task, task);
    this.queues.set(key, run.then(noop, noop));
    return run;
  }

  private async run(
    root: string,
    plan: ResolvedProject,
    prefer: SyncPreference,
    paths: string[] = []
  ): Promise<SyncResult> {
    const startedAt = Date.now();
    this.running.add(root);
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const args = [
        ...this.unisonCommand.slice(1),
        ...buildUnisonArgs(root, plan, prefer, this.stateDir, paths),
      ];
      const exec = await runProcess(this.unisonCommand[0], args, {
        // UNISON is where unison keeps its archives; without it they land in
        // ~/.unison and mix with anything the operator runs by hand.
        env: { ...process.env, UNISON: this.stateDir },
        timeoutMs: plan.config.timeoutMs,
      });

      const result = buildResult(root, prefer, startedAt, exec);
      this.lastResults.set(root, result);
      return result;
    } catch (e) {
      const result = emptyResult(root, prefer, 'error', (e as Error).message, startedAt);
      this.lastResults.set(root, result);
      return result;
    } finally {
      this.running.delete(root);
    }
  }
}

/** Compose the client-side unison root. Exported for tests: getting this wrong
 *  points unison at the wrong tree, which is the one failure mode that loses
 *  work rather than reporting it. */
export function resolveProject(
  config: SyncProjectConfig,
  client: SyncClientConfig | undefined
): { ok: true; value: ResolvedProject } | { ok: false; error: string } {
  const base = { config, ignore: config.ignore };
  if (config.remote) {
    return {
      ok: true,
      value: {
        ...base,
        remote: config.remote,
        sshargs: config.sshargs,
        clientRoot: parseClientRoot(config.remote),
      },
    };
  }
  if (!config.localPath) {
    return { ok: false, error: 'Entry needs either "localPath" (with a client connection) or "remote"' };
  }
  if (!client) {
    return {
      ok: false,
      error: 'No client connection configured — set "client" in sync.json (or give this project an explicit "remote")',
    };
  }
  const path = normaliseClientPath(config.localPath);
  const userAt = client.user ? `${client.user}@` : '';
  // unison reads `//` after the host as "absolute path". A Windows path has no
  // leading slash of its own, so one is added: C:/proj -> ssh://host//C:/proj
  const remote = `ssh://${userAt}${client.host}/${path.startsWith('/') ? path : `/${path}`}`;
  const sshargs = [
    ...(config.sshargs.length > 0
      ? config.sshargs
      : client.port && client.port !== 22
        ? ['-p', String(client.port)]
        : []),
    // unison spawns its own ssh, so the same policy has to travel with it.
    ...HOST_KEY_ARGS,
  ];
  return {
    ok: true,
    value: {
      ...base,
      remote,
      sshargs,
      clientRoot: { kind: 'ssh', host: client.host, user: client.user, port: client.port, path },
    },
  };
}

/** Read a unison root string back into its parts. Only needed for an entry
 *  that set `remote` by hand; a composed one already knows them. */
export function parseClientRoot(remote: string): ClientRoot {
  const match = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?(\/.*)$/.exec(remote.trim());
  if (!match) return { kind: 'local', path: remote.trim() };
  const [, user, host, port, rawPath] = match;
  // unison's `//path` means absolute; drop the leading slash it added.
  const path = rawPath.startsWith('//') ? rawPath.slice(1) : rawPath;
  return { kind: 'ssh', host, ...(user ? { user } : {}), ...(port ? { port: Number(port) } : {}), path };
}

/** Exported for tests: the argument vector is the whole contract with unison. */
export function buildUnisonArgs(
  root: string,
  plan: { remote: string; ignore: string[]; sshargs: string[] },
  prefer: SyncPreference,
  stateDir: string,
  /** Restrict the run to these paths, relative to the root. Used to resolve
   *  one conflicting file without touching anything else in the tree. */
  paths: string[] = []
): string[] {
  const args = [
    root,
    plan.remote,
    '-ui',
    'text',
    // No questions, ever: a prompt on a server-side process is a hang.
    // -batch also skips conflicting updates instead of guessing.
    '-batch',
    '-logfile',
    join(stateDir, 'unison.log'),
  ];
  for (const spec of plan.ignore) args.push('-ignore', spec);
  for (const path of paths) args.push('-path', path);
  if (plan.sshargs.length > 0) args.push('-sshargs', plan.sshargs.join(' '));
  // This module runs on the server, so the local root is the server side and
  // `remote` is the client — the opposite of what unison's own wording suggests.
  if (prefer === 'server') args.push('-prefer', root);
  else if (prefer === 'client') args.push('-prefer', plan.remote);
  return args;
}

type ExecResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
};

function buildResult(
  root: string,
  prefer: SyncPreference,
  startedAt: number,
  exec: ExecResult
): SyncResult {
  const parsed = parseUnisonOutput(exec.output);
  const finishedAt = Date.now();
  const outcome = classify(exec, parsed);
  return {
    cwd: root,
    outcome,
    message: describe(outcome, exec, parsed),
    prefer,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    transferred: parsed.transferred,
    skipped: parsed.skipped,
    failed: parsed.failed,
    partiallyTransferred: parsed.partiallyTransferred,
    conflicts: parsed.conflicts,
    failures: parsed.failures,
    partial: parsed.partial,
    exitCode: exec.code,
    signal: exec.signal,
    timedOut: exec.timedOut,
    output: tail(exec.output, OUTPUT_TAIL_LIMIT),
  };
}

function classify(exec: ExecResult, parsed: ParsedOutput): SyncOutcome {
  if (exec.timedOut) return 'error';
  // The exit code is NOT trustworthy. On unison 2.51.5 a lost connection and
  // an unknown option both exit 0 — the failure cases return the success code
  // — and a skipped conflict exits 1 from Node but 0 from a shell with the
  // identical argv. Evidence that the run finished is the summary line, or
  // unison's "Nothing to do:" shortcut. Without one of those it died.
  if (!parsed.finished) return 'error';
  if (parsed.failed > 0) return 'error';
  // Started and not finished: the file is in neither state and the trees do
  // not agree, so this is not a conflict to hand to the user, it is a failure.
  if (parsed.partiallyTransferred > 0 || parsed.partial.length > 0) return 'error';
  // Still honour a nonzero code where a build does report one.
  if (exec.code !== null && exec.code > 1) return 'error';
  if (parsed.skipped > 0 || parsed.conflicts.length > 0 || exec.code === 1) return 'conflicts';
  return 'ok';
}

function describe(outcome: SyncOutcome, exec: ExecResult, parsed: ParsedOutput): string {
  if (exec.timedOut) return 'unison timed out and was killed';
  switch (outcome) {
    case 'ok':
      return parsed.transferred > 0
        ? `In sync — ${parsed.transferred} item(s) transferred`
        : 'In sync — nothing to do';
    case 'conflicts': {
      const names = parsed.conflicts.slice(0, 3).map((c) => c.path).join(', ');
      const count = Math.max(parsed.skipped, parsed.conflicts.length);
      return `${count} item(s) skipped — both sides changed${names ? `: ${names}` : ''}. Nothing was overwritten.`;
    }
    default: {
      const failure = parsed.failures[0];
      if (failure) {
        return `unison failed on ${failure.path}${failure.reason ? ` (${failure.reason})` : ''}`;
      }
      const partial = parsed.partial[0];
      if (partial || parsed.partiallyTransferred > 0) {
        const where = partial ? ` (${partial.path})` : '';
        return `unison only partially transferred ${Math.max(parsed.partiallyTransferred, parsed.partial.length)} item(s)${where} — the trees do not agree`;
      }
      const ssh = explainSshFailure(exec.output);
      if (ssh) return ssh;
      const fatal = lastMeaningfulLine(exec.output);
      if (fatal) return fatal;
      return exec.code === null || exec.code === 0
        ? 'unison stopped before it finished; no summary was printed'
        : `unison exited with code ${exec.code}`;
    }
  }
}

type ParsedOutput = {
  transferred: number;
  skipped: number;
  failed: number;
  partiallyTransferred: number;
  conflicts: SyncItem[];
  failures: SyncItem[];
  partial: SyncItem[];
  /** unison printed a summary line, or said there was nothing to do. Its
   *  absence is the only reliable way to tell that a run died mid-flight. */
  finished: boolean;
  sawSummary: boolean;
};

// Formats below are as emitted by unison 2.51.5, captured rather than assumed.
// The `partially transferred` clause is optional and was missing from the
// first cut of this regex, which silently turned a broken run into "ok".
const SUMMARY_RE =
  /Synchronization (?:complete|incomplete) at [^(\n]*\((\d+) items? transferred(?:, (\d+) partially transferred)?, (\d+) skipped, (\d+) failed\)/;
const NOTHING_TO_DO_RE = /Nothing to do:/;
const SKIPPED_RE = /^\s*skipped:\s+(.*?)(?:\s+\(([^()]*)\))?\s*$/;
const FAILED_RE = /^\s*failed:\s+(.*?)(?:\s+\(([^()]*)\))?\s*$/;
const PARTIAL_RE = /^\s*partially transferred:\s+(.*?)(?:\s+\(([^()]*)\))?\s*$/;
/** Printed during propagation, one line before the reason. */
const CONFLICT_MARKER_RE = /^\[CONFLICT\]\s+Skipping\s+(.+?)\s*$/;
/** Reconciliation listing marks a both-sides-changed item with `<-?->`. The
 *  line is fixed-width — `changed  <-?-> changed    src/app.ts  ` — so the
 *  path is whatever follows the last run of two or more spaces. */
const CONFLICT_LINE_RE = /<-\?->(.*)$/;

/** Exported for tests. unison offers no structured output, so this parses the
 *  text UI: the summary line plus the detail lines printed under it, with the
 *  propagation and reconciliation markers as a fallback for a run that died
 *  before printing a summary. */
export function parseUnisonOutput(output: string): ParsedOutput {
  const parsed: ParsedOutput = {
    transferred: 0,
    skipped: 0,
    failed: 0,
    partiallyTransferred: 0,
    conflicts: [],
    failures: [],
    partial: [],
    finished: false,
    sawSummary: false,
  };

  const summary = SUMMARY_RE.exec(output);
  if (summary) {
    parsed.sawSummary = true;
    parsed.transferred = Number(summary[1]);
    parsed.partiallyTransferred = summary[2] ? Number(summary[2]) : 0;
    parsed.skipped = Number(summary[3]);
    parsed.failed = Number(summary[4]);
  }
  parsed.finished = parsed.sawSummary || NOTHING_TO_DO_RE.test(output);

  const skipped: SyncItem[] = [];
  const marked: string[] = [];
  const reconciled: string[] = [];
  // Split on \r as well as \n: unison redraws its progress meter with bare
  // carriage returns, so real content shares a "line" with `100%  00:00 ETA`.
  for (const line of output.split(/[\r\n]+/)) {
    const skippedLine = SKIPPED_RE.exec(line);
    if (skippedLine) {
      const path = skippedLine[1].trim();
      if (path) skipped.push(syncItem(path, skippedLine[2]));
      continue;
    }
    const partialLine = PARTIAL_RE.exec(line);
    if (partialLine) {
      const path = partialLine[1].trim();
      if (path) parsed.partial.push(syncItem(path, partialLine[2]));
      continue;
    }
    const failedLine = FAILED_RE.exec(line);
    if (failedLine) {
      const path = failedLine[1].trim();
      if (path) parsed.failures.push(syncItem(path, failedLine[2]));
      continue;
    }
    const markerLine = CONFLICT_MARKER_RE.exec(line);
    if (markerLine) {
      marked.push(markerLine[1].trim());
      continue;
    }
    const conflictLine = CONFLICT_LINE_RE.exec(line);
    if (conflictLine) {
      const path = pathFromColumns(conflictLine[1]);
      if (path) reconciled.push(path);
    }
  }

  // The `skipped:` lines carry a reason and are printed after the summary; the
  // markers and the reconciliation listing carry the same paths without one.
  // Prefer the former, and keep any path only the others mentioned.
  const seen = new Set(skipped.map((item) => item.path));
  parsed.conflicts = skipped.slice();
  for (const path of [...marked, ...reconciled]) {
    if (seen.has(path)) continue;
    seen.add(path);
    parsed.conflicts.push({ path });
  }

  // The summary is authoritative when present; fall back to the detail lines
  // when unison died before printing it.
  if (!parsed.sawSummary) {
    parsed.skipped = parsed.conflicts.length;
    parsed.failed = parsed.failures.length;
    parsed.partiallyTransferred = parsed.partial.length;
  }
  return parsed;
}

/** Omit `reason` rather than carrying an undefined key, so an item without one
 *  compares and serialises the same wherever it was parsed from. */
function syncItem(path: string, reason?: string): SyncItem {
  const trimmed = reason?.trim();
  return trimmed ? { path, reason: trimmed } : { path };
}

/** Last column of a fixed-width unison line. A path containing two adjacent
 *  spaces would be cut short here; unison gives us nothing better to split on. */
function pathFromColumns(rest: string): string {
  const trimmed = rest.replace(/\s+$/, '');
  const cut = trimmed.lastIndexOf('  ');
  return (cut === -1 ? trimmed : trimmed.slice(cut)).trim();
}

/** unison reports conflicts as paths relative to the root. Anything else —
 *  absolute, or climbing out with `..` — would let a caller point the resolve
 *  endpoint at a file outside the project. */
export function safeRelativePath(
  relPath: string
): { ok: true; value: string } | { ok: false; error: string } {
  const value = (relPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value) return { ok: false, error: 'path required' };
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return { ok: false, error: 'path must be relative to the project' };
  }
  if (value.split('/').some((part) => part === '..' || part === '')) {
    return { ok: false, error: 'path must not contain ".." or empty segments' };
  }
  if (value.includes('\0')) return { ok: false, error: 'path contains a null byte' };
  return { ok: true, value };
}

function sshArgs(client: SyncClientConfig): string[] {
  return [
    ...(client.port && client.port !== 22 ? ['-p', String(client.port)] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    ...HOST_KEY_ARGS,
    client.user ? `${client.user}@${client.host}` : client.host,
  ];
}

function posixListCommand(target: string): { ok: true; value: string } | { ok: false; error: string } {
  // `ls -p` marks directories with a trailing slash; that is the filter.
  const where = target ? `cd -- ${shellQuote(target)}` : 'cd -- "$HOME"';
  return { ok: true, value: `${where} && pwd && ls -1Ap -- . 2>/dev/null` };
}

/** cmd.exe has no quoting scheme that survives arbitrary input, so anything
 *  it would reinterpret is refused rather than escaped. A path with a quote or
 *  a percent in it can still be typed by hand. */
function windowsListCommand(target: string): { ok: true; value: string } | { ok: false; error: string } {
  const where = target || '%USERPROFILE%';
  if (target && /["%!^&|<>]/.test(target)) {
    return { ok: false, error: 'That path has characters this browser cannot pass to cmd — type it instead' };
  }
  // `cd` with no argument prints the current directory; `dir /b /ad` lists
  // directory names only.
  return { ok: true, value: `cd /d "${where}" && cd && dir /b /ad` };
}

function parentOf(resolved: string): string | null {
  if (resolved === '/' || /^[A-Za-z]:\/?$/.test(resolved)) return null;
  const cut = resolved.replace(/\/[^/]*$/, '');
  if (!cut) return '/';
  // C:/Users -> C:/ rather than C:
  return /^[A-Za-z]:$/.test(cut) ? `${cut}/` : cut;
}

/** POSIX single-quoting. The client shell is the one that will run this. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Whatever a Windows user actually pastes. Explorer's "Copy as path" wraps
 *  the result in double quotes, a drag-drop can leave a trailing separator,
 *  and a URI cannot carry backslashes at all. */
export function normaliseClientPath(p: string): string {
  const unquoted = p.trim().replace(/^["']+/, '').replace(/["']+$/, '').trim();
  const forward = unquoted.replace(/\\/g, '/');
  // Strip trailing separators but never the last one of a root: C:/ and / are
  // both still absolute, and `C:` alone is not.
  return forward.replace(/(?!^)\/+$/, (match, offset: number) =>
    offset > 0 && /^[A-Za-z]:$/.test(forward.slice(0, offset)) ? '/' : ''
  );
}

function parseClientConfig(
  value: unknown
): { ok: true; value: SyncClientConfig } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'must be an object' };
  }
  const v = value as Record<string, unknown>;
  const host = typeof v.host === 'string' ? v.host.trim() : '';
  if (!host) return { ok: false, error: '"host" is required' };
  if (/[\s/@]/.test(host)) return { ok: false, error: '"host" must be a bare hostname or address' };

  let user: string | undefined;
  if (v.user !== undefined && v.user !== null) {
    if (typeof v.user !== 'string' || !v.user.trim()) return { ok: false, error: '"user" must be a non-empty string' };
    if (/[\s/@]/.test(v.user)) return { ok: false, error: '"user" must not contain spaces, @ or /' };
    user = v.user.trim();
  }

  let port: number | undefined;
  if (v.port !== undefined && v.port !== null) {
    if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) {
      return { ok: false, error: '"port" must be an integer between 1 and 65535' };
    }
    port = v.port;
  }
  return { ok: true, value: user ? { user, host, ...(port ? { port } : {}) } : { host, ...(port ? { port } : {}) } };
}

function parseProjectConfig(
  value: unknown
): { ok: true; config: SyncProjectConfig } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Entry must be an object' };
  }
  const v = value as Record<string, unknown>;

  let remote: string | undefined;
  if (v.remote !== undefined && v.remote !== null) {
    if (typeof v.remote !== 'string' || !v.remote.trim()) {
      return { ok: false, error: '"remote" must be a non-empty string' };
    }
    remote = v.remote.trim();
  }

  let localPath: string | undefined;
  if (v.localPath !== undefined && v.localPath !== null) {
    if (typeof v.localPath !== 'string' || !v.localPath.trim()) {
      return { ok: false, error: '"localPath" must be a non-empty string' };
    }
    const normalised = normaliseClientPath(v.localPath);
    if (!ABSOLUTE_CLIENT_PATH.test(normalised)) {
      return { ok: false, error: `"localPath" must be absolute, got "${v.localPath}"` };
    }
    localPath = normalised;
  }

  if (!remote && !localPath) {
    return { ok: false, error: '"localPath" or "remote" is required' };
  }

  const ignore: string[] = [];
  if (v.ignore !== undefined) {
    if (!Array.isArray(v.ignore)) return { ok: false, error: '"ignore" must be an array of strings' };
    for (const spec of v.ignore) {
      if (typeof spec !== 'string' || !IGNORE_SPEC.test(spec.trim())) {
        return {
          ok: false,
          error: `Invalid ignore spec ${JSON.stringify(spec)} — expected "Path …", "Name …", "Regex …" or "BelowPath …"`,
        };
      }
      ignore.push(spec.trim());
    }
  }

  const sshargs: string[] = [];
  if (v.sshargs !== undefined) {
    if (!Array.isArray(v.sshargs) || v.sshargs.some((a) => typeof a !== 'string')) {
      return { ok: false, error: '"sshargs" must be an array of strings' };
    }
    sshargs.push(...(v.sshargs as string[]));
  }

  const bool = (key: string, fallback: boolean): boolean | undefined =>
    v[key] === undefined ? fallback : typeof v[key] === 'boolean' ? (v[key] as boolean) : undefined;

  const enabled = bool('enabled', true);
  const syncOnSend = bool('syncOnSend', true);
  const syncOnIdle = bool('syncOnIdle', true);
  for (const [key, parsedValue] of [
    ['enabled', enabled],
    ['syncOnSend', syncOnSend],
    ['syncOnIdle', syncOnIdle],
  ] as const) {
    if (parsedValue === undefined) return { ok: false, error: `"${key}" must be a boolean` };
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (v.timeoutMs !== undefined) {
    if (typeof v.timeoutMs !== 'number' || !Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0) {
      return { ok: false, error: '"timeoutMs" must be a positive number' };
    }
    timeoutMs = v.timeoutMs;
  }

  return {
    ok: true,
    config: {
      enabled: enabled as boolean,
      ...(localPath ? { localPath } : {}),
      ...(remote ? { remote } : {}),
      ignore,
      syncOnSend: syncOnSend as boolean,
      syncOnIdle: syncOnIdle as boolean,
      sshargs,
      timeoutMs,
    },
  };
}

/** Whole-line `//` comments only. Never touches `ssh://…` inside a value,
 *  which is why this is not a general comment stripper. */
function stripLineComments(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

async function probeUnison(command: string[]): Promise<UnisonInfo> {
  try {
    const exec = await runProcess(command[0], [...command.slice(1), '-version'], {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    });
    if (exec.code !== 0) {
      return {
        available: false,
        command,
        error: lastMeaningfulLine(exec.output) || `unison -version exited ${exec.code}`,
      };
    }
    const version = /unison\s+version\s+(\S+)/i.exec(exec.output)?.[1];
    return { available: true, command, version };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { available: false, command, error: `unison not found (looked for "${command[0]}")` };
    }
    return { available: false, command, error: err.message };
  }
}

function runProcess(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      env: opts.env,
      // stdin closed: batch mode should never prompt, and if it does we want
      // EOF rather than a process parked forever on a read.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardKillTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      hardKillTimer.unref?.();
    }, opts.timeoutMs);
    killTimer.unref?.();

    const cleanup = () => {
      clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(e);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ code, signal, output, timedOut });
    });
  });
}

function emptyResult(
  cwd: string,
  prefer: SyncPreference,
  outcome: SyncOutcome,
  message: string,
  startedAt: number
): SyncResult {
  const finishedAt = Date.now();
  return {
    cwd,
    outcome,
    message,
    prefer,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    transferred: 0,
    skipped: 0,
    failed: 0,
    partiallyTransferred: 0,
    conflicts: [],
    failures: [],
    partial: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    output: '',
  };
}

/** ssh's own wording for a changed key is a wall of asterisks that says
 *  nothing about what to do. */
function explainSshFailure(output: string): string | null {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(output)) {
    return (
      'The other machine presented a different SSH host key than last time. If you re-created ' +
      'the tunnel or reinstalled its SSH server this is expected — remove its line from the ' +
      "server's ~/.ssh/known_hosts and try again."
    );
  }
  if (/Permission denied|Too many authentication failures/i.test(output)) {
    return (
      'The other machine refused the login. Add this server\'s public key to its ' +
      'authorized_keys — a password prompt cannot be answered from here.'
    );
  }
  return null;
}

function lastMeaningfulLine(output: string): string {
  const lines = output.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const fatal = lines.filter((l) => /^(Fatal error|Uncaught exception|Error)/i.test(l));
  return (fatal.length > 0 ? fatal[fatal.length - 1] : lines[lines.length - 1]) ?? '';
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function noop(): void {
  /* the queue tail only cares about completion, not the value or the error */
}
