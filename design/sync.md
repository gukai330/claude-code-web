# Bidirectional project sync

Status: **all four build steps done** (server and UI), uncommitted.

## Problem

Claude Code runs on the server; that is fixed and non-negotiable (all API
traffic must originate there). But the user also wants the project files on the
client laptop — to preview and make small edits locally, and to keep working
when travelling on a poor link.

So the same project has to exist on both machines and stay consistent.

## Rejected alternatives

**Mount the client on the server (SSHFS).** Elegant on paper: Claude's native
Read/Edit/Glob/Grep would just work. In practice it is the worst possible fit —
Claude's access pattern is thousands of small `stat`/`open`/`read` calls while
exploring a repo, and every one is a network round trip. On a high-latency link
a single `grep -r` goes from milliseconds to minutes. Rejected on performance.

**Continuous sync (Syncthing).** Wrong consistency model here. Claude is
actively writing files; a background syncer mutating the same tree mid-turn
produces spurious conflicts and can capture half-written state. Also would need
a resident daemon on the client.

**rsync in both directions.** rsync is one-directional and has no concept of
conflict — it compares timestamps and the later run silently overwrites. With
`--delete` on both sides it will happily delete real work.

**Driving sync from a prompt.** See "Why this is code, not a prompt" below.

## Design

**unison over SSH, driven by the server, at turn boundaries.**

`unison` is the right tool because it keeps state from the previous sync, so it
can distinguish "only one side changed" from "both sides changed", and it
refuses to act on a true conflict rather than guessing.

### Connectivity

Reuse the tunnel the client already opens; add a reverse forward so the server
can reach back:

```
ssh -N -L 18080:127.0.0.1:8080 -R 2222:127.0.0.1:22 home
```

The client dials out, so NAT and dynamic IPs are irrelevant. Requires OpenSSH
**Server** enabled on the Windows client, and `unison` installed on both ends
(unison is version-sensitive across the wire).

### Trigger points

Sync runs at the two natural transaction boundaries, when Claude is *not*
touching the tree:

```
user sends message ──▶ ① pull client→server ──▶ Claude works ──▶ idle ──▶ ② push server→client
```

- **① before send** — `ws.ts`, in the `ClientUserMessage` handler, before
  `session.send(text)`. Must be awaited: Claude must not start on a stale tree.
- **② after turn** — when `runtimeStatus` transitions to `idle`. May run async,
  but progress must be pushed to the UI.

As built, both live in `SyncCoordinator`, not in `ClaudeSession`. ② watches the
snapshots `SessionManager` already broadcasts for a working→idle transition, so
the session layer needs no changes and stays unaware that sync exists. Viewer
sessions are skipped — they never spawn a process, so they cannot have edited
the tree.

① blocks on anything that is not `ok`, conflicts included: if both sides
changed, the tree Claude would start on is not the one the user is looking at.

Sync state needs a frame in `protocol.ts` so the UI can show progress and
surface conflicts — on a weak link a silent multi-second pause reads as a hang.

### Conflict policy

Directional preference, because the two hook points have different semantics:

| Point | Prefer | Rationale |
|---|---|---|
| ① before send | client | Claude has not acted yet this turn; the server should have no new edits |
| ② after turn | server | Claude's edits were deliberate |
| genuine conflict (both sides changed) | **neither** | stop, keep both, report to the UI |

Never silently last-writer-wins. unison's default is to skip and report, which
is what we want.

The table's per-hook preference and the "genuine conflict → neither" rule
cannot both hold — `-prefer <root>` *is* silent last-writer-wins for that side.
The code resolves it in favour of the last row: `SyncManager.sync()` takes
`prefer: 'none' | 'client' | 'server'`, defaults to `'none'` (no `-prefer`
flag, so unison skips and reports), and nothing selects a direction implicitly.
When the hooks land, choosing `'client'` at ① is an explicit decision to accept
last-writer-wins there.

**Conflict merge is the one part that belongs to Claude.** Detection is
mechanical and lives in code; deciding how to reconcile two divergent versions
of a source file needs to understand the code. Hand the two versions to Claude
*on explicit user action*, not automatically.

### Configuration

Server-side, keyed by project path — **not** a file inside the project:

```jsonc
// ~/.claudecode-web/sync.json
{
  "/home/gukai/projects/foo": {
    "enabled": true,
    "remote": "ssh://aria@localhost:2222//C:/Users/aria/proj/foo",
    "ignore": ["Path node_modules", "Path .git", "Path dist"],
    "syncOnSend": true,
    "syncOnIdle": true
  }
}
```

A file in the project would either pollute the repo or need a `.gitignore`
entry, and the server↔client path mapping is machine-specific anyway — the same
project on a different laptop has a different path. `~/.claudecode-web/` already
holds the token and `launcher.json`.

As built, one shared client connection plus a path per project — the same
shape whether the link is a reverse tunnel or a direct LAN address:

```jsonc
// ~/.claudecode-web/sync.json
{
  "client": { "user": "gukai", "host": "192.168.0.30", "port": 22 },
  "projects": {
    "/home/gukai/projects/foo": {
      "enabled": true,
      "localPath": "C:/Users/Gukai/proj/foo",
      "ignore": ["Path node_modules", "Path .git", "Path dist"],
      "syncOnSend": true,
      "syncOnIdle": true
    }
  }
}
```

`localPath` + `client` compose into `ssh://user@host//C:/Users/Gukai/proj/foo`;
a non-default port goes to `-sshargs` rather than into the URI, since not every
unison version parses one there. A per-project `remote` overrides the pair and
needs no client — that is how sync is tested with both roots on the server.

The older shape (a bare map of project path → entry, `remote` required) still
loads; the first machine write migrates it.

Field rules: `remote` or `localPath` is required, everything else optional — `enabled`,
`syncOnSend` and `syncOnIdle` default to true, `ignore` to `[]`. Two fields the
design did not name are there because the reverse tunnel needs them: `sshargs`
(array, e.g. `["-p", "2222"]`, since not every unison version accepts a port
inside the `ssh://` URI) and `timeoutMs` (default 120000 — unison is killed
past it rather than parking a server-side process forever). Whole-line `//`
comments are tolerated; nothing else is, so `ssh://` inside a value is safe.
Ignore specs are validated against unison's `Path`/`Name`/`Regex`/`BelowPath`
prefixes at load time, because a typo there is otherwise a fatal unison error
at sync time. `remote` may be a plain local path, which is how sync gets tested
without a second machine.

unison's archives live in `~/.claudecode-web/unison/`, not `~/.unison`, so this
tool's state never collides with a hand-run unison.

**unison's exit code cannot gate anything.** On 2.51.5 a lost connection and
an unknown option both exit 0, and a skipped conflict exits 1 from Node but 0
from a shell with the identical argv. `SyncManager` classifies on the output
text instead, and treats a run that printed no summary — and did not say
"Nothing to do" — as an error. This is the difference between "sync failed, do
not send" and a silent `ok` at hook ①.

**A typo in `remote` does not fail.** unison creates a missing root and copies
the project into it; syncing two paths that both do not exist reports "Nothing
to do" and exits 0. There is no cheap way to tell a fresh root from a wrong one
over ssh, so this stays the operator's responsibility — check the first run's
transfer count against what you expected.

## Why this is code, not a prompt

The decisive reason is timing: **① happens before Claude is invoked** (no
session exists yet to run it) and **② after the turn has ended**. Both points
are outside Claude's lifecycle.

Beyond that: sync is fully determined by its inputs, so there is no judgement
for a model to add; a failure must surface as a hard error that blocks sending,
not as an improvised workaround on an inconsistent tree; and a fixed
instruction repeated every turn is pure token cost.

## Build order

1. ~~`server/src/sync/SyncManager.ts` — config, invoke unison, parse output,
   report status. Plus a manual trigger endpoint.~~ **Done.** `GET /api/sync`
   for status, `POST /api/sync` to run. Covered by
   `server/src/__tests__/sync-manager.test.ts`, which drives a stub binary so
   every outcome is exercised without a second machine.
2. ~~Test sync in isolation via that endpoint. Verify conflicts are detected and
   nothing is clobbered, before any lifecycle coupling.~~ **Done**, against
   unison 2.51.5 on the server via `/tmp/ccw-smoke.sh`: a clean run propagated
   one file; a both-sides edit of the same file came back
   `outcome: "conflicts"` naming `shared.txt` with `contents changed on both
   sides`, and both copies were byte-identical to their pre-sync checksums.
   The exercise also produced the exit-code finding below.
3. Wire ① and ②, add the protocol frame and UI status. **Server half done**:
   `SyncCoordinator` owns both hooks, `ServerSyncStatus` carries progress, and
   ① is verified over a real websocket — a staged conflict produced
   `running` → `done(conflicts)` → `error` with no `sdk_event` at all, so
   Claude was never invoked and both copies stayed byte-identical. ② is covered
   by unit tests and by a live turn: Claude wrote a file on the server, and
   `after_turn` propagated it to the client side with nobody asking.
   **UI done**: the project picker grows a "Sync Folder" option that writes the
   client connection and the folder on the user's own machine, and the status
   bar reports a sync in progress, so the pause at ① is never a silent one.
   A conflict from ② lands in the transcript as a system message; one from ①
   arrives as the blocking error, and is deliberately not reported twice.
4. ~~Conflict UI, with optional "let Claude merge".~~ **Done.** A red sync
   status offers "Resolve →", which opens the conflicting set. Per file:
   keep the server's copy, keep the client's, or hand both to Claude. The
   first two run unison restricted to that path with a `-prefer`; the third
   copies the client's version into the OS temp dir and sends a prompt naming
   both files and where the result goes, then lets Claude do the merge —
   detection is mechanical, reconciliation is not.

Step 2 exists so a sync bug and a lifecycle bug can never be confused.

## Open question

Large files. The idea of routing them through a third-party drive (Quark) is
only worth it if client→drive→server is genuinely faster than client→server
directly — the second leg is an overseas server reaching a domestic Chinese
service, which is not obviously fast. **Measure both before building anything.**
Default position: exclude large files from sync via ignore rules and move them
manually when actually needed.
