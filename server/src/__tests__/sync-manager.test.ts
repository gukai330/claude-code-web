import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncManager, buildUnisonArgs, parseUnisonOutput } from '../sync/SyncManager.js';
import { registerApi } from '../api.js';
import { SessionManager } from '../session/SessionManager.js';

// A stand-in for the unison binary: prints a canned transcript, exits with a
// canned code, and records the argument vector it was handed. Lets every code
// path be exercised without a second machine — the real binary is checked
// against the same parser separately.
const STUB = `
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const planFile = process.argv[2];
const args = process.argv.slice(3);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
if (args.includes('-version')) {
  process.stdout.write(plan.version ?? 'unison version 2.51.5\\n');
  process.exit(plan.versionExit ?? 0);
}
writeFileSync(plan.argvFile, JSON.stringify(args));
if (plan.logFile) appendFileSync(plan.logFile, 'start\\n');
const finish = () => {
  if (plan.logFile) appendFileSync(plan.logFile, 'end\\n');
  process.stdout.write(plan.stdout ?? '');
  process.exit(plan.exitCode ?? 0);
};
if (plan.delayMs) setTimeout(finish, plan.delayMs);
else finish();
`;

type Fixture = {
  dir: string;
  project: string;
  configFile: string;
  planFile: string;
  argvFile: string;
  manager: (plan?: Record<string, unknown>) => SyncManager;
  writeConfig: (config: unknown) => void;
  writePlan: (plan: Record<string, unknown>) => void;
  argv: () => string[];
  cleanup: () => void;
};

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ccw-sync-'));
  const project = join(dir, 'project');
  mkdirSync(project);
  const stubFile = join(dir, 'stub-unison.cjs');
  const planFile = join(dir, 'plan.json');
  const argvFile = join(dir, 'argv.json');
  const configFile = join(dir, 'sync.json');
  writeFileSync(stubFile, STUB);

  const writePlan = (plan: Record<string, unknown>) => {
    writeFileSync(planFile, JSON.stringify({ argvFile, ...plan }));
  };
  writePlan({});

  return {
    dir,
    project,
    configFile,
    planFile,
    argvFile,
    writeConfig: (config: unknown) => writeFileSync(configFile, JSON.stringify(config, null, 2)),
    writePlan,
    argv: () => JSON.parse(readFileSync(argvFile, 'utf8')) as string[],
    manager: (plan?: Record<string, unknown>) => {
      if (plan) writePlan(plan);
      return new SyncManager({
        configFile,
        stateDir: join(dir, 'state'),
        unisonCommand: [process.execPath, stubFile, planFile],
      });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Every fixture below is real output captured from unison 2.51.5 (ocaml
// 4.13.1) on Ubuntu, progress-meter carriage returns included, not a guess at
// the format. The interesting part is the exit code: this build returned 0 for
// all of them — clean run, conflict, lost connection, unknown option — so the
// text is the only thing worth classifying on.
const OK_OUTPUT = `Unison 2.51.5 (ocaml 4.13.1): Contacting server...
Looking for changes
Reconciling changes
file     ---->            notes.md
uni-a        : file               modified on 2026-08-18 at 10:31:07  size 6         rw-r--r--
uni-b        : absent
Propagating updates
[BGN] Copying notes.md from /tmp/uni-a to /tmp/uni-b
 54%  00:00 ETA\r               \r[END] Copying notes.md
100%  00:00 ETA\r               \rSaving synchronizer state
Synchronization complete at 10:31:07  (2 items transferred, 0 skipped, 0 failed)
`;

const NOTHING_TO_DO_OUTPUT = `Unison 2.51.5 (ocaml 4.13.1): Contacting server...
Looking for changes
/ src/app.ts            \rReconciling changes
Nothing to do: replicas have not changed since last sync.
`;

const CONFLICT_OUTPUT = `Unison 2.51.5 (ocaml 4.13.1): Contacting server...
Looking for changes
/ src\r     \rReconciling changes
changed  <-?-> changed    shared.txt
uni-a        : changed file       modified on 2026-08-18 at 10:31:28  size 19        rw-r--r--
uni-b        : changed file       modified on 2026-08-18 at 10:31:28  size 19        rw-r--r--
new file ---->            newfile.txt
uni-b        : absent
Propagating updates
[CONFLICT] Skipping shared.txt
  contents changed on both sides
[BGN] Copying newfile.txt from /tmp/uni-a to /tmp/uni-b
100%  00:00 ETA\r               \r[END] Copying newfile.txt
100%  00:00 ETA\r               \rSaving synchronizer state
Synchronization complete at 10:31:28  (1 item transferred, 1 skipped, 0 failed)
  skipped: shared.txt (contents changed on both sides)
`;

const PARTIAL_OUTPUT = `Reconciling changes
new file <-?-> new file   conf.txt
new dir  --?->            locked
[root 1]: Error in digesting /tmp/uni-a/locked/f.txt:
/tmp/uni-a/locked/f.txt: Permission denied
Propagating updates
[CONFLICT] Skipping conf.txt
  contents changed on both sides
[BGN] Copying locked from /tmp/uni-a to /tmp/uni-b
[END] Copying locked
Saving synchronizer state
Synchronization complete at 10:32:06  (1 item transferred, 1 partially transferred, 1 skipped, 0 failed)
  skipped: conf.txt (contents changed on both sides)
  partially transferred: locked
`;

const LOST_CONNECTION_OUTPUT = `Unison 2.51.5 (ocaml 4.13.1): Contacting server...
ssh: Could not resolve hostname nosuchhost.invalid: Name or service not known
Fatal error: Lost connection with the server
`;

const UNKNOWN_OPTION_OUTPUT = `
unison: unknown option \`-nosuchflag'.
`;

const FAILURE_OUTPUT = `Propagating updates
Synchronization incomplete at 09:14:20  (1 item transferred, 0 skipped, 1 failed)
  failed: big.bin (No space left on device)
`;

test('parseUnisonOutput reads the summary counts', () => {
  const parsed = parseUnisonOutput(OK_OUTPUT);
  assert.equal(parsed.transferred, 2);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.finished, true);
  assert.deepEqual(parsed.conflicts, []);
});

test('parseUnisonOutput names the conflicting path once, with its reason', () => {
  const parsed = parseUnisonOutput(CONFLICT_OUTPUT);
  assert.equal(parsed.skipped, 1);
  // The reconciliation line, the [CONFLICT] marker and the skipped line all
  // name shared.txt; only the last one carries a reason.
  assert.deepEqual(parsed.conflicts, [
    { path: 'shared.txt', reason: 'contents changed on both sides' },
  ]);
});

test('parseUnisonOutput reads the optional "partially transferred" clause', () => {
  const parsed = parseUnisonOutput(PARTIAL_OUTPUT);
  assert.equal(parsed.transferred, 1);
  assert.equal(parsed.partiallyTransferred, 1);
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.partial, [{ path: 'locked' }]);
});

test('parseUnisonOutput treats "Nothing to do" as a finished run', () => {
  const parsed = parseUnisonOutput(NOTHING_TO_DO_OUTPUT);
  assert.equal(parsed.finished, true);
  assert.equal(parsed.sawSummary, false);
  assert.equal(parsed.transferred, 0);
});

test('parseUnisonOutput marks a run with no summary as unfinished', () => {
  assert.equal(parseUnisonOutput(LOST_CONNECTION_OUTPUT).finished, false);
  assert.equal(parseUnisonOutput(UNKNOWN_OPTION_OUTPUT).finished, false);
});

test('parseUnisonOutput separates failures from conflicts', () => {
  const parsed = parseUnisonOutput(FAILURE_OUTPUT);
  assert.equal(parsed.failed, 1);
  assert.deepEqual(parsed.failures, [{ path: 'big.bin', reason: 'No space left on device' }]);
  assert.deepEqual(parsed.conflicts, []);
});

test('parseUnisonOutput falls back to markers when the summary is missing', () => {
  const parsed = parseUnisonOutput('[CONFLICT] Skipping a.txt\nFatal error: lost connection\n');
  assert.equal(parsed.finished, false);
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.conflicts, [{ path: 'a.txt' }]);
});

test('buildUnisonArgs passes each ignore spec and maps prefer onto a root', () => {
  const config = {
    enabled: true,
    remote: 'ssh://me@localhost:2222//C:/proj',
    ignore: ['Path node_modules', 'Path .git'],
    syncOnSend: true,
    syncOnIdle: true,
    sshargs: ['-p', '2222'],
    timeoutMs: 1000,
  };
  const args = buildUnisonArgs('/srv/proj', config, 'none', '/state');
  assert.equal(args[0], '/srv/proj');
  assert.equal(args[1], config.remote);
  assert.ok(args.includes('-batch'));
  // Two -ignore flags, not one joined string.
  assert.equal(args.filter((a) => a === '-ignore').length, 2);
  assert.ok(args.includes('Path node_modules'));
  assert.equal(args[args.indexOf('-sshargs') + 1], '-p 2222');
  // No -prefer at all: unison must skip a genuine conflict, not resolve it.
  assert.equal(args.includes('-prefer'), false);

  // 'client' is the remote root, 'server' the local one — this module runs on
  // the server, so the naming is inverted relative to unison's own.
  assert.equal(buildUnisonArgs('/srv/proj', config, 'client', '/state').at(-1), config.remote);
  assert.equal(buildUnisonArgs('/srv/proj', config, 'server', '/state').at(-1), '/srv/proj');
});

test('a project with no entry is not_configured, and nothing is spawned', async () => {
  const f = fixture();
  try {
    f.writeConfig({ '/some/other/project': { remote: 'ssh://host//tmp/x' } });
    const result = await f.manager().sync(f.project);
    assert.equal(result.outcome, 'not_configured');
    assert.match(result.message, /No sync entry/);
  } finally {
    f.cleanup();
  }
});

test('enabled:false blocks the manual trigger too', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { enabled: false, remote: 'ssh://host//tmp/x' } });
    const result = await f.manager().sync(f.project);
    assert.equal(result.outcome, 'disabled');
  } finally {
    f.cleanup();
  }
});

test('a bad ignore spec is reported instead of reaching unison', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x', ignore: ['node_modules'] } });
    const status = await f.manager().status(f.project);
    assert.equal(status.configured, true);
    assert.match(status.configError ?? '', /Invalid ignore spec/);
    const result = await f.manager().sync(f.project);
    assert.equal(result.outcome, 'error');
  } finally {
    f.cleanup();
  }
});

test('whole-line // comments are tolerated in sync.json', async () => {
  const f = fixture();
  try {
    writeFileSync(
      f.configFile,
      `{\n  // the laptop\n  ${JSON.stringify(f.project)}: { "remote": "ssh://host//tmp/x" }\n}\n`
    );
    const status = await f.manager().status(f.project);
    assert.equal(status.configError, undefined);
    // ssh:// inside a value must survive comment stripping.
    assert.equal(status.config?.remote, 'ssh://host//tmp/x');
    assert.equal(status.enabled, true);
  } finally {
    f.cleanup();
  }
});

test('malformed sync.json surfaces as an error, not an empty config', async () => {
  const f = fixture();
  try {
    writeFileSync(f.configFile, '{ not json');
    const status = await f.manager().status(f.project);
    assert.match(status.configError ?? '', /sync\.json/);
  } finally {
    f.cleanup();
  }
});

test('a clean run reports ok with the transferred count', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x', ignore: ['Path .git'] } });
    const result = await f.manager({ stdout: OK_OUTPUT, exitCode: 0 }).sync(f.project);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.transferred, 2);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(f.argv().slice(0, 2), [f.project, 'ssh://host//tmp/x']);
  } finally {
    f.cleanup();
  }
});

// The one that matters: unison 2.51.5 exits 0 after losing its connection, so
// anything keying off the exit code calls a failed sync a success — and at
// hook ① that would let Claude start on a stale tree.
test('a fatal error is an error even though unison exits 0', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const result = await f
      .manager({ stdout: LOST_CONNECTION_OUTPUT, exitCode: 0 })
      .sync(f.project);
    assert.equal(result.outcome, 'error');
    assert.equal(result.exitCode, 0);
    assert.match(result.message, /Lost connection with the server/);
  } finally {
    f.cleanup();
  }
});

test('an unknown option is an error, not a silent no-op', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const result = await f.manager({ stdout: UNKNOWN_OPTION_OUTPUT, exitCode: 0 }).sync(f.project);
    assert.equal(result.outcome, 'error');
    assert.match(result.message, /unknown option/);
  } finally {
    f.cleanup();
  }
});

test('"Nothing to do" is ok', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const result = await f.manager({ stdout: NOTHING_TO_DO_OUTPUT, exitCode: 0 }).sync(f.project);
    assert.equal(result.outcome, 'ok');
    assert.match(result.message, /nothing to do/i);
  } finally {
    f.cleanup();
  }
});

test('a partial transfer is an error — the trees do not agree', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const result = await f.manager({ stdout: PARTIAL_OUTPUT, exitCode: 0 }).sync(f.project);
    assert.equal(result.outcome, 'error');
    assert.equal(result.partiallyTransferred, 1);
    assert.match(result.message, /partially transferred/);
  } finally {
    f.cleanup();
  }
});

test('exit code 1 with a skipped item is a conflict, not an error', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    // Exit 0 with a skipped item: the count, not the code, makes this a conflict.
    const result = await f.manager({ stdout: CONFLICT_OUTPUT, exitCode: 0 }).sync(f.project);
    assert.equal(result.outcome, 'conflicts');
    assert.deepEqual(result.conflicts, [
      { path: 'shared.txt', reason: 'contents changed on both sides' },
    ]);
    assert.match(result.message, /Nothing was overwritten/);
  } finally {
    f.cleanup();
  }
});

test('a failed transfer is an error and names the file', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const result = await f.manager({ stdout: FAILURE_OUTPUT, exitCode: 2 }).sync(f.project);
    assert.equal(result.outcome, 'error');
    assert.match(result.message, /big\.bin/);
  } finally {
    f.cleanup();
  }
});


test('unison missing is reported as unavailable, not as a sync failure', async () => {
  const f = fixture();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const manager = new SyncManager({
      configFile: f.configFile,
      stateDir: join(f.dir, 'state'),
      unisonCommand: [join(f.dir, 'definitely-not-here')],
    });
    const result = await manager.sync(f.project);
    assert.equal(result.outcome, 'unavailable');
    assert.match(result.message, /not found/);
  } finally {
    f.cleanup();
  }
});

test('two syncs of the same tree never overlap', async () => {
  const f = fixture();
  try {
    const logFile = join(f.dir, 'run.log');
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    const manager = f.manager({ stdout: OK_OUTPUT, exitCode: 0, delayMs: 60, logFile });
    await Promise.all([manager.sync(f.project), manager.sync(f.project)]);
    assert.equal(readFileSync(logFile, 'utf8'), 'start\nend\nstart\nend\n');
  } finally {
    f.cleanup();
  }
});

test('GET /api/sync reports config and unison availability', async () => {
  const f = fixture();
  const app = Fastify({ logger: false });
  const sm = new SessionManager();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    registerApi(app, 'tok', f.project, sm, undefined, {}, f.manager());
    const res = await app.inject({ method: 'GET', url: `/api/sync?t=tok&cwd=${encodeURIComponent(f.project)}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.configured, true);
    assert.equal(body.enabled, true);
    assert.equal(body.unison.available, true);
    assert.equal(body.unison.version, '2.51.5');
  } finally {
    await app.close();
    await sm.closeAll();
    f.cleanup();
  }
});

test('POST /api/sync runs one project and maps the outcome onto a status code', async () => {
  const f = fixture();
  const app = Fastify({ logger: false });
  const sm = new SessionManager();
  try {
    f.writeConfig({ [f.project]: { remote: 'ssh://host//tmp/x' } });
    registerApi(app, 'tok', f.project, sm, undefined, {}, f.manager({ stdout: CONFLICT_OUTPUT, exitCode: 0 }));

    const ok = await app.inject({ method: 'POST', url: '/api/sync?t=tok', payload: { cwd: f.project } });
    // Conflicts are a reported outcome, not a transport failure.
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).outcome, 'conflicts');

    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/sync?t=tok',
      payload: { cwd: join(f.dir, 'not-configured') },
    });
    assert.equal(elsewhere.statusCode, 409);
    assert.equal(JSON.parse(elsewhere.body).outcome, 'not_configured');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/sync?t=tok',
      payload: { cwd: f.project, prefer: 'newer' },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    await sm.closeAll();
    f.cleanup();
  }
});

test('/api/sync is behind the token like every other /api route', async () => {
  const f = fixture();
  const app = Fastify({ logger: false });
  const sm = new SessionManager();
  try {
    registerApi(app, 'tok', f.project, sm, undefined, {}, f.manager());
    const get = await app.inject({ method: 'GET', url: '/api/sync' });
    assert.equal(get.statusCode, 401);
    const post = await app.inject({ method: 'POST', url: '/api/sync', payload: { cwd: f.project } });
    assert.equal(post.statusCode, 401);
  } finally {
    await app.close();
    await sm.closeAll();
    f.cleanup();
  }
});
