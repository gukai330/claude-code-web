import type { ContextUsage } from '../types';

type Props = {
  usage?: ContextUsage;
  tokensIn: number;
  tokensOut: number;
  cost?: number;
};

/** Below this the window is not the thing to worry about, so the meter stays
 *  quiet rather than adding a number to read on every turn. */
const NOTABLE_PERCENT = 50;
const WARN_PERCENT = 75;
const CRITICAL_PERCENT = 90;

/**
 * How full the context window is, and what this session has cost. Both are
 * already known server-side; without showing them, "should I start a new
 * session?" is guesswork.
 */
export function ContextMeter({ usage, tokensIn, tokensOut, cost }: Props) {
  const parts: string[] = [];
  if (tokensIn || tokensOut) parts.push(`${compact(tokensIn)} in · ${compact(tokensOut)} out`);
  if (typeof cost === 'number' && cost > 0) parts.push(formatCost(cost));

  if (!usage && parts.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-2" title={usage ? breakdown(usage) : undefined}>
      {usage && <Meter usage={usage} />}
      {parts.length > 0 && <span className="tabular-nums">{parts.join(' · ')}</span>}
    </span>
  );
}

function Meter({ usage }: { usage: ContextUsage }) {
  const pct = clampPercent(usage.percentage);
  const tone =
    pct >= CRITICAL_PERCENT ? 'bg-danger' : pct >= WARN_PERCENT ? 'bg-warning' : 'bg-accent';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative block h-1.5 w-12 overflow-hidden rounded-full bg-bg-hover" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span
        className={`tabular-nums ${pct >= CRITICAL_PERCENT ? 'text-danger' : pct >= WARN_PERCENT ? 'text-warning' : ''}`}
      >
        {pct}%
      </span>
      {/* Screen readers get the sentence; the bar itself is decorative. */}
      <span className="sr-only">of the context window used</span>
    </span>
  );
}

/** Exported for tests: the tooltip is the only place the breakdown is legible,
 *  so its contents matter more than the bar. */
export function breakdown(usage: ContextUsage): string {
  const lines = usage.categories
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((c) => `${c.name}: ${compact(c.tokens)}`);
  const head = `${compact(usage.totalTokens)} of ${compact(usage.maxTokens)} tokens (${clampPercent(usage.percentage)}%)`;
  return [head, ...lines].join('\n');
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Whole tokens are noise at this size; k/M is what the number is for. */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

export function formatCost(cost: number): string {
  // Sub-cent runs are common; rounding them to $0.00 reads as free.
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function trim(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}
