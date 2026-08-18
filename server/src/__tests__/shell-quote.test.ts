import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote } from '../sync/SyncManager.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('an ordinary path is quoted whole', () => {
  assert.equal(shellQuote('/home/gukai/proj'), "'/home/gukai/proj'");
});

test('a quote in the path is escaped, not passed through', () => {
  // The classic break-out: a lone ' would end the quoting and expose the rest.
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

// The only assertion that really matters: whatever a caller types must reach
// the far side as one literal argument, not as shell syntax.
test('a hostile path reaches the remote shell as data', async () => {
  const hostile = [
    "/tmp/x'; touch /tmp/ccw-pwned-$$; echo '",
    '/tmp/a b/c',
    '/tmp/$(whoami)',
    '/tmp/`id`',
    '/tmp/x"y',
    '/tmp/x;y|z&w',
  ];
  for (const path of hostile) {
    const { stdout } = await run('sh', ['-c', `printf %s ${shellQuote(path)}`]);
    assert.equal(stdout, path, `mangled: ${path}`);
  }
});
