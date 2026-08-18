import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, type SyncProjectConfig } from '../sync/SyncManager.js';

const base: SyncProjectConfig = {
  enabled: true,
  ignore: [],
  syncOnSend: true,
  syncOnIdle: true,
  sshargs: [],
  timeoutMs: 1000,
};

// The target machine is Windows with native OpenSSH, so the client root is a
// drive-letter path and the far side is cmd.exe, not a shell.
test('a Windows client path composes into a unison root', () => {
  const r = resolveProject(
    { ...base, localPath: 'C:\\Users\\Gukai\\projects\\foo' },
    { user: 'Gukai', host: '192.168.0.42', port: 22 }
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Backslashes cannot appear in a URI, and unison needs `//` after the host
  // for an absolute path — a drive letter has no leading slash of its own.
  assert.equal(r.value.remote, 'ssh://Gukai@192.168.0.42//C:/Users/Gukai/projects/foo');
  assert.deepEqual(r.value.clientRoot, {
    kind: 'ssh',
    host: '192.168.0.42',
    user: 'Gukai',
    port: 22,
    path: 'C:/Users/Gukai/projects/foo',
  });
});

test('a non-default port becomes an ssh argument, not part of the URI', () => {
  const r = resolveProject(
    { ...base, localPath: 'D:/work/repo' },
    { user: 'Gukai', host: 'localhost', port: 2222 }
  );
  assert.equal(r.ok && r.value.remote, 'ssh://Gukai@localhost//D:/work/repo');
  // Not every unison version parses a port inside ssh://.
  assert.deepEqual(r.ok && r.value.sshargs, ['-p', '2222']);
});

test('a trailing separator does not double up in the root', () => {
  const r = resolveProject(
    { ...base, localPath: 'C:\\Users\\Gukai\\proj\\' },
    { host: 'box' }
  );
  assert.equal(r.ok && r.value.remote, 'ssh://box//C:/Users/Gukai/proj');
});
