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

## Closer to the Claude app

Everything below came from asking the SDK for things the fork was doing
without, or not doing at all. All of it is on `feat/project-sync`, uncommitted
to any remote.

- **Side chats.** `forkSession(id, {upToMessageId})` branches a transcript at
  one message; the original is untouched, which is the difference from a
  rewind. Slicing needs the transcript's own message id, so `uuid` now survives
  from SDK event to `ChatItem` — including at the moment an optimistic echo is
  confirmed. An item without one does not offer the affordance.
- **Session suggestions.** An in-process MCP tool (`createSdkMcpServer`, so no
  subprocess) that Claude calls to flag work belonging in its own session. It
  renders as a card; nothing starts unless the user clicks. Auto-allowed in
  `canUseTool` — suggesting touches nothing, and prompting for it would train
  people to dismiss prompts. Carried as a **synthetic event in the replay ring**
  (`ccw_session_suggestion`) rather than a side channel, so a card keeps its
  place in the transcript across a reconnect.
- **Context usage.** `getContextUsage()` per category, refreshed once per turn
  end — it is a control request, so it costs a round trip, and that is the one
  moment the number has changed and stopped moving. Tokens and cost were
  already on the snapshot and simply never shown.
- **Real slash commands.** `supportedCommands()` replaces a hardcoded list of
  five UI actions. Cached **per cwd**, unlike the model list: commands come
  from project settings and plugins, so two projects legitimately disagree.
  The five names this client implements itself are filtered out.
- **Subagent transcripts.** `listSubagents` / `getSubagentMessages` on a Task
  card. Listed, not matched: the SDK does not say which Task call produced
  which subagent id, and a guessed pairing would be worse than an honest list.
  Not yet exercised against a real Task run.
- **Background + MCP.** `backgroundTasks(toolUseId)` is the SDK's Ctrl+B, on a
  running tool card. `mcpServerStatus()` drives a chip that is quiet when
  everything is connected and loud when something failed. Neither is on
  `AgentSession`, so neither forces `CodexSession` to implement an SDK-specific
  control request — both are reached by a duck-typed check.

## Environment gotchas

- **UI components cannot be render-tested if they draw an `<Icon>`.**
  `Icon.tsx`'s only react import is `import type { SVGProps }`, so under
  `tsx --test` (which finds no tsconfig from the repo root and falls back to
  the classic JSX transform) the emitted `React.createElement` has nothing to
  bind to: `ReferenceError: React is not defined`. Existing render tests pass
  only because they never reach a branch that draws one. Test the pure
  functions instead — that is why `sync-ui.test.ts` asserts on `deriveStatus`
  and `previewRemote` rather than on markup.
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
- **unison must be installed on both ends and the versions must match** — it
  negotiates a wire protocol and refuses to run across a mismatch. Ubuntu
  jammy ships 2.51.5; the official Windows builds are on the project's GitHub
  releases, so pick a version that exists for both. `SyncManager` reports a
  missing binary as `outcome: "unavailable"` rather than failing the sync, and
  re-probes on every call so installing it needs no server restart.

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

Bidirectional file sync — [design/sync.md](design/sync.md) has the design and
the reasoning behind the rejected alternatives. **All four build steps are
done and uncommitted**, server and UI.
`~/.claudecode-web/sync.json` currently holds a throwaway `/tmp/ccw-sync`
entry, not a real project. Four scripts drive the live checks:
`/tmp/ccw-smoke.sh` (sync + conflict), `/tmp/ccw-config.sh` (config
endpoints), `/tmp/ccw-hook.sh` (hook ① over a real websocket, spends no
tokens because the block happens before Claude is invoked), `/tmp/ccw-turn.sh`
(a real Claude turn, to prove hook ② propagates what it wrote).

**`web/dist` is not rebuilt.** The server on 8080 runs `server/dist` and
serves `web/dist`, both predating this work, so none of it is live until
someone rebuilds and restarts. Both bundles resolve the *same* `web/dist`
path, so a UI built from this tree cannot be previewed without displacing the
running one — back it up first if you try.

- `server/src/sync/SyncManager.ts` owns config, unison invocation and output
  parsing, and nothing else — it has no reference to sessions or the websocket.
  Constructed once in `index.ts` and passed to `registerApi`, so the hooks can
  share the instance later.
- `server/src/sync/SyncCoordinator.ts` is the only place that knows about both
  sessions and sync. It reads idle transitions off the snapshots
  `SessionManager` already broadcasts, so **`SessionManager` is not modified at
  all** — no new coupling in the session layer.
- Endpoints, all token-gated:
  - `GET /api/sync?cwd=` — config, composed remote, unison availability, last
    result. `POST /api/sync {cwd, prefer?}` — run it now. `cwd` *selects* an
    entry in `~/.claudecode-web/sync.json` and can never define one, so a token
    holder cannot aim the endpoint at an arbitrary directory pair.
  - `POST /api/sync/project {cwd, localPath|remote, …}` / `DELETE
    /api/sync/project?cwd=` — the write side, which the project picker's
    "sync directory" option will call. Patch semantics: absent leaves a field
    alone, `null` clears it.
  - `POST /api/sync/client {client}` — how the server reaches the client,
    shared by every project.
- **`localPath` is composed, not stored raw.** One `client` block
  (`{user, host, port}`) plus a per-project `localPath` becomes
  `ssh://user@host//C:/Users/me/proj`, with a non-default port going to
  `-sshargs "-p N"` because not every unison version parses a port inside the
  URI. Backslashes are normalised — a URI cannot carry them. Whether the link
  is a reverse tunnel (`localhost:2222`) or a direct LAN address
  (`192.168.0.30:22`) only changes those values, never the code.
- The config file has two shapes: the original bare map of project path →
  entry, and the current one nesting them under `projects` alongside `client`.
  Both are read; only the current one is written, so the first write migrates.
  Writes are read-modify-write under a single-writer chain, then
  write-tmp-and-rename — a crash mid-write must not leave a truncated file that
  reads as "no projects configured". A machine write drops `//` comments.
- UI: `web/src/components/SyncFolderPanel.tsx` is the "sync directory" option
  in the project picker — one shared client connection plus the folder on the
  user's own machine, with a live preview of the composed unison root.
  Saving a `localPath` deliberately clears any hand-written `remote`, because
  `remote` outranks it on the server and would otherwise silently ignore the
  path just typed. `StatusBar` grows a `syncing` state so a multi-second pause
  before a message is sent does not read as a hang.
- Conflict resolution is per-file and always explicit. `POST /api/sync/resolve
  {cwd, path, side}` runs unison restricted to that one path
  (`-path <p> -prefer <root>`), so choosing a winner cannot disturb the rest of
  the tree. **This is the only place last-writer-wins is allowed**, because a
  person asked for it by name. `POST /api/sync/client-version` copies the
  client's copy into the OS temp dir — never into the project, which is still
  mid-conflict — so "let Claude merge" can hand over both versions as a prompt.
  Paths are validated by `safeRelativePath` at the endpoint (a caller's bad
  path is a 400) *and* in the manager, since the manager is also called by the
  hooks.
- **Hook ① blocks the send unless the outcome is exactly `ok`.** Conflicts
  block too: both sides changed, so the tree Claude would start on is not the
  one the user is looking at. The frame sequence a client sees is
  `sync_status(running)` → `sync_status(done)` → `error`, and `sendUser` is
  never reached. Hook ② is fire-and-forget after the turn and blocks nothing.
- **Conflicts are HTTP 200** with `outcome: "conflicts"` — unison ran and
  refused to guess, which is a result, not a transport failure. 409 = not
  configured or disabled, 503 = unison missing, 500 = unison failed.
- **`prefer` defaults to `none` and nothing selects otherwise.** `client` /
  `server` map to unison's `-prefer <root>`, which is silent last-writer-wins;
  the design forbids that for a genuine conflict. The directional values exist
  for the hooks to opt into deliberately — the design's per-hook preference
  table and its "genuine conflict → neither" rule cannot both hold, and this
  code resolves that in favour of the latter.
- unison has no machine-readable output, so `parseUnisonOutput` reads the text
  UI: the `Synchronization complete/incomplete at … (N transferred, M skipped,
  K failed)` line plus the `skipped:`/`failed:` details printed under it, with
  the `[CONFLICT] Skipping …` and `<-?->` markers as a fallback when unison
  dies early. Formats captured from a real 2.51.5, not taken from the manual.
- **unison's exit code is not usable and nothing here reads it as truth.**
  Measured on 2.51.5: `Fatal error: Lost connection with the server` and
  `unison: unknown option` **both exit 0** — the failure cases return the
  success code. A skipped conflict is worse than wrong, it is unstable: exit
  **1** when unison is spawned from Node, **0** when the identical argv runs
  from a shell on the same host. The documented 0/1/2/3 scheme cannot be
  relied on in either direction. `classify()` therefore requires *evidence the
  run finished* — a summary line, or unison's `Nothing to do:` shortcut — and
  treats its absence as an error. Keying off the exit code would report a sync
  that never connected as `ok`, which at hook ① means Claude starting on a
  stale tree.
- The summary line has an optional `N partially transferred` clause that only
  appears when something got stuck mid-copy (an unreadable file, a dropped
  link). It is treated as an error, not a conflict: the item is in neither
  state and the trees do not agree.
