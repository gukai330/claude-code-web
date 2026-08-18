// A tool Claude can call to flag work that is worth doing but does not belong
// in the current conversation. It renders as a card the user can turn into its
// own session with one click — nothing is started without them.
//
// This runs in-process (createSdkMcpServer), so the handler simply hands the
// suggestion back to the session that owns it. No subprocess, no transport.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionSuggestion } from '../protocol.js';

export const SUGGESTION_SERVER_NAME = 'claudecode-web';
export const SUGGEST_SESSION_TOOL = `mcp__${SUGGESTION_SERVER_NAME}__suggest_session`;

const TITLE_MAX = 60;
const PROMPT_MAX = 2000;
const REASON_MAX = 300;

const DESCRIPTION = [
  'Flag an out-of-scope issue for a separate session.',
  '',
  'Call this when you notice something worth fixing that would bloat the current',
  'change — dead code, stale docs, missing coverage, a confirmed TODO, or a bug',
  'spotted in passing. Do not call it for vague code-smell observations, trivial',
  'fixes you can do inline, or low-confidence hunches.',
  '',
  'The prompt must stand alone: include file paths and enough context to act on',
  'without this conversation. A card appears for the user; one click spins it off.',
  'Your current turn continues uninterrupted — nothing is started unless they ask.',
].join('\n');

/**
 * @param onSuggest called once per accepted suggestion, on the session that
 *   owns this server instance.
 */
export function createSuggestionServer(onSuggest: (suggestion: SessionSuggestion) => void) {
  return createSdkMcpServer({
    name: SUGGESTION_SERVER_NAME,
    version: '0.1.0',
    // Always loaded: a tool hidden behind tool search is one the model never
    // remembers it has, and this one is only useful if it comes to mind
    // unprompted.
    alwaysLoad: true,
    tools: [
      tool(
        'suggest_session',
        DESCRIPTION,
        {
          title: z
            .string()
            .min(1)
            .max(TITLE_MAX)
            .describe('Imperative action phrase, under 60 chars, e.g. "Fix stale README badge"'),
          prompt: z
            .string()
            .min(1)
            .max(PROMPT_MAX)
            .describe('Self-contained first message for the new session, including file paths'),
          reason: z
            .string()
            .min(1)
            .max(REASON_MAX)
            .describe('One sentence in plain English: what it is and why it is worth doing'),
        },
        async (args) => {
          const suggestion: SessionSuggestion = {
            id: randomUUID(),
            title: args.title.trim(),
            prompt: args.prompt.trim(),
            reason: args.reason.trim(),
            createdAt: Date.now(),
          };
          onSuggest(suggestion);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Suggested "${suggestion.title}" to the user as a separate session. Continue with the current task.`,
              },
            ],
          };
        }
      ),
    ],
  });
}
