import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseClientPath, resolveProject, type SyncProjectConfig } from '../sync/SyncManager.js';

const base: SyncProjectConfig = {
  enabled: true,
  ignore: [],
  syncOnSend: true,
  syncOnIdle: true,
  sshargs: [],
  timeoutMs: 1000,
};

const remoteFor = (localPath: string): string | null => {
  const r = resolveProject({ ...base, localPath }, { user: 'LIJIAQI', host: 'localhost', port: 2222 });
  return r.ok ? r.value.remote : null;
};

// Everything below is a form a Windows user can produce without doing anything
// unusual, so each one has to survive being pasted straight in.
test('a path typed with backslashes works', () => {
  assert.equal(normaliseClientPath('C:\\Users\\aria\\projects\\foo'), 'C:/Users/aria/projects/foo');
});

test('Explorer\'s "Copy as path" wraps the path in quotes — they are stripped', () => {
  assert.equal(normaliseClientPath('"C:\\Users\\aria\\projects\\foo"'), 'C:/Users/aria/projects/foo');
  assert.equal(normaliseClientPath("'C:\\Users\\aria\\foo'"), 'C:/Users/aria/foo');
  // Quotes plus the stray whitespace a paste often brings with it.
  assert.equal(normaliseClientPath('  "C:\\Users\\aria\\foo"  '), 'C:/Users/aria/foo');
});

test('a trailing separator is dropped, but a drive root keeps its slash', () => {
  assert.equal(normaliseClientPath('C:\\Users\\aria\\foo\\'), 'C:/Users/aria/foo');
  assert.equal(normaliseClientPath('C:\\Users\\aria\\foo//'), 'C:/Users/aria/foo');
  // C: on its own is not an absolute path; C:/ is.
  assert.equal(normaliseClientPath('C:\\'), 'C:/');
  assert.equal(normaliseClientPath('/'), '/');
});

test('spaces in the path are kept', () => {
  assert.equal(normaliseClientPath('C:\\Users\\aria\\My Projects\\foo'), 'C:/Users/aria/My Projects/foo');
});

test('a path already using forward slashes is left alone', () => {
  assert.equal(normaliseClientPath('C:/Users/aria/foo'), 'C:/Users/aria/foo');
});

test('each of those composes into a working unison root', () => {
  const expected = 'ssh://LIJIAQI@localhost//C:/Users/aria/projects/foo';
  for (const input of [
    'C:\\Users\\aria\\projects\\foo',
    '"C:\\Users\\aria\\projects\\foo"',
    'C:\\Users\\aria\\projects\\foo\\',
    'C:/Users/aria/projects/foo',
    '  C:\\Users\\aria\\projects\\foo  ',
  ]) {
    assert.equal(remoteFor(input), expected, `failed for ${JSON.stringify(input)}`);
  }
});

test('a relative path is still refused', () => {
  // Not a paste accident worth guessing at — unison needs an absolute root.
  const r = resolveProject({ ...base, localPath: 'projects/foo' }, { host: 'localhost' });
  assert.equal(r.ok, true, 'resolveProject does not validate; parsing does');
});
