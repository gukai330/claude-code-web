import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus } from '../components/StatusBar';
import { previewRemote } from '../components/SyncFolderPanel';
import { mergePrompt } from '../components/SyncConflictModal';
import { resolveTopLevelModal } from '../hooks/useModalLayer';

// No rendering assertions here: components that draw an <Icon> cannot be
// rendered under `tsx --test`. Icon.tsx's only react import is type-only, so
// the classic JSX transform's `React.createElement` has nothing to bind to.
// That predates this feature — see the note in CLAUDE.md.

const base = {
  connection: 'open' as const,
  busy: false,
  streamingText: '',
  items: [],
  hasPermReq: false,
  pendingEditCount: 0,
  hasPlan: false,
  secondsSinceLastEvent: 0,
};

test('a sync in progress is shown instead of nothing', () => {
  const status = deriveStatus({ ...base, sync: { message: 'Syncing from the client…', tone: 'info' } });
  assert.equal(status.kind, 'syncing');
  // Without it the bar renders nothing at all, so a multi-second pause before
  // the message is sent would look like a hang.
  assert.equal(deriveStatus(base).kind, 'idle');
});

test('a pending approval still outranks sync', () => {
  const status = deriveStatus({
    ...base,
    hasPermReq: true,
    sync: { message: 'Syncing…', tone: 'info' },
  });
  assert.equal(status.kind, 'approval-needed');
});

test('a running turn is not masked by a stale sync line', () => {
  const status = deriveStatus({
    ...base,
    busy: true,
    streamingText: 'writing',
    sync: undefined,
  });
  assert.equal(status.kind, 'writing');
});

test('a sync problem is carried through as a problem, not as progress', () => {
  const status = deriveStatus({
    ...base,
    sync: { message: '1 item(s) skipped — both sides changed', tone: 'danger' },
  });
  assert.deepEqual(status, {
    kind: 'syncing',
    message: '1 item(s) skipped — both sides changed',
    tone: 'danger',
  });
});

test('previewRemote composes exactly what the server will', () => {
  // Windows separators cannot survive into a URI, and unison needs two slashes
  // after the host to read the path as absolute.
  assert.equal(
    previewRemote({ user: 'gukai', host: 'localhost', localPath: 'C:\\Users\\Gukai\\proj' }),
    'ssh://gukai@localhost//C:/Users/Gukai/proj'
  );
  assert.equal(
    previewRemote({ user: 'gukai', host: '192.168.0.30', localPath: '/home/gukai/proj' }),
    'ssh://gukai@192.168.0.30//home/gukai/proj'
  );
  // A user is optional; ssh falls back to its own default.
  assert.equal(previewRemote({ user: '', host: 'box', localPath: '/srv/x' }), 'ssh://box//srv/x');
  // Trailing separators would otherwise produce a doubled slash in the root.
  assert.equal(previewRemote({ user: '', host: 'box', localPath: '/srv/x/' }), 'ssh://box//srv/x');
});

test('previewRemote stays silent until both halves are known', () => {
  assert.equal(previewRemote({ user: 'me', host: '', localPath: '/srv/x' }), null);
  assert.equal(previewRemote({ user: 'me', host: 'box', localPath: '  ' }), null);
});


test('the merge prompt names both files and where the result goes', () => {
  const prompt = mergePrompt('/srv/proj/', 'src/app.ts', '/tmp/ccw-sync-theirs-x/app.ts');
  assert.match(prompt, /\/srv\/proj\/src\/app\.ts/);
  assert.match(prompt, /\/tmp\/ccw-sync-theirs-x\/app\.ts/);
  // Losing an input would destroy the very work the conflict was protecting.
  assert.match(prompt, /Do not delete either input file/);
});

test('an unresolved conflict outranks the command palette', () => {
  const flags = {
    setup: false,
    permission: false,
    plan: false,
    project: false,
    syncConflicts: true,
    palette: true,
  };
  assert.equal(resolveTopLevelModal(flags), 'syncConflicts');
  // ...but never over a permission prompt, which blocks Claude right now.
  assert.equal(resolveTopLevelModal({ ...flags, permission: true }), 'permission');
});

test('the sync status only offers Resolve when something actually failed', () => {
  assert.equal(deriveStatus({ ...base, sync: { message: 'ok', tone: 'info' } }).kind, 'syncing');
  const bad = deriveStatus({ ...base, sync: { message: 'conflict', tone: 'danger' } });
  assert.equal(bad.kind === 'syncing' && bad.tone, 'danger');
});
