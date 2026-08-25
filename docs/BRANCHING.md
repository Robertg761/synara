# Branches

This is a fork that does two things at once: it sends focused PRs upstream, and it
runs a build with all of that work applied together. Those two goals fight unless
the branches have distinct jobs.

| Branch | Job | May I commit here? |
| --- | --- | --- |
| `main` | An exact mirror of `upstream/main`. | **No.** `scripts/branches.sh sync` moves it. |
| `computer-use-linux` | Linux computer use. → PR #780 | Yes |
| `android-app` | The Android app and remote access. | Yes |
| `session-sync` | Importing external agent sessions. | Yes |
| `workflow` | This script and this document. | Yes |
| `integration` | Every topic merged onto `upstream/main`. | **No.** It is regenerated. |

## Why integration is derived

The obvious way to keep an everything-branch is to commit to it. That decays: once a
topic lands upstream, its commits exist twice with different hashes, and every later
merge has to reconcile them by hand.

Rebuilding instead makes that disappear. `rebuild` starts from a fresh `upstream/main`
and merges each topic. A topic that has landed upstream has nothing left to contribute,
the script says so, and it drops out on its own.

## Day to day

    scripts/branches.sh status     # what is ahead, what has landed, what is stale
    scripts/branches.sh sync       # move main to upstream/main
    scripts/branches.sh rebuild    # regenerate integration from the topics

Work on a topic branch. Never on `main` or `integration`.

    git checkout android-app
    ... work ...
    git commit
    scripts/branches.sh rebuild    # get it into your everything-build

## Opening a PR

Because every topic branches from `upstream/main` and never from `integration`, a PR
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
