// The two lifecycle hooks from design/sync.md:
//
//   user sends ──▶ ① pull client→server ──▶ Claude works ──▶ idle ──▶ ② push
//
// This is the only place that knows about both sessions and sync. SyncManager
// stays ignorant of sessions, and SessionManager is not touched at all — idle
// transitions are read off the snapshots it already broadcasts.
//
// Why this is code and not a prompt: ① happens before Claude is invoked (no
// session exists yet to run it) and ② after the turn has ended. Both points
// are outside Claude's lifecycle.

import type { SessionStateSnapshot, SyncHook, SyncResult } from '../protocol.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { SyncManager } from './SyncManager.js';

export type SyncEvent = {
  sessionId: string;
  cwd: string;
  hook: SyncHook;
  phase: 'running' | 'done';
  message: string;
  result?: SyncResult;
};

type SyncEventListener = (event: SyncEvent) => void;

/** Statuses that mean Claude was doing something. Only a transition out of one
 *  of these into `idle` is the end of a turn; idle→idle is not. */
const WORKING = new Set(['running', 'waiting_permission', 'waiting_plan']);

export class SyncCoordinator {
  private readonly listeners = new Set<SyncEventListener>();
  private readonly lastStatus = new Map<string, string>();
  private readonly unsubscribe: () => void;
  /** Sessions with an after-turn sync in flight, so a burst of snapshots
   *  cannot start a second one. */
  private readonly idleInFlight = new Set<string>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly sync: SyncManager
  ) {
    this.unsubscribe = this.sessions.subscribe((snapshots) => this.onSnapshots(snapshots));
  }

  subscribe(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  /** Hook ①. Awaited by the websocket before the prompt reaches Claude, so it
   *  never starts on a stale tree. Returns `null` to proceed, or the reason to
   *  refuse — a failure here must block sending, not degrade into a warning on
   *  an inconsistent tree. */
  async beforeSend(sessionId: string, cwd: string): Promise<string | null> {
    const status = await this.sync.status(cwd);
    if (!status.configured || !status.enabled || !status.config?.syncOnSend) return null;

    this.emit({ sessionId, cwd, hook: 'before_send', phase: 'running', message: 'Syncing from the client…' });
    // Prefer nothing: Claude has not acted yet this turn, so a both-sides
    // change is a real conflict and must stop the turn rather than be resolved
    // in either direction. See the conflict policy in design/sync.md.
    const result = await this.sync.sync(cwd);
    this.emit({
      sessionId,
      cwd,
      hook: 'before_send',
      phase: 'done',
      message: result.message,
      result,
    });
    if (result.outcome === 'ok') return null;
    return `Sync before send failed (${result.outcome}): ${result.message}`;
  }

  /** Hook ②. Fire-and-forget: the turn is over, so this must not block
   *  anything, but progress still has to reach the UI. */
  private afterTurn(sessionId: string, cwd: string): void {
    if (this.idleInFlight.has(sessionId)) return;
    this.idleInFlight.add(sessionId);
    void (async () => {
      try {
        const status = await this.sync.status(cwd);
        if (!status.configured || !status.enabled || !status.config?.syncOnIdle) return;

        this.emit({ sessionId, cwd, hook: 'after_turn', phase: 'running', message: 'Syncing to the client…' });
        const result = await this.sync.sync(cwd);
        this.emit({ sessionId, cwd, hook: 'after_turn', phase: 'done', message: result.message, result });
      } catch (e) {
        this.emit({
          sessionId,
          cwd,
          hook: 'after_turn',
          phase: 'done',
          message: `Sync after turn failed: ${(e as Error).message}`,
        });
      } finally {
        this.idleInFlight.delete(sessionId);
      }
    })();
  }

  private onSnapshots(snapshots: SessionStateSnapshot[]): void {
    const seen = new Set<string>();
    for (const snap of snapshots) {
      seen.add(snap.sessionId);
      const previous = this.lastStatus.get(snap.sessionId);
      this.lastStatus.set(snap.sessionId, snap.runtimeStatus);
      // A session first seen while already idle has not just finished a turn.
      if (previous === undefined) continue;
      if (snap.runtimeStatus !== 'idle' || !WORKING.has(previous)) continue;
      // Viewer sessions never spawn a process, so they cannot have edited the
      // tree; syncing on their idle would be pure noise.
      if (snap.viewerMode) continue;
      this.afterTurn(snap.sessionId, snap.cwd);
    }
    for (const id of [...this.lastStatus.keys()]) if (!seen.has(id)) this.lastStatus.delete(id);
  }

  private emit(event: SyncEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* a broken listener must not take down a sync */
      }
    }
  }
}
