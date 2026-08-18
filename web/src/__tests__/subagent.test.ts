import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleOf, textOf } from '../components/SubagentTranscript';

test('a string message body is used as-is', () => {
  assert.equal(textOf({ message: { role: 'user', content: 'find the bug' } }), 'find the bug');
  assert.equal(roleOf({ message: { role: 'user', content: 'x' } }), 'user');
});

test('a part array is flattened, with tools named rather than dumped', () => {
  const m = {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking now.' },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
        { type: 'tool_result', content: 'a very long result nobody needs inline' },
        { type: 'thinking', thinking: 'hmm' },
      ],
    },
  };
  assert.equal(textOf(m), 'Looking now. [Grep] [result]');
});

test('an unreadable message degrades to empty rather than throwing', () => {
  assert.equal(textOf({}), '');
  assert.equal(textOf({ message: { content: 42 } as never }), '');
  // Falls back to the envelope type when there is no role.
  assert.equal(roleOf({ type: 'assistant' }), 'assistant');
  assert.equal(roleOf({}), '?');
});
