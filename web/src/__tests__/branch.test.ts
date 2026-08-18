import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, addUserOptimistic, initialState } from '../reducer';
import type { SdkEvent } from '../types';

function userEvent(text: string, uuid?: string): SdkEvent {
  return { type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content: text } } as SdkEvent;
}

function assistantEvent(text: string, uuid?: string): SdkEvent {
  return {
    type: 'assistant',
    ...(uuid ? { uuid } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as SdkEvent;
}

test('a message carries the transcript id a branch has to slice on', () => {
  let s = applyEvent(initialState, userEvent('hello', 'u-1'), 1);
  s = applyEvent(s, assistantEvent('hi there', 'a-1'), 2);
  assert.deepEqual(
    s.items.map((i) => (i.kind === 'user' || i.kind === 'assistant_text' ? i.uuid : null)),
    ['u-1', 'a-1']
  );
});

test('confirming an optimistic echo is where it learns its id', () => {
  // Sent locally: no transcript id exists yet, so it cannot be branched from.
  let s = addUserOptimistic(initialState, 'hello');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind === 'user' && s.items[0].uuid, undefined);

  // The server echoes the same text back with its id; the item is confirmed
  // in place rather than duplicated.
  s = applyEvent(s, userEvent('hello', 'u-9'), 1);
  assert.equal(s.items.length, 1);
  // Confirmed in place: the flag flips to false rather than the key vanishing.
  assert.equal(s.items[0].kind === 'user' && s.items[0].optimistic, false);
  assert.equal(s.items[0].kind === 'user' && s.items[0].uuid, 'u-9');
});

test('an event without an id leaves the item unbranchable rather than guessing', () => {
  const s = applyEvent(initialState, assistantEvent('no id here'), 1);
  assert.equal(s.items[0].kind === 'assistant_text' && s.items[0].uuid, undefined);
});
