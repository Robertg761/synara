#!/usr/bin/env bash
# Branch plumbing for a fork that both contributes upstream and runs everything at once.
#
#   main         a mirror of upstream/main. Never commit here.
#   <topic>      one PR-able unit of work. Commit here.
#   integration  every topic merged onto upstream/main. Derived — never commit here.
#
# `integration` is regenerated, not authored. That is what lets a topic branch merge
# upstream and simply vanish from the rebuild instead of turning into a conflict.
set -euo pipefail

# Topic branches, in merge order. Add a branch here the day you create it.
TOPICS=(computer-use-linux android-app session-sync desktop-flavor-env workflow)
  computer-use-linux
  android-app
  session-sync
  workflow
)

BASE="${SYNARA_BASE:-upstream/main}"
cd "$(git rev-parse --show-toplevel)"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[36m%s\033[0m\n' "$*"; }

# Only tracked changes count. A module carries its own .gitignore, so switching to a
# branch without that module unhides its build output as thousands of untracked files.
# Refusing to run on those would mean never being able to run at all.
dirty() { [ -n "$(git status --porcelain --untracked-files=no)" ]; }

cmd_sync() {
  dirty && die "Working tree is dirty. Commit to a topic branch first."
  say "Fetching upstream…"
  git fetch upstream --prune
  say "Pointing main at ${BASE}…"
  git branch -f main "$BASE"
  say "main is now an exact mirror of ${BASE}."
}

cmd_rebuild() {
  dirty && die "Working tree is dirty. Commit to a topic branch first."
  git fetch upstream --prune
  local prev
  prev="$(git rev-parse --short integration 2>/dev/null || echo none)"
  say "Rebuilding integration on ${BASE}…"
  git checkout -q -B integration "$BASE"
  for b in "${TOPICS[@]}"; do
    git rev-parse --verify --quiet "$b" >/dev/null || { echo "  skip  $b (no such branch)"; continue; }
    if [ -z "$(git rev-list "${BASE}..$b")" ]; then
      echo "  done  $b (fully upstream — nothing left to merge)"
      continue
    fi
    printf '  merge %s … ' "$b"
    if git merge --no-ff --no-edit "$b" >/dev/null 2>&1; then
      echo "ok"
    else
      echo "CONFLICT"
      die "Resolve, 'git commit', then rerun. rerere will remember it for next time."
    fi
  done
  say "integration: ${prev} -> $(git rev-parse --short integration)"
}

cmd_status() {
  git fetch upstream --prune --quiet 2>/dev/null || true
  printf '%-22s %-10s %s\n' BRANCH AHEAD STATE
  for b in "${TOPICS[@]}"; do
    git rev-parse --verify --quiet "$b" >/dev/null || continue
    local ahead behind state
    ahead="$(git rev-list --count "${BASE}..$b")"
    behind="$(git rev-list --count "$b..${BASE}")"
    if [ "$ahead" = 0 ]; then state="landed upstream"
    elif [ "$behind" -gt 40 ]; then state="stale — rebase onto ${BASE}"
    else state="ok"; fi
    printf '%-22s %-10s %s\n' "$b" "+$ahead" "$state"
  done
}

case "${1:-status}" in
  sync)    cmd_sync ;;
  rebuild) cmd_rebuild ;;
  status)  cmd_status ;;
  *) die "usage: scripts/branches.sh [status|sync|rebuild]" ;;
esac
