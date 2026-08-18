// Wire protocol between browser and server. The SDK's SDKMessage objects are
// forwarded as-is inside `event` payloads so we don't re-invent a schema for
// every assistant/tool variant.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type SessionRuntimeStatus = 'idle' | 'running' | 'waiting_permission' | 'waiting_plan' | 'error' | 'closed';
export type AgentProviderId = 'claude' | 'codex';

export const DEFAULT_NODE_ID = 'local';
export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'claude';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

export function defaultModelForProvider(provider: AgentProviderId): string | undefined {
  return provider === 'claude' ? DEFAULT_CLAUDE_MODEL : undefined;
}

/** A breakdown of what is filling the context window, straight from the SDK.
 *  The app shows this because "should I start a new session?" is otherwise
 *  guesswork. */
export type ContextUsageCategory = {
  name: string;
  tokens: number;
  /** SDK-supplied colour, so the breakdown matches what the CLI draws. */
  color: string;
};

export type ContextUsage = {
  categories: ContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  /** 0-100, as computed by the SDK rather than by dividing here. */
  percentage: number;
  model: string;
};

/** Work Claude noticed that does not belong in the current conversation. It
 *  becomes a card; nothing is started unless the user clicks it. */
export type SessionSuggestion = {
  id: string;
  title: string;
  /** Self-contained opening message for the new session. */
  prompt: string;
  reason: string;
  createdAt: number;
};

/** Carried as a synthetic event in the replay ring rather than a side channel,
 *  so a suggestion keeps its place in the transcript across reconnects. */
export const SESSION_SUGGESTION_EVENT = 'ccw_session_suggestion';

export type ActiveToolInfo = {
  toolUseId: string;
  name: string;
  startedAt: number;
  inputSummary?: string;
};

export type ClientHello = {
  type: 'hello';
  /** Client-generated id for this attachment attempt. Echoed on all
   * session-scoped server frames so stale frames can be ignored safely. */
  attachId?: string;
  nodeId?: string;
  provider?: AgentProviderId;
  sessionId?: string;
  resumeClaudeId?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  lastEventId?: number;
  /** When true, load transcript but do NOT spawn a live Claude Code process.
   *  Safe for peeking at sessions that may be actively running elsewhere. */
  viewerMode?: boolean;
};

export type ClientAttachmentScope = {
  /** Attachment/session scope is optional only for rolling compatibility with
   * clients that predate attachment generations. New clients send both. */
  attachId?: string;
  sessionId?: string;
};

export type ClientUserMessage = ClientAttachmentScope & { type: 'user'; text: string };
export type ClientPermissionResponse = ClientAttachmentScope & {
  type: 'permission_response';
  reqId: string;
  decision: 'allow' | 'deny';
  scope?: 'once' | 'session';
};
export type ClientPlanResponse = ClientAttachmentScope & {
  type: 'plan_response';
  reqId: string;
  decision: 'approve' | 'reject';
};
export type ClientInterrupt = ClientAttachmentScope & { type: 'interrupt' };
/** Push blocking work into the background and let the turn continue. Without a
 *  toolUseId this backgrounds everything in flight. */
export type ClientBackgroundTask = ClientAttachmentScope & { type: 'background_task'; toolUseId?: string };
export type ClientSetModel = ClientAttachmentScope & { type: 'set_model'; model: string };
export type ClientSetMode = ClientAttachmentScope & { type: 'set_permission_mode'; mode: PermissionMode };
export type ClientRefreshHistory = ClientAttachmentScope & { type: 'refresh_history' };
export type ClientSessionClose = ClientAttachmentScope & { type: 'session_close'; sessionId: string };
/** Ask for a fresh snapshot of all sessions. Used to populate the
 *  drawer/sidebar on demand. The server no longer broadcasts sessions_update
 *  automatically — that proved fatal on slow links (session-list snapshots
 *  grow with history and fan out per activeTool transition, burying the WS
 *  send queue). Clients request explicitly when they actually want the list. */
export type ClientListSessions = { type: 'list_sessions' };

export type ClientMessage =
  | ClientHello
  | ClientUserMessage
  | ClientPermissionResponse
  | ClientPlanResponse
  | ClientInterrupt
  | ClientBackgroundTask
  | ClientSetModel
  | ClientSetMode
  | ClientRefreshHistory
  | ClientSessionClose
  | ClientListSessions;

export type SessionStateSnapshot = {
  sessionId: string;
  nodeId: string;
  nodeLabel?: string;
  provider: AgentProviderId;
  providerSessionId?: string;
  claudeSessionId?: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  runtimeStatus: SessionRuntimeStatus;
  attachedCount: number;
  lastEventId: number;
  lastEventAt: number;
  activeTool?: ActiveToolInfo;
  tokensIn: number;
  tokensOut: number;
  cost?: number;
  /** Refreshed at the end of each turn — it is a control request, so it costs
   *  a round trip and only changes meaningfully between turns. */
  contextUsage?: ContextUsage;
  viewerMode?: boolean;
};

export type ReplayMode = 'full' | 'delta';
export type HistoryStatus = 'loading' | 'ready' | 'error';

/** Optional for backwards compatibility with older clients. New clients use
 * these fields to reject frames from an attachment that has been superseded. */
export type ServerAttachmentScope = {
  attachId?: string;
  sessionId?: string;
};

export type ServerReady = ServerAttachmentScope & {
  type: 'ready';
  state: SessionStateSnapshot;
  replayMode?: ReplayMode;
  historyStatus?: HistoryStatus;
  historyTruncated?: boolean;
};
export type ServerSdkEvent = ServerAttachmentScope & { type: 'sdk_event'; id: number; event: unknown };
export type ServerSdkEventBatch = ServerAttachmentScope & {
  type: 'sdk_events_batch';
  events: Array<{ id: number; event: unknown }>;
  replayComplete?: boolean;
  /** Final history outcome. Present on replayComplete for attachments whose
   * initial ready frame reported `loading`. */
  historyStatus?: HistoryStatus;
  historyTruncated?: boolean;
};
export type ServerPermissionRequest = ServerAttachmentScope & {
  type: 'permission_request';
  reqId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
};
export type ServerPlanProposed = ServerAttachmentScope & {
  type: 'plan_proposed';
  reqId: string;
  plan: string;
};
export type PendingControl =
  | ({ kind: 'permission' } & Omit<ServerPermissionRequest, 'type' | 'attachId' | 'sessionId'>)
  | ({ kind: 'plan' } & Omit<ServerPlanProposed, 'type' | 'attachId' | 'sessionId'>);
export type ServerPendingControl = ServerAttachmentScope & {
  type: 'pending_control';
  sessionId: string;
  control: PendingControl;
};
export type ServerSessionsUpdate = {
  type: 'sessions_update';
  sessions: SessionStateSnapshot[];
};
export type ServerStateUpdate = ServerAttachmentScope & {
  type: 'state_update';
  state: Partial<SessionStateSnapshot>;
};
export type ServerHeartbeat = ServerAttachmentScope & {
  type: 'heartbeat';
  now: number;
  session?: SessionStateSnapshot;
  noActivityMs?: number;
};
export type ServerError = ServerAttachmentScope & { type: 'error'; message: string };

// ---------------------------------------------------------------- file sync
// These live here rather than in sync/SyncManager.ts because they cross the
// wire: the UI renders a sync result, so it is shared vocabulary like every
// other type in this file. See design/sync.md.

/** Which side wins a genuine conflict. 'none' passes no `-prefer` to unison,
 *  so both-sides-changed is skipped and reported rather than resolved. */
export type SyncPreference = 'none' | 'client' | 'server';

export type SyncOutcome =
  | 'ok'
  | 'conflicts'
  | 'error'
  | 'disabled'
  | 'not_configured'
  | 'unavailable';

export type SyncItem = { path: string; reason?: string };

export type SyncResult = {
  cwd: string;
  outcome: SyncOutcome;
  /** One line, safe to show in the UI as-is. */
  message: string;
  prefer: SyncPreference;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  transferred: number;
  skipped: number;
  failed: number;
  /** Items unison started and could not finish. Neither transferred nor
   *  failed in its own accounting, but the trees do not agree. */
  partiallyTransferred: number;
  conflicts: SyncItem[];
  failures: SyncItem[];
  partial: SyncItem[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Tail of unison's combined output, for when something went wrong. */
  output: string;
};

/** Where a sync was triggered from. `before_send` blocks the turn; the other
 *  two are advisory. */
export type SyncHook = 'manual' | 'before_send' | 'after_turn';

/** Progress for one sync run. A silent multi-second pause on a weak link
 *  reads as a hang, so `running` is sent before the work starts. */
export type ServerSyncStatus = ServerAttachmentScope & {
  type: 'sync_status';
  hook: SyncHook;
  cwd: string;
  phase: 'running' | 'done';
  message: string;
  /** Present when phase is 'done'. */
  result?: SyncResult;
};

export type ServerMessage =
  | ServerReady
  | ServerSdkEvent
  | ServerSdkEventBatch
  | ServerPermissionRequest
  | ServerPlanProposed
  | ServerPendingControl
  | ServerSessionsUpdate
  | ServerStateUpdate
  | ServerHeartbeat
  | ServerSyncStatus
  | ServerError;
