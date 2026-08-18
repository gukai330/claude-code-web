import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from '../components/McpStatusChip';
import type { McpServerInfo } from '../types';

const srv = (name: string, status: McpServerInfo['status']): McpServerInfo => ({ name, status });

test('no servers configured is not a status worth showing', () => {
  assert.equal(summarise(null), null);
  assert.equal(summarise([]), null);
});

test('all connected reads as a count', () => {
  assert.deepEqual(summarise([srv('a', 'connected'), srv('b', 'connected')]), {
    label: 'MCP 2',
    tone: 'neutral',
  });
});

test('a failure outranks everything else', () => {
  // An MCP server that failed means tools silently missing, which is the one
  // case worth interrupting for.
  assert.deepEqual(summarise([srv('a', 'connected'), srv('b', 'failed'), srv('c', 'needs-auth')]), {
    label: 'MCP 1 failed',
    tone: 'danger',
  });
});

test('needing auth is a warning, since the user can fix it', () => {
  assert.deepEqual(summarise([srv('a', 'connected'), srv('b', 'needs-auth')]), {
    label: 'MCP 1 need auth',
    tone: 'warning',
  });
});

test('still connecting says so instead of claiming zero', () => {
  assert.deepEqual(summarise([srv('a', 'pending')]), { label: 'MCP connecting…', tone: 'neutral' });
  // Once something is up, the count is the more useful thing to show.
  assert.deepEqual(summarise([srv('a', 'pending'), srv('b', 'connected')]), {
    label: 'MCP 1',
    tone: 'neutral',
  });
});

test('only disabled servers is the same as none', () => {
  assert.equal(summarise([srv('a', 'disabled')]), null);
});
