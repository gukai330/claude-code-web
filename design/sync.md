# Bidirectional project sync

Status: **designed, not built.**

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
- **② after turn** — `ClaudeSession`, when `runtimeStatus` transitions to
  `idle`. May run async, but progress must be pushed to the UI.

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

## Why this is code, not a prompt

The decisive reason is timing: **① happens before Claude is invoked** (no
session exists yet to run it) and **② after the turn has ended**. Both points
are outside Claude's lifecycle.

Beyond that: sync is fully determined by its inputs, so there is no judgement
for a model to add; a failure must surface as a hard error that blocks sending,
not as an improvised workaround on an inconsistent tree; and a fixed
instruction repeated every turn is pure token cost.

## Build order

1. `server/src/sync/SyncManager.ts` — config, invoke unison, parse output,
   report status. Plus a manual trigger endpoint.
2. Test sync in isolation via that endpoint. Verify conflicts are detected and
   nothing is clobbered, before any lifecycle coupling.
3. Wire ① and ②, add the protocol frame and UI status.
4. Conflict UI, with optional "let Claude merge".

Step 2 exists so a sync bug and a lifecycle bug can never be confused.

## Open question

Large files. The idea of routing them through a third-party drive (Quark) is
only worth it if client→drive→server is genuinely faster than client→server
directly — the second leg is an overseas server reaching a domestic Chinese
service, which is not obviously fast. **Measure both before building anything.**
Default position: exclude large files from sync via ignore rules and move them
manually when actually needed.
