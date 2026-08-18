import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, clampPercent, compact, formatCost } from '../components/ContextMeter';
import type { ContextUsage } from '../types';

test('token counts are abbreviated, because the exact digits are noise', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(742), '742');
  assert.equal(compact(1500), '1.5k');
  assert.equal(compact(12_400), '12k');
  assert.equal(compact(1_250_000), '1.3M');
  // A whole thousand should not read as "1.0k".
  assert.equal(compact(2000), '2k');
});

test('a sub-cent run is not rounded away to free', () => {
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0.42), '$0.42');
  assert.equal(formatCost(12.5), '$12.50');
});

test('the percentage survives whatever the SDK reports', () => {
  assert.equal(clampPercent(37.6), 38);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(140), 100);
  assert.equal(clampPercent(Number.NaN), 0);
});

test('the breakdown leads with the total and sorts the categories', () => {
  const usage: ContextUsage = {
    categories: [
      { name: 'Messages', tokens: 40_000, color: '#111' },
      { name: 'Empty', tokens: 0, color: '#222' },
      { name: 'System prompt', tokens: 9_000, color: '#333' },
      { name: 'Tools', tokens: 15_000, color: '#444' },
    ],
    totalTokens: 64_000,
    maxTokens: 200_000,
    percentage: 32,
    model: 'claude-opus-4-8',
  };
  const lines = breakdown(usage).split('\n');
  assert.equal(lines[0], '64k of 200k tokens (32%)');
  assert.deepEqual(lines.slice(1), ['Messages: 40k', 'Tools: 15k', 'System prompt: 9k']);
  // A zero-token category is a row that says nothing.
  assert.equal(breakdown(usage).includes('Empty'), false);
});
