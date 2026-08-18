# claude-code-web (fork)

Fork of [fafawlf/claude-code-web](https://github.com/fafawlf/claude-code-web).
Self-hosted web UI for driving Claude Code, reached over an SSH tunnel.

## Topology

Everything runs on the **server**. The browser only ever talks to `localhost`
through an SSH tunnel — no browser traffic reaches claude.ai.

```
browser (client)  --ssh -L 18080:127.0.0.1:8080-->  server
                                                     ├── claudecode-web (fastify, binds 127.0.0.1:8080)
                                                     └── claude CLI  --> api.anthropic.com
```

The client machine is a Windows laptop; the server is Linux. Both are the
user's own machines. All Anthropic API traffic originates from the server —
that is deliberate and is the reason for this whole arrangement.

Run: `node server/dist/bin/claudecode-web.js --port 8080 --cwd <project>`
Token: `~/.claudecode-web/token` (also echoed in the startup banner).

**Gotcha:** the startup banner prints `http://localhost:8080/?t=...`. If the
tunnel maps a different local port, the port in that URL is wrong — keep the
token, fix the port.

## How it actually works (verified by reading the source, not the README)

- **Invocation is the official Agent SDK**, not a pty and not terminal
  scraping: `query()` from `@anthropic-ai/claude-agent-sdk` in
  `session/ClaudeSession.ts`. Output arrives as structured `SDKMessage`
  objects, which is why the UI can render diff cards and images instead of
  ANSI.
- **Sessions are lazy**: viewer mode loads transcript without spawning a
  process; a fresh chat spawns nothing until the first message.
- **Weak-network handling is real and load-bearing** — do not casually
  refactor these:
  - `session/ReplayBuffer.ts` — bounded by event count (5000) *and* bytes
    (32MB), per-string cap 32KB. `flatStringCopy` deliberately breaks V8's
    sliced-string retention; that is a memory fix, not redundancy.
  - `wsSendQueue.ts` — soft/hard `bufferedAmount` thresholds, 256KB replay
    batching, and **control frames are prioritised over sdk_event frames** so
    permission prompts never starve behind a token flood.
  - The `*-regression.test.ts` files exist because these were real bugs.
- Transcripts live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
  Encoding is `cwd.replace(/\//g, '-')` (`session/claudeTranscript.ts`).
  `findClaudeTranscriptFile` falls back to scanning every directory under
  `~/.claude/projects/` when the direct path misses, so a session opens by ID
  even if the path encoding no longer matches — but `/api/sessions` (SDK
  `listSessions({dir})`) needs an exact match, so a **moved project shows an
  empty session list until its history directory is renamed**.

## Divergence from upstream

Branch `harden/api-file-containment`, two commits. Patch files at the repo
root apply in order to a clean upstream tree (verified in a scratch worktree).

1. **`fix(api): pin /api/file to server-defined roots`** —
   `resolveProjectFile()` trusted the caller-supplied `cwd` as its containment
   root, so `?cwd=/` made every absolute path "in-project", skipping both the
   extension allowlist and the `$HOME` boundary. Any token holder could read
   any file the server process could. Fix validates `cwd` itself and adds an
   unconditional denylist for credential dirs (`.ssh`, `.claude`,
   `.claudecode-web`, `.aws`, `.gnupg`, `.docker`, `.kube`).
2. **`feat(models): source the model list from the SDK`** — the hardcoded
   `MODEL_OPTIONS` had gone stale (no Opus 5 / Sonnet 5). Now fetched via
   `Query.supportedModels()`; `ModelInfo` supplies `displayName`/`description`
   which map onto the picker's label/hint. `server/src/session/modelCatalog.ts`
   caches process-wide with two fill paths (free from a live session, or a
   short-lived probe whose prompt never yields a turn, so it costs no tokens).
   `FALLBACK_MODEL_OPTIONS` remains so the picker can never go blank.

Untracked, not yet committed: `launcher/claude-web-connect.ps1` — a Windows
connect dialog (parses `~/.ssh/config` for Host aliases, ssh-agent/passphrase
handling, opens tunnel + browser). Written but **never tested against a real
remote**.

## Open issues (found during audit, not yet fixed)

- **The token travels in the URL query string** (`?t=...`). It therefore lands
  in browser history *and* in the fastify request log on every request — the
  server's own stdout contains the full token. Two fixes: redact `t=` in the
  log serialiser (small), or move the token to a cookie (WebSocket can't set
  headers, so cookie is the only header-free option; larger change).
- No TLS. Fine inside the tunnel, but `--host` exists, and binding it
  elsewhere would be plaintext.
- A token holder can still read most of `$HOME` (outside the denylist). That
  is by design — the directory picker deliberately has no hard root — and a
  token holder can already run Claude with Bash, so it is not an escalation.
- `resolveSafe()` in `api.ts` is a misnomer: it normalises paths and does no
  containment at all. Easy to misread when adding new endpoints.

## Environment gotchas

- **The test suite assumes a POSIX layout.** On Windows 4–5 tests fail before
  any local change, because `os.tmpdir()` sits *inside* `os.homedir()` there,
  so fixtures that create an "outside the project" directory land inside an
  allowed root. Establish the baseline on an unpatched tree before blaming a
  change. Tests live at the repo root: `npm test`.
- **npm 11+ blocks esbuild's postinstall**, so `npm run build -w web` fails
  until `npm approve-scripts esbuild`. The server build (tsc) is unaffected.
- **Node >= 18** is required by `@anthropic-ai/claude-agent-sdk`; README says
  20+. The repo declares no `engines`, so `npm install` succeeds on older Node
  and only fails at runtime with `SyntaxError: Unexpected token '?'`.
- Git is checked out CRLF on Windows; new files written LF produce a wall of
  harmless `trailing whitespace` warnings from `git apply`.

## Conventions

- Server config lives under `~/.claudecode-web/` (token, launcher.json, and
  sync.json once sync lands).
- `modelOptionsForProvider()` is the single chokepoint the four model-picker
  components consume — change its data source, not the components.
- `provider-ui.test.ts` asserts the picker's first entry equals
  `DEFAULT_CLAUDE_MODEL`. Model list order and the default must change together.
- `DEFAULT_CLAUDE_MODEL` is still `claude-opus-4-8` in
  `server/src/protocol.ts` and `web/src/types.ts`. Changing it alters cost and
  behaviour for every new session — an operator decision, not a refactor.

## In progress

See [design/sync.md](design/sync.md) for the bidirectional file-sync design.
