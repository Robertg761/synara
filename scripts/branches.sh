#!/usr/bin/env bash
# Branch plumbing for a fork that both contributes upstream and runs everything at once.
#
#   main      a mirror of upstream/main. Never commit here.
#   <topic>   one PR-able unit of work. Commit here.
#   canary    every topic merged onto upstream/main. Derived — never commit here.
#
# `canary` is regenerated, not authored. That is what lets a topic branch merge upstream
# and simply vanish from the rebuild instead of turning into a conflict.
set -euo pipefail

# Topic branches, in merge order. Add a branch here the day you create it.
TOPICS=(
  computer-use-linux
  android-app
  fork-tooling
)
# codex/computer-use-macos (PR #1010) is not merged yet. It carries slices 1-3 of the Linux
# stack plus the macOS backend, and its core edits collide with slices 4-6 in ~15 files
# (contracts, ComputerService, ComputerPanel, settings). Add it back once the two stacks are
# reconciled on a common base; until then a Linux canary loses nothing by leaving it out.

BASE="${SYNARA_BASE:-upstream/main}"
INTEGRATION="${SYNARA_INTEGRATION:-canary}"
REMOTE="${SYNARA_REMOTE:-origin}"
cd "$(git rev-parse --show-toplevel)"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[36m%s\033[0m\n' "$*"; }

# Only tracked changes count. A module carries its own .gitignore, so switching to a
# branch without that module unhides its build output as thousands of untracked files.
# Refusing to run on those would mean never being able to run at all.
dirty() { [ -n "$(git -C "${1:-.}" status --porcelain --untracked-files=no)" ]; }

# A topic may live only on the remote (another machine pushed it). Prefer the local branch.
topic_ref() {
  if git rev-parse --verify --quiet "refs/heads/$1" >/dev/null; then echo "$1"
  elif git rev-parse --verify --quiet "refs/remotes/$REMOTE/$1" >/dev/null; then echo "$REMOTE/$1"
  fi
}

# The worktree that has $1 checked out, if any.
worktree_for() {
  git worktree list --porcelain | awk -v want="refs/heads/$1" '
    /^worktree /{wt=$2} /^branch /{if ($2==want) print wt}'
}

cmd_sync() {
  dirty && die "Working tree is dirty. Commit to a topic branch first."
  say "Fetching ${BASE%%/*}…"
  git fetch "${BASE%%/*}" --prune
  say "Pointing main at ${BASE}…"
  if [ "$(git rev-parse --abbrev-ref HEAD)" = main ]; then
    git reset -q --hard "$BASE"
  else
    git branch -f main "$BASE"
  fi
  say "main is now an exact mirror of ${BASE}."
}

cmd_rebuild() {
  local push=0; [ "${1:-}" = "--push" ] && push=1
  dirty && die "Working tree is dirty. Commit to a topic branch first."
  git fetch "${BASE%%/*}" --prune
  git fetch "$REMOTE" --prune
  local prev; prev="$(git rev-parse --short "$INTEGRATION" 2>/dev/null || echo none)"

  # Rebuild where $INTEGRATION is checked out so the branch can be reset in place;
  # otherwise use a throwaway worktree and move the branch afterwards.
  local wt tmp=0; wt="$(worktree_for "$INTEGRATION")"
  if [ -n "$wt" ]; then
    dirty "$wt" && die "$wt is dirty. Commit or stash there first."
    say "Rebuilding ${INTEGRATION} in ${wt} on ${BASE}…"
    git -C "$wt" checkout -q -B "$INTEGRATION" "$BASE"
  else
    tmp=1; wt="$(mktemp -d "${TMPDIR:-/tmp}/synara-rebuild.XXXXXX")"
    say "Rebuilding ${INTEGRATION} in a temporary worktree on ${BASE}…"
    git worktree add -q --detach "$wt" "$BASE"
  fi

  for b in "${TOPICS[@]}"; do
    local ref; ref="$(topic_ref "$b")"
    [ -n "$ref" ] || { echo "  skip  $b (no such branch locally or on $REMOTE)"; continue; }
    if [ -z "$(git rev-list "${BASE}..$ref")" ]; then
      echo "  done  $b (fully upstream — nothing left to merge)"
      continue
    fi
    printf '  merge %s … ' "$ref"
    if git -C "$wt" merge --no-ff --no-edit "$ref" >/dev/null 2>&1; then
      echo "ok"
    else
      echo "CONFLICT"
      die "Resolve in ${wt}, 'git commit', then rerun. rerere will remember it for next time."
    fi
  done

  if [ "$tmp" = 1 ]; then
    git branch -f "$INTEGRATION" "$(git -C "$wt" rev-parse HEAD)"
    git worktree remove --force "$wt"
  fi
  say "${INTEGRATION}: ${prev} -> $(git rev-parse --short "$INTEGRATION")"
  say "Now run: bun typecheck  (merges that apply cleanly can still fail to compile)"
  if [ "$push" = 1 ]; then
    git push --force-with-lease "$REMOTE" "$INTEGRATION"
  else
    say "Publish with: git push --force-with-lease ${REMOTE} ${INTEGRATION}"
  fi
}

cmd_status() {
  git fetch "${BASE%%/*}" --prune --quiet 2>/dev/null || true
  printf '%-28s %-10s %s\n' BRANCH AHEAD STATE
  for b in "${TOPICS[@]}"; do
    local ref; ref="$(topic_ref "$b")"
    [ -n "$ref" ] || { printf '%-28s %-10s %s\n' "$b" "-" "missing"; continue; }
    local ahead behind state
    ahead="$(git rev-list --count "${BASE}..$ref")"
    behind="$(git rev-list --count "$ref..${BASE}")"
    if [ "$ahead" = 0 ]; then state="landed upstream"
    elif [ "$behind" -gt 40 ]; then state="stale — rebase onto ${BASE}"
    else state="ok"; fi
    printf '%-28s %-10s %s\n' "$ref" "+$ahead" "$state"
  done
}

case "${1:-status}" in
  sync)    cmd_sync ;;
  rebuild) cmd_rebuild "${2:-}" ;;
  status)  cmd_status ;;
  *) die "usage: scripts/branches.sh [status|sync|rebuild [--push]]" ;;
esac
