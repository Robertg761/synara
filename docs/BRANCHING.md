# Branches

This is a fork that does two things at once: it sends focused PRs upstream, and it
runs a build with all of that work applied together. Those two goals fight unless
the branches have distinct jobs.

| Branch                     | Job                                                          | May I commit here?                           |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `main`                     | An exact mirror of `upstream/main`.                          | **No.** `scripts/branches.sh sync` moves it. |
| `canary`                   | Every topic merged onto `upstream/main`. Runs as Canary.     | **No.** It is regenerated.                   |
| `computer-use-linux`       | Linux computer use. → PR #780, sliced as #820–#824           | Yes                                          |
| `computer-use-linux-1..5`  | PR-only slices of `computer-use-linux`. Rebase, never merge. | Only by rebasing the stack                   |
| `codex/computer-use-macos` | macOS computer use. → PR #1010. Not in the rebuild yet.      | Yes                                          |
| `android-app`              | The Android app and remote access.                           | Yes                                          |
| `fork-tooling`             | Session-sync app, this script and document, turbo env fix.   | Yes                                          |

`codex/computer-use-macos` stays out of `TOPICS` for now: it carries slices 1–3 of the
Linux stack plus the macOS backend, and its computer-use core edits collide with slices
4–6 in about 15 files. A Linux canary loses nothing by leaving it out. Add it back once
both stacks sit on a common base.

`claude/computer-use-macos-s1vpp0` is an older all-in-one macOS line that diverged from
`codex/computer-use-macos` on 2026-09-06. It is not part of the rebuild either, until the
two macOS lines are reconciled.

Two backup tags keep history nobody should need: `backup/canary-2026-09-07` is the last
hand-merged Canary, and `pr-media` pins the screenshots PR #823 embeds by commit hash.

## Why canary is derived

The obvious way to keep an everything-branch is to commit to it. That decays: once a
topic lands upstream, its commits exist twice with different hashes, and every later
merge has to reconcile them by hand.

Rebuilding instead makes that disappear. `rebuild` starts from a fresh `upstream/main`
and merges each topic. A topic that has landed upstream has nothing left to contribute,
the script says so, and it drops out on its own.

## Day to day

    scripts/branches.sh status          # what is ahead, what has landed, what is stale
    scripts/branches.sh sync            # move main to upstream/main
    scripts/branches.sh rebuild         # regenerate canary from the topics
    scripts/branches.sh rebuild --push  # …and force-push it to origin

Work on a topic branch. Never on `main` or `canary`.

    git checkout android-app
    ... work ...
    git commit
    scripts/branches.sh rebuild    # get it into your everything-build

`rebuild` runs inside whichever worktree has `canary` checked out (the Canary install at
`~/Projects/synara-canary`), so that checkout is updated in place. Restart Canary to run it.

## Opening a PR

Because every topic branches from `upstream/main` and never from `canary`, a PR
carries only its own commits. Push the topic and open it against upstream:

    git push -u origin android-app
    gh pr create --repo Emanuele-web04/synara --base main --head Robertg761:android-app

## Starting new work

    git fetch upstream
    git checkout -b my-topic upstream/main

Then add `my-topic` to `TOPICS` in `scripts/branches.sh` so the rebuild picks it up.

## Conflicts

`rerere` is enabled, so a conflict resolved once is replayed automatically the next
time `rebuild` hits it. Resolve, `git commit`, rerun. You should not have to resolve
the same conflict twice.

A topic that `status` reports as stale is the usual source of conflicts. Rebase it onto
`upstream/main` and the conflicts move into the topic, where they belong, and are fixed
once instead of on every rebuild.

### Breaks git merges cleanly

`rerere` only covers textual conflicts. Two topics can each be internally consistent
and still combine into code that does not compile, with no conflict markers to warn
you. Run `bun typecheck` after every rebuild — that is the real check.

Known standing cases while `android-app` sits behind upstream:

- `android-app` widens `authorizeDeviceFrameWebSocketUpgrade` to require `remoteAddress`,
  and `computer-use-linux` aliases it as `authorizeComputerFrameWebSocketUpgrade`. The
  callsite in `apps/server/src/wsRpc.ts` has to gain `remoteAddress: request.remoteAddress`
  during the merge.
- `android-app` adds migration `AuthSessionRenewalPolicy` as 097; upstream has since
  used 097–099. Renumber it to the next free id and bump the tracker-length assertions
  in `Migrations.test.ts`.
- `android-app` calls the desktop's `stopBackend()` as a force-stop fallback; upstream
  removed that helper. Use the shutdown path upstream kept.
