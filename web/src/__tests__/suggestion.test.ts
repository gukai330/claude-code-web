import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialState } from '../reducer';
import { SESSION_SUGGESTION_EVENT, type SdkEvent, type SessionSuggestion } from '../types';

const suggestion: SessionSuggestion = {
  id: 's-1',
  title: 'Fix stale README badge',
  prompt: 'The CI badge in README.md points at the old workflow. Update it.',
  reason: 'Unrelated to the current change, but it is wrong today.',
  createdAt: 1,
};

function event(s: SessionSuggestion): SdkEvent {
  return { type: SESSION_SUGGESTION_EVENT, suggestion: s } as unknown as SdkEvent;
}

test('a suggestion keeps its place in the transcript', () => {
  const s = applyEvent(initialState, event(suggestion), 1);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, 'suggestion');
  assert.equal(s.items[0].kind === 'suggestion' && s.items[0].suggestion.title, 'Fix stale README badge');
  // It is not a turn: the composer must not go busy over it.
  assert.equal(s.busy, false);
});

test('a replayed suggestion does not become a second card', () => {
  let s = applyEvent(initialState, event(suggestion), 1);
  // Same id arriving again — replay after a reconnect delivers the ring twice
  // in the worst case.
  s = applyEvent(s, event(suggestion), 2);
  assert.equal(s.items.filter((i) => i.kind === 'suggestion').length, 1);
});

test('a malformed suggestion is dropped rather than rendered empty', () => {
  const s = applyEvent(initialState, { type: SESSION_SUGGESTION_EVENT } as unknown as SdkEvent, 1);
  assert.deepEqual(s.items, []);
  // The event id still advances, or replay would stall on it forever.
  assert.equal(s.lastEventId, 1);
});
