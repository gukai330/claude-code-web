import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SyncManager,
  buildUnisonArgs,
  parseClientRoot,
  resolveProject,
  safeRelativePath,
  type SyncProjectConfig,
} from '../sync/SyncManager.js';
import { SyncCoordinator, type SyncEvent } from '../sync/SyncCoordinator.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { SessionRuntimeStatus, SessionStateSnapshot } from '../protocol.js';
import Fastify from 'fastify';
import { registerApi } from '../api.js';
import { SessionManager } from '../session/SessionManager.js';

const STUB = `
const { readFileSync, writeFileSync } = require('node:fs');
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const args = process.argv.slice(3);
if (args.includes('-version')) { process.stdout.write('unison version 2.51.5\\n'); process.exit(0); }
writeFileSync(plan.argvFile, JSON.stringify(args));
process.stdout.write(plan.stdout ?? '');
process.exit(plan.exitCode ?? 0);
`;

const OK_OUTPUT = 'Synchronization complete at 09:00:00  (1 item transferred, 0 skipped, 0 failed)\n';
const CONFLICT_OUTPUT =
  'Synchronization complete at 09:00:00  (0 items transferred, 1 skipped, 0 failed)\n' +
  '  skipped: shared.txt (contents changed on both sides)\n';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ccw-hooks-'));
  const project = join(dir, 'project');
  mkdirSync(project);
  const stubFile = join(dir, 'stub.cjs');
  const planFile = join(dir, 'plan.json');
  const argvFile = join(dir, 'argv.json');
  const configFile = join(dir, 'sync.json');
  writeFileSync(stubFile, STUB);
  const writePlan = (plan: Record<string, unknown>) =>
    writeFileSync(planFile, JSON.stringify({ argvFile, stdout: OK_OUTPUT, ...plan }));
  writePlan({});

  return {
    dir,
    project,
    configFile,
    writePlan,
    argv: () => JSON.parse(readFileSync(argvFile, 'utf8')) as string[],
    config: () => JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>,
    writeConfig: (c: unknown) => writeFileSync(configFile, JSON.stringify(c, null, 2)),
    manager: () =>
      new SyncManager({
        configFile,
        stateDir: join(dir, 'state'),
        unisonCommand: [process.execPath, stubFile, planFile],
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const baseConfig: SyncProjectConfig = {
  enabled: true,
  ignore: [],
  syncOnSend: true,
  syncOnIdle: true,
  sshargs: [],
  timeoutMs: 1000,
};

// ------------------------------------------------------------ composition

test('a client connection plus a local path compose into a unison root', () => {
  const resolved = resolveProject(
    { ...baseConfig, localPath: '/home/me/proj' },
    { user: 'gukai', host: '192.168.0.30' }
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.value.remote, 'ssh://gukai@192.168.0.30//home/me/proj');
});

test('a Windows path keeps its drive letter and loses its backslashes', () => {
  const resolved = resolveProject(
    { ...baseConfig, localPath: 'C:\\Users\\Gukai\\proj' },
    { user: 'gukai', host: 'localhost', port: 2222 }
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  // Two slashes after the host is unison's "absolute path"; a URI cannot
  // carry backslashes at all.
  assert.equal(resolved.value.remote, 'ssh://gukai@localhost/C:/Users/Gukai/proj');
  // A non-default port becomes an ssh argument, not part of the URI: not
  // every unison version parses a port inside ssh://.
  assert.equal(resolved.value.sshargs[resolved.value.sshargs.indexOf('-p') + 1], '2222');
  // BatchMode cannot answer an unknown-host prompt, so the policy travels with
  // every invocation — including the one unison makes for itself.
  assert.ok(resolved.value.sshargs.includes('StrictHostKeyChecking=accept-new'));
});

test('port 22 adds no port argument', () => {
  const resolved = resolveProject({ ...baseConfig, localPath: '/srv/x' }, { host: 'h', port: 22 });
  assert.equal(resolved.ok && resolved.value.sshargs.includes('-p'), false);
});

test('an explicit remote wins over localPath and needs no client', () => {
  const resolved = resolveProject(
    { ...baseConfig, localPath: '/home/me/proj', remote: '/tmp/other' },
    undefined
  );
  assert.equal(resolved.ok && resolved.value.remote, '/tmp/other');
});

test('a localPath with no client connection is a clear error, not a guess', () => {
  const resolved = resolveProject({ ...baseConfig, localPath: '/home/me/proj' }, undefined);
  assert.equal(resolved.ok, false);
  assert.match(!resolved.ok ? resolved.error : '', /No client connection configured/);
});

test('status surfaces the composed remote and the unresolvable case', async () => {
  const f = fixture();
  try {
    f.writeConfig({
      client: { user: 'gukai', host: 'localhost', port: 2222 },
      projects: { [f.project]: { localPath: 'C:/proj/foo' } },
    });
    const withClient = await f.manager().status(f.project);
    assert.equal(withClient.remote, 'ssh://gukai@localhost/C:/proj/foo');
    assert.equal(withClient.configError, undefined);

    f.writeConfig({ projects: { [f.project]: { localPath: 'C:/proj/foo' } } });
    const without = await f.manager().status(f.project);
    assert.equal(without.remote, undefined);
    assert.match(without.configError ?? '', /No client connection/);
  } finally {
    f.cleanup();
  }
});

test('the original flat config shape still loads', async () => {
  const f = fixture();
  try {
    // No `projects` wrapper — the shape written before a shared client
    // connection existed.
    f.writeConfig({ [f.project]: { remote: '/tmp/beta', ignore: ['Path .git'] } });
    const status = await f.manager().status(f.project);
    assert.equal(status.configured, true);
    assert.equal(status.remote, '/tmp/beta');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------- config writes

test('upsertProject creates an entry and status reads it back', async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    await manager.setClient({ user: 'gukai', host: '192.168.0.30' });
    const created = await manager.upsertProject(f.project, { localPath: '/home/gukai/proj' });
    assert.equal(created.ok, true);

    const status = await manager.status(f.project);
    assert.equal(status.enabled, true);
    assert.equal(status.config?.localPath, '/home/gukai/proj');
    assert.equal(status.remote, 'ssh://gukai@192.168.0.30//home/gukai/proj');
    assert.equal(status.client?.host, '192.168.0.30');
  } finally {
    f.cleanup();
  }
});

test('upsertProject merges rather than replacing', async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    await manager.upsertProject(f.project, { remote: '/tmp/beta', ignore: ['Path .git'] });
    await manager.upsertProject(f.project, { syncOnSend: false });
    const status = await manager.status(f.project);
    assert.equal(status.config?.remote, '/tmp/beta');
    assert.deepEqual(status.config?.ignore, ['Path .git']);
    assert.equal(status.config?.syncOnSend, false);
    assert.equal(status.config?.syncOnIdle, true);
  } finally {
    f.cleanup();
  }
});

test('a rejected write leaves the file untouched', async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    await manager.upsertProject(f.project, { remote: '/tmp/beta' });
    const before = readFileSync(f.configFile, 'utf8');

    const bad = await manager.upsertProject(f.project, { ignore: ['node_modules'] });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error : '', /Invalid ignore spec/);
    assert.equal(readFileSync(f.configFile, 'utf8'), before);

    const noRoot = await manager.upsertProject(join(f.dir, 'other'), { enabled: true });
    assert.equal(noRoot.ok, false);
    assert.match(!noRoot.ok ? noRoot.error : '', /"localPath" or "remote" is required/);
  } finally {
    f.cleanup();
  }
});

test('writing migrates the flat shape into the nested one', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: '/tmp/beta' } });
    const manager = f.manager();
    await manager.setClient({ host: 'h' });
    const doc = f.config();
    assert.deepEqual(Object.keys(doc).sort(), ['client', 'projects']);
    assert.ok((doc.projects as Record<string, unknown>)[f.project]);
    // The migrated entry still resolves.
    assert.equal((await manager.status(f.project)).remote, '/tmp/beta');
  } finally {
    f.cleanup();
  }
});

test('removeProject deletes only the named entry', async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const other = join(f.dir, 'other');
    mkdirSync(other);
    await manager.upsertProject(f.project, { remote: '/tmp/a' });
    await manager.upsertProject(other, { remote: '/tmp/b' });
    assert.deepEqual(await manager.removeProject(f.project), { ok: true, removed: true });
    assert.equal((await manager.status(f.project)).configured, false);
    assert.equal((await manager.status(other)).configured, true);
    assert.deepEqual(await manager.removeProject(f.project), { ok: true, removed: false });
  } finally {
    f.cleanup();
  }
});

test('setClient rejects a host that is really a URL', async () => {
  const f = fixture();
  try {
    const bad = await f.manager().setClient({ host: 'ssh://user@box' });
    assert.equal(bad.ok, false);
  } finally {
    f.cleanup();
  }
});

// ----------------------------------------------------------------- hooks

class FakeSessions {
  private readonly listeners = new Set<(s: SessionStateSnapshot[]) => void>();
  private snapshots: SessionStateSnapshot[] = [];

  subscribe(l: (s: SessionStateSnapshot[]) => void): () => void {
    this.listeners.add(l);
    l(this.snapshots);
    return () => this.listeners.delete(l);
  }

  emit(snapshots: SessionStateSnapshot[]): void {
    this.snapshots = snapshots;
    for (const l of this.listeners) l(snapshots);
  }
}

function snap(
  sessionId: string,
  runtimeStatus: SessionRuntimeStatus,
  cwd: string,
  extra: Partial<SessionStateSnapshot> = {}
): SessionStateSnapshot {
  return {
    sessionId,
    nodeId: 'local',
    provider: 'claude',
    cwd,
    permissionMode: 'default',
    runtimeStatus,
    attachedCount: 1,
    lastEventId: 1,
    lastEventAt: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...extra,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a sync event');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function coordinator(f: ReturnType<typeof fixture>) {
  const sessions = new FakeSessions();
  const events: SyncEvent[] = [];
  const co = new SyncCoordinator(sessions as unknown as SessionManager, f.manager());
  co.subscribe((e) => events.push(e));
  return { sessions, events, co };
}

test('hook ① lets the message through when the tree is in sync', async () => {
  const f = fixture();
  const { co, events } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    assert.equal(await co.beforeSend('s1', f.project), null);
    assert.deepEqual(events.map((e) => e.phase), ['running', 'done']);
    assert.equal(events[1].result?.outcome, 'ok');
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ① blocks the send on a conflict — Claude must not start on it', async () => {
  const f = fixture();
  const { co } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    f.writePlan({ stdout: CONFLICT_OUTPUT });
    const blocked = await co.beforeSend('s1', f.project);
    assert.match(blocked ?? '', /conflicts/);
    assert.match(blocked ?? '', /Nothing was overwritten/);
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ① is silent and non-blocking for a project with no sync entry', async () => {
  const f = fixture();
  const { co, events } = coordinator(f);
  try {
    assert.equal(await co.beforeSend('s1', f.project), null);
    assert.deepEqual(events, []);
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ① respects syncOnSend:false', async () => {
  const f = fixture();
  const { co, events } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta', syncOnSend: false } } });
    assert.equal(await co.beforeSend('s1', f.project), null);
    assert.deepEqual(events, []);
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ② fires when a working session goes idle', async () => {
  const f = fixture();
  const { co, events, sessions } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    sessions.emit([snap('s1', 'running', f.project)]);
    sessions.emit([snap('s1', 'idle', f.project)]);
    await waitFor(() => events.some((e) => e.phase === 'done'));
    assert.equal(events[0].hook, 'after_turn');
    assert.equal(events.at(-1)?.result?.outcome, 'ok');
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ② does not fire for a session that was already idle', async () => {
  const f = fixture();
  const { co, events, sessions } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    sessions.emit([snap('s1', 'idle', f.project)]);
    sessions.emit([snap('s1', 'idle', f.project)]);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(events, []);
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ② skips viewer sessions, which never edit the tree', async () => {
  const f = fixture();
  const { co, events, sessions } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    sessions.emit([snap('s1', 'running', f.project, { viewerMode: true })]);
    sessions.emit([snap('s1', 'idle', f.project, { viewerMode: true })]);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(events, []);
  } finally {
    co.dispose();
    f.cleanup();
  }
});

test('hook ② reports a conflict without blocking anything', async () => {
  const f = fixture();
  const { co, events, sessions } = coordinator(f);
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    f.writePlan({ stdout: CONFLICT_OUTPUT });
    sessions.emit([snap('s1', 'waiting_permission', f.project)]);
    sessions.emit([snap('s1', 'idle', f.project)]);
    await waitFor(() => events.some((e) => e.phase === 'done'));
    assert.equal(events.at(-1)?.result?.outcome, 'conflicts');
  } finally {
    co.dispose();
    f.cleanup();
  }
});

// ------------------------------------------------------ conflict resolution

test('safeRelativePath refuses anything that could leave the project', () => {
  assert.deepEqual(safeRelativePath('src/app.ts'), { ok: true, value: 'src/app.ts' });
  // Windows separators come back from a Windows client.
  assert.deepEqual(safeRelativePath('src\\app.ts'), { ok: true, value: 'src/app.ts' });
  assert.deepEqual(safeRelativePath('./a.txt'), { ok: true, value: 'a.txt' });
  for (const bad of ['/etc/passwd', 'C:/Windows/x', '../outside', 'a/../../b', 'a//b', '', '   ']) {
    assert.equal(safeRelativePath(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseClientRoot reads a composed root back into its parts', () => {
  assert.deepEqual(parseClientRoot('ssh://gukai@192.168.0.30//home/gukai/proj'), {
    kind: 'ssh',
    host: '192.168.0.30',
    user: 'gukai',
    path: '/home/gukai/proj',
  });
  assert.deepEqual(parseClientRoot('ssh://localhost:2222//C:/proj'), {
    kind: 'ssh',
    host: 'localhost',
    port: 2222,
    path: '/C:/proj',
  });
  // A plain path is the local-to-local case used for testing.
  assert.deepEqual(parseClientRoot('/tmp/beta'), { kind: 'local', path: '/tmp/beta' });
});

test('buildUnisonArgs restricts the run to the named paths', () => {
  const args = buildUnisonArgs(
    '/srv/proj',
    { remote: '/tmp/beta', ignore: ['Path .git'], sshargs: [] },
    'server',
    '/state',
    ['src/app.ts']
  );
  assert.equal(args[args.indexOf('-path') + 1], 'src/app.ts');
  // Restricting without preferring a side would just re-report the conflict.
  assert.equal(args[args.indexOf('-prefer') + 1], '/srv/proj');
});

test('resolveConflict prefers the chosen side for that path only', async () => {
  const f = fixture();
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    const manager = f.manager();

    const kept = await manager.resolveConflict(f.project, 'src/app.ts', 'client');
    assert.equal(kept.outcome, 'ok');
    const args = f.argv();
    assert.equal(args[args.indexOf('-path') + 1], 'src/app.ts');
    assert.equal(args[args.indexOf('-prefer') + 1], '/tmp/beta');

    const server = await manager.resolveConflict(f.project, 'src/app.ts', 'server');
    assert.equal(server.outcome, 'ok');
    assert.equal(f.argv()[f.argv().indexOf('-prefer') + 1], f.project);
  } finally {
    f.cleanup();
  }
});

test('resolveConflict rejects a path that climbs out of the project', async () => {
  const f = fixture();
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    const result = await f.manager().resolveConflict(f.project, '../../etc/passwd', 'client');
    assert.equal(result.outcome, 'error');
    assert.match(result.message, /must not contain/);
  } finally {
    f.cleanup();
  }
});

test('clientVersion copies the other side of a local pair', async () => {
  const f = fixture();
  try {
    const beta = join(f.dir, 'beta');
    mkdirSync(join(beta, 'src'), { recursive: true });
    writeFileSync(join(beta, 'src', 'app.ts'), 'client edit\n');
    f.writeConfig({ projects: { [f.project]: { remote: beta } } });

    const got = await f.manager().clientVersion(f.project, 'src/app.ts');
    assert.equal(got.ok, true);
    if (!got.ok) return;
    assert.equal(readFileSync(got.path, 'utf8'), 'client edit\n');
    // Never inside the project: that tree is still mid-conflict.
    assert.equal(got.path.startsWith(f.project), false);
  } finally {
    f.cleanup();
  }
});

test('clientVersion does not need unison', async () => {
  const f = fixture();
  try {
    const beta = join(f.dir, 'beta');
    mkdirSync(beta, { recursive: true });
    writeFileSync(join(beta, 'a.txt'), 'x');
    f.writeConfig({ projects: { [f.project]: { remote: beta } } });
    const manager = new SyncManager({
      configFile: f.configFile,
      stateDir: join(f.dir, 'state'),
      unisonCommand: [join(f.dir, 'definitely-not-here')],
    });
    const got = await manager.clientVersion(f.project, 'a.txt');
    assert.equal(got.ok, true);
  } finally {
    f.cleanup();
  }
});

test('a bad conflict path is a 400, not a 500', async () => {
  const f = fixture();
  const app = Fastify({ logger: false });
  const sm = new SessionManager();
  try {
    f.writeConfig({ projects: { [f.project]: { remote: '/tmp/beta' } } });
    registerApi(app, 'tok', f.project, sm, undefined, {}, f.manager());

    for (const path of ['../../etc/passwd', '/etc/passwd']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/resolve?t=tok',
        payload: { cwd: f.project, path, side: 'client' },
      });
      // The manager reports containment failures as a SyncResult, which would
      // otherwise map onto 500 — a caller's bad path is a bad request.
      assert.equal(res.statusCode, 400, `expected 400 for ${path}`);
    }

    const badSide = await app.inject({
      method: 'POST',
      url: '/api/sync/resolve?t=tok',
      payload: { cwd: f.project, path: 'a.txt', side: 'newer' },
    });
    assert.equal(badSide.statusCode, 400);
  } finally {
    await app.close();
    await sm.closeAll();
    f.cleanup();
  }
});
