# @synara/session-sync

Background daemon that mirrors provider-native agent sessions into Synara.

Any Claude Code or Codex session created **anywhere on this machine** — T3 Code,
a terminal CLI, another GUI — is discovered automatically and imported into
Synara as a resumable thread (project auto-created per working directory,
history replayed, provider session bound).

## Why one direction only

Both tools are frontends over the same agent CLIs, and the CLIs own the real
transcripts. Synara exposes a supported import RPC (`orchestration.importThread`),
so anything can be pulled **into** it. T3 Code currently has no import/resume
entry point in its API surface (verified against its full WS method list), so
nothing can push threads into it externally without patching it. If T3 Code
grows an import seam, this daemon is the natural place to call it.

Because imports bind the _provider-native_ session, the same conversation stays
resumable from any tool that reads the provider's own storage.

## How it works

1. Discovers sessions:
   - Claude Code: scans `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (cwd + title
     parsed from the transcript; directory names are deliberately not decoded —
     they are lossy).
   - Codex: keeps one long-lived `codex app-server` child and polls
     `thread/list`, which survives codex storage-format changes.
2. Decides per session via a persisted state file (`state.json`): unseen
   sessions outside the quiet period get imported exactly once.
3. For each import: finds or creates the Synara project whose workspace root
   matches the session cwd, dispatches `thread.create`, then calls
   `orchestration.importThread`. Failed imports roll back their placeholder
   thread and are recorded as `failed` (no infinite retries).

First run with an empty state marks every existing session as seen
("baseline") instead of importing history; opt in with
`SESSION_SYNC_BACKFILL=1`.

The connection reuses Synara's public contract constants (protocol epoch,
revision negotiation) from `@synara/contracts` and authenticates like a local
owner (`?token=` on loopback), so no Synara or T3 Code build is patched.

## Running

```sh
bun run dev            # from apps/session-sync
```

Install as a persistent user service:

```sh
cp scripts/synara-session-sync.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now synara-session-sync.service
journalctl --user -u synara-session-sync.service -f
```

## Configuration (environment)

| Variable                                   | Default                                              | Meaning                                                       |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| `SESSION_SYNC_URL`                         | origin from `~/.synara/userdata/server-runtime.json` | Synara server to sync into                                    |
| `SESSION_SYNC_TOKEN` / `SYNARA_AUTH_TOKEN` | none                                                 | Owner token for non-loopback/token-protected instances        |
| `SESSION_SYNC_STATE_PATH`                  | `$XDG_STATE_HOME/synara-session-sync/state.json`     | Dedup/ledger file                                             |
| `SESSION_SYNC_SCAN_INTERVAL_MS`            | `15000`                                              | Discovery cadence                                             |
| `SESSION_SYNC_QUIET_MS`                    | `120000`                                             | Skip sessions modified this recently (avoid mid-turn imports) |
| `SESSION_SYNC_CLAUDE_ROOT`                 | `$CLAUDE_CONFIG_DIR/projects`                        | Claude transcript root                                        |
| `SESSION_SYNC_DISABLE_CODEX`               | unset                                                | Set to `1` to disable the codex poller                        |
| `SESSION_SYNC_CODEX_BIN`                   | `codex`                                              | Codex binary used for `app-server`                            |
| `SESSION_SYNC_BACKFILL`                    | off                                                  | Import pre-existing sessions on first contact                 |
| `SESSION_SYNC_DEFAULT_CLAUDE_MODEL`        | `claude-sonnet-5`                                    | Model for created threads when the project has no default     |
| `SESSION_SYNC_DEFAULT_CODEX_MODEL`         | `gpt-5.6-sol`                                        | Same for codex                                                |

## Limitations

- Imports snapshot a session at rest; later messages appended to the same
  provider session by another tool are not re-synced (the binding is
  single-shot, matching Synara's manual import). Resume the thread in Synara to
  continue it there.
- Deleting the state file makes the daemon consider everything unimported
  again; keep it on stable storage.
- Sessions whose transcript lacks a usable `cwd` cannot be placed under a
  project and are skipped (counted in logs).
