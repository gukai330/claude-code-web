import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActiveToolInfo, ChatItem, SessionSuggestion } from '../types';
import { Icon } from './Icon';
import type { SkinId } from '../skins';
import { ToolUse } from './ToolUse';
import { DiffBlock } from './DiffBlock';
import { MarkdownMessage } from './MarkdownMessage';
import { splitStableMarkdown, useSmoothStreamText } from '../streaming';
import { isEditLikeTool, shouldHideToolInTranscript } from '../toolDisplay';
import { cleanStreamingAssistantText } from '../assistantText';
import { contentForSkin, statusCopyForSkin } from '../skinContent';
import { assetUrl } from '../appUrl';
const STICK_THRESHOLD = 80; // px from bottom still counts as "at bottom"
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type Props = {
  sessionKey: string;
  scrollPositions: Map<string, number | 'bottom'>;
  token: string;
  cwd: string;
  skin: SkinId;
  items: ChatItem[];
  busy: boolean;
  streamingText: string;
  pendingByToolUseId: Map<string, string>;
  secondsSinceLastEvent: number;
  activeTool?: ActiveToolInfo;
  onAcceptEdit: (reqId: string) => void;
  onRejectEdit: (reqId: string) => void;
  onStop: () => void;
  /** Start a side chat sliced at this message. */
  onBranch?: (uuid: string) => void;
  /** Parent session id, so a Task card can read its subagent transcript. */
  claudeSessionId?: string;
  /** Background a running tool without interrupting the turn. */
  onBackground?: (toolUseId: string) => void;
  /** Turn one of Claude's suggestions into its own session. */
  onStartSuggestion?: (suggestion: SessionSuggestion) => void;
};

function MessageListImpl({ sessionKey, scrollPositions, token, cwd, skin, items, busy, streamingText, pendingByToolUseId, secondsSinceLastEvent, activeTool, onAcceptEdit, onRejectEdit, onStop, onBranch, onStartSuggestion, claudeSessionId, onBackground }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const content = contentForSkin(skin);
  const visibleItems = useMemo(() => items.filter((it) => !shouldHideToolInTranscript(it)), [items]);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Detect whether the user has scrolled up to read earlier messages. We only
  // auto-scroll when they're already at (or near) the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const sticky = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
      stickToBottomRef.current = sticky;
      setShowJump(!sticky);
      scrollPositions.set(sessionKey, sticky ? 'bottom' : el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      const sticky = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
      scrollPositions.set(sessionKey, sticky ? 'bottom' : el.scrollTop);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollPositions, sessionKey]);

  // A seen session returns to its exact reading position. A session without a
  // snapshot opens at the latest message. The component is keyed by session,
  // so stream animation and Jump state cannot leak across switches.
  useIsoLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const saved = scrollPositions.get(sessionKey);
    if (saved === undefined || saved === 'bottom') {
      stickToBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      stickToBottomRef.current = false;
      el.scrollTop = saved;
      setShowJump(true);
    }
  }, [scrollPositions, sessionKey]);

  // Scroll on new message (items count change) only. Not on stream deltas.
  // Use layout effect + instant behavior — "smooth" looks laggy when 900
  // replayed items arrive in a single batch.
  useIsoLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [items.length]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollerRef} className="message-scroller h-full overflow-y-auto">
      <div ref={contentRef} className="message-list-content min-h-full max-w-[720px] mx-auto px-6 pt-8 pb-44 flex flex-col justify-end gap-[18px]">
        {visibleItems.map((it) => (
          <Bubble
            key={it.id}
            item={it}
            token={token}
            cwd={cwd}
            skin={skin}
            pendingByToolUseId={pendingByToolUseId}
            onAcceptEdit={onAcceptEdit}
            onRejectEdit={onRejectEdit}
            onBranch={onBranch}
            onStartSuggestion={onStartSuggestion}
            claudeSessionId={claudeSessionId}
            onBackground={onBackground}
          />
        ))}
        {streamingText && busy && (
          <StreamingMessage text={streamingText} token={token} cwd={cwd} skin={skin} />
        )}
        {busy && !streamingText && <ThinkingState skin={skin} secondsSinceLastEvent={secondsSinceLastEvent} activeTool={activeTool} onStop={onStop} />}
        <div ref={endRef} />
      </div>
      </div>
      {showJump && (
        <button
          onClick={() => { stickToBottomRef.current = true; setShowJump(false); scrollToBottom(); }}
          className="jump-latest-button absolute left-1/2 -translate-x-1/2 bottom-36 px-3 py-1.5 rounded-full bg-bg-surface border border-border text-xs text-text-secondary hover:text-text-primary hover:border-accent/50 shadow-pop transition-all duration-hover"
        >
          {content.status.jumpToLatest}
        </button>
      )}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);

type BubbleProps = { item: ChatItem } & Pick<Props, 'token' | 'cwd' | 'skin' | 'pendingByToolUseId' | 'onAcceptEdit' | 'onRejectEdit' | 'onBranch' | 'onStartSuggestion' | 'claudeSessionId' | 'onBackground'>;

/**
 * Start a side chat from this point. Only offered where the transcript id is
 * known: an optimistic echo has no id yet, and slicing needs one.
 */
function BranchButton({ uuid, onBranch }: { uuid?: string; onBranch?: (uuid: string) => void }) {
  if (!uuid || !onBranch) return null;
  return (
    <button
      type="button"
      onClick={() => onBranch(uuid)}
      title="Start a side chat from here — this conversation is left as it is"
      aria-label="Start a side chat from this message"
      className="mt-1 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-text-muted opacity-0 transition-opacity duration-hover hover:bg-bg-hover hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
    >
      Branch
    </button>
  );
}

const Bubble = memo(function Bubble({ item, token, cwd, skin, pendingByToolUseId, onAcceptEdit, onRejectEdit, onBranch, onStartSuggestion, claudeSessionId, onBackground }: BubbleProps) {
  const content = contentForSkin(skin);
  if (item.kind === 'user') {
    return (
      <div className={`group skin-message-row skin-message-user ${content.decor.messageClass} animate-fade-up flex items-start justify-end gap-1 ${item.optimistic ? 'opacity-85' : ''}`}>
        <BranchButton uuid={item.uuid} onBranch={onBranch} />
        <div className="skin-message-bubble skin-user-bubble max-w-[80%] px-4 py-2.5 text-text-primary whitespace-pre-wrap bg-bg-accent-soft border border-accent/15 rounded-[14px_14px_4px_14px]">
          {item.text}
        </div>
        {showMessageAvatar(skin) && <MessageAvatar skin={skin} role="user" label={content.message.userLabel} />}
      </div>
    );
  }
  if (item.kind === 'assistant_text') {
    return (
      <div className="group relative">
        <AssistantShell skin={skin} animated={!item.streamed}>
          <MarkdownMessage text={item.text} token={token} cwd={cwd} />
        </AssistantShell>
        <div className="absolute right-0 top-0">
          <BranchButton uuid={item.uuid} onBranch={onBranch} />
        </div>
      </div>
    );
  }
  if (item.kind === 'thinking') {
    return (
      <details className="animate-fade-up text-text-muted text-xs pl-3 border-l-2 border-border cursor-pointer group">
        <summary className="select-none hover:text-text-secondary transition-colors duration-hover list-none">
          <span className="inline-flex items-center gap-1.5">
            <span>{content.message.thoughtSummary}</span>
          </span>
        </summary>
        <div className="mt-1.5 text-text-secondary"><MarkdownMessage text={item.text} compact token={token} cwd={cwd} /></div>
      </details>
    );
  }
  if (item.kind === 'tool_use') {
    if (isEditLikeTool(item)) {
      const pendingReqId = pendingByToolUseId.get(item.toolUseId);
      return <div className="animate-fade-up"><DiffBlock item={item} pendingReqId={pendingReqId} onAccept={onAcceptEdit} onReject={onRejectEdit} /></div>;
    }
    return <div className="animate-fade-up"><ToolUse item={item} defaultOpen={!!item.result?.isError} token={token} cwd={cwd} claudeSessionId={claudeSessionId} onBackground={onBackground} /></div>;
  }
  if (item.kind === 'suggestion') {
    return <SuggestionCard suggestion={item.suggestion} onStart={onStartSuggestion} />;
  }
  return (
    <div className={`animate-fade-up text-xs px-3 py-2 rounded-sm ${item.level === 'error' ? 'bg-danger/10 text-danger' : 'bg-bg-raised/60 text-text-muted'}`}>{item.text}</div>
  );
});

/**
 * Work Claude noticed that does not belong in this conversation. Claude raises
 * it; nothing happens until the user says so — the point is to keep the current
 * turn from sprawling, not to start a second one behind their back.
 */
function SuggestionCard({
  suggestion,
  onStart,
}: {
  suggestion: SessionSuggestion;
  onStart?: (suggestion: SessionSuggestion) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="animate-fade-up rounded-md border border-accent/25 bg-bg-accent-soft/40 p-3">
      <div className="flex items-start gap-2">
        <Icon name="sparkles" size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-text-primary">{suggestion.title}</div>
          <div className="mt-0.5 text-[11px] text-text-secondary">{suggestion.reason}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {onStart && (
          <button
            type="button"
            onClick={() => onStart(suggestion)}
            className="h-7 rounded-sm bg-accent px-2.5 text-[11px] font-medium text-text-inverse hover:bg-accent-hi transition-colors duration-hover"
          >
            Start a session for this
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="h-7 rounded-sm px-2 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors duration-hover"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

function ThinkingState({ skin, secondsSinceLastEvent, activeTool, onStop }: { skin: SkinId; secondsSinceLastEvent: number; activeTool?: ActiveToolInfo; onStop: () => void }) {
  const content = contentForSkin(skin);
  if (activeTool) {
    const copy = statusCopyForSkin(skin, {
      kind: 'running-tool',
      name: activeTool.name,
      seconds: secondsSinceLastEvent,
      inputSummary: activeTool.inputSummary,
    });
    return (
      <div className="text-sm text-text-secondary bg-bg-raised/60 border border-border-subtle rounded-md px-3 py-2 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {copy.label}
          {copy.hint ? ` · ${copy.hint}` : ''}
        </span>
        <button
          onClick={onStop}
          className="shrink-0 px-2 py-1 rounded-sm bg-bg-hover hover:bg-bg-surface text-[11px] font-medium transition-colors duration-hover"
        >
          {content.status.stop}
        </button>
      </div>
    );
  }
  if (secondsSinceLastEvent >= 15) {
    const copy = statusCopyForSkin(skin, { kind: 'stalled', seconds: secondsSinceLastEvent });
    return (
      <div className="text-sm text-warning bg-warning/10 border border-warning/25 rounded-md px-3 py-2 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
        <span className="min-w-0 flex-1">{copy.label}. {copy.hint}</span>
        <button
          onClick={onStop}
          className="shrink-0 px-2 py-1 rounded-sm bg-warning/10 hover:bg-warning/20 text-[11px] font-medium transition-colors duration-hover"
        >
          {content.status.stop}
        </button>
      </div>
    );
  }
  const copy = statusCopyForSkin(skin, { kind: 'thinking' });
  return <div className="text-sm text-text-muted">{copy.label}<span className="cursor-bar ml-1" /></div>;
}

function StreamingMessage({ text, token, cwd, skin }: { text: string; token: string; cwd: string; skin: SkinId }) {
  const visible = useSmoothStreamText(cleanStreamingAssistantText(text));
  if (!visible) return null;
  const split = useMemo(() => splitStableMarkdown(visible), [visible]);
  if (!split.tail) {
    return (
      <AssistantShell skin={skin}>
        <MarkdownMessage text={split.stable} streaming token={token} cwd={cwd} />
      </AssistantShell>
    );
  }
  return (
    <AssistantShell skin={skin}>
      {split.stable && <MarkdownMessage text={split.stable} token={token} cwd={cwd} />}
      <pre className="font-mono text-xs leading-[1.65] text-text-primary whitespace-pre-wrap break-words my-2">
        {split.tail}
        <span className="cursor-bar" />
      </pre>
    </AssistantShell>
  );
}

function AssistantShell({ skin, animated = false, children }: { skin: SkinId; animated?: boolean; children: ReactNode }) {
  const content = contentForSkin(skin);
  return (
    <div className={`skin-message-row skin-message-assistant ${content.decor.messageClass} ${animated ? 'animate-fade-up' : ''}`}>
      {showMessageAvatar(skin) && <MessageAvatar skin={skin} role="assistant" label={content.message.assistantLabel} />}
      <div className="skin-assistant-body min-w-0 flex-1">{children}</div>
    </div>
  );
}

function MessageAvatar({ skin, role, label }: { skin: SkinId; role: 'user' | 'assistant'; label: string }) {
  const short = skin === 'catgirl'
    ? role === 'assistant' ? '喵' : '主'
    : skin === 'wechat'
      ? role === 'assistant' ? '{}' : 'Me'
      : skin === 'emochi'
        ? role === 'assistant' ? 'M' : 'You'
        : role === 'assistant' ? 'AI' : 'YOU';
  return (
    <div className={`skin-avatar skin-avatar-${role}`} title={label} aria-label={label}>
      {(skin === 'emochi' || skin === 'wechat') && role === 'assistant' ? (
        <img className="skin-avatar-image" src={skin === 'emochi' ? assetUrl('/assets/emochi_logo.png') : assetUrl('/assets/wechat_logo.svg')} alt="" />
      ) : (
        short
      )}
    </div>
  );
}

function showMessageAvatar(skin: SkinId): boolean {
  return skin === 'wechat' || skin === 'catgirl' || skin === 'cyberpunk' || skin === 'emochi';
}
