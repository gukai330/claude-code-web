import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCommandEntries } from '../components/SlashPalette';
import type { SlashCommandInfo } from '../types';

const cmd = (over: Partial<SlashCommandInfo> = {}): SlashCommandInfo => ({
  name: 'review',
  description: 'Review the current diff',
  argumentHint: '',
  ...over,
});

test('a CLI command becomes a palette entry that fills the composer', () => {
  const [entry] = toCommandEntries([cmd()]);
  assert.equal(entry.label, '/review');
  assert.equal(entry.hint, 'Review the current diff');
  // Filling rather than sending: the user may still need to add an argument.
  assert.deepEqual(entry.action, { kind: 'literal', text: '/review ' });
});

test('an argument hint is shown in the label', () => {
  const [entry] = toCommandEntries([cmd({ name: 'explain', argumentHint: '<file>' })]);
  assert.equal(entry.label, '/explain <file>');
});

test('commands this client implements itself are not duplicated', () => {
  // The CLI reports /clear and /model too, and its versions would not do what
  // this UI does.
  const entries = toCommandEntries([
    cmd({ name: 'clear' }),
    cmd({ name: 'model' }),
    cmd({ name: 'mode' }),
    cmd({ name: 'review' }),
  ]);
  assert.deepEqual(entries.map((e) => e.label), ['/review']);
});

test('a leading slash and repeats from the CLI are tolerated', () => {
  const entries = toCommandEntries([cmd({ name: '/review' }), cmd({ name: 'review' }), cmd({ name: '  ' })]);
  assert.deepEqual(entries.map((e) => e.label), ['/review']);
});

test('aliases and description words are searchable', () => {
  const [entry] = toCommandEntries([cmd({ aliases: ['diff', 'pr'] })]);
  assert.ok(entry.match.includes('diff'));
  assert.ok(entry.match.includes('review'));
  // Description words help when the user remembers the what, not the name.
  assert.ok(entry.match.includes('current'));
});

test('no commands yet is not an error', () => {
  assert.deepEqual(toCommandEntries(undefined), []);
  assert.deepEqual(toCommandEntries([]), []);
});
