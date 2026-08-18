#!/usr/bin/env bash
# UserPromptSubmit hook: surface open GitHub issues assigned to the sandbox
# dashboard's configured assignee that aren't already being worked, on the
# user's NEXT prompt.
#
# Personal tooling, shipped with the dotfiles (registered in
# ~/.claude/settings.json; the agent-claude loadout patches both into
# sessions). No login is hardcoded here: the assignee comes from the state
# file itself, which the tailnet-dashboard loadout's dashboard writes only
# when SANDBOX_DASHBOARD_ASSIGNEE is set.
#
# HONEST SCOPE: this fires on prompt submit, NOT while the session is idle.
# Nothing local can wake a fully-idle session, so a newly-assigned issue is
# surfaced the next time the user interacts — not the instant it's assigned.
#
# Data source: the $TMPDIR state file written by the sandbox dashboard
# (discover.ts → writeAssignedIssuesState). The dashboard polls
# `gh issue list --assignee <login>` on a 60s loop and persists the current
# open set. This hook only reads that file (plus one cached `gh pr list`), so
# it stays fast and never blocks the prompt on a slow issue query.
#
# Self-guarding no-op: if the state file is absent (no dashboard, no assignee
# configured, non-sandbox context) or there's nothing to surface, it prints
# nothing and exits 0 — harmless as a global hook.
#
# "Already being worked" = the issue has an open PR (matched by `#<number>` in
# the PR title), or a local git branch/worktree references it (a branch whose
# name contains the issue number). Such issues are filtered out so the agent is
# nudged only toward unclaimed work. We match on PR title only — fetching every
# PR body just to grep for an issue ref is a large payload on a hook that must
# stay fast, and the PR-title convention already carries the `#<number>` ref.
set -euo pipefail

STATE_FILE="${TMPDIR:-/tmp}/sandbox-dashboard-assigned-issues.json"
[ -f "$STATE_FILE" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

# Whose queue this snapshot is — recorded by the dashboard. Empty/missing
# means the section is disabled; nothing to surface.
assignee="$(jq -r '.assignee // empty' "$STATE_FILE" 2>/dev/null || true)"
[ -n "$assignee" ] || exit 0

# Pull {number, title} pairs from the state file. A malformed file yields no
# rows and the hook exits silently. A portable `while read` loop (not `mapfile`,
# which needs Bash 4+) keeps the hook working on macOS's Bash 3.2.
issue_lines=()
while IFS= read -r line; do
  [ -n "$line" ] && issue_lines+=("$line")
done < <(jq -r '.issues[]? | "\(.number)\t\(.title)"' "$STATE_FILE" 2>/dev/null || true)
[ "${#issue_lines[@]}" -gt 0 ] || exit 0

# Numbers already claimed by an open PR. `gh pr list` is the one network call,
# so cache its title blob alongside the state file with a 60s TTL — mirroring
# the dashboard's in-memory cache — so back-to-back prompts don't each pay for
# a live API round-trip. Tolerate failure (offline / unauthenticated → treat
# as "no open PRs" rather than blocking the prompt).
# Cache the raw `gh pr list` JSON blob (not the extracted titles): the blob is
# always non-empty — at minimum `[]` — so a session with zero open PRs still
# produces a valid cache hit instead of re-fetching on every prompt.
PR_CACHE_FILE="${TMPDIR:-/tmp}/sandbox-dashboard-open-pr-titles.cache"
PR_CACHE_TTL=60
claimed=""
if command -v gh >/dev/null 2>&1; then
  pr_blob=""
  if [ -f "$PR_CACHE_FILE" ]; then
    # mtime in epoch seconds: `stat -c %Y` is GNU/Linux, `stat -f %m` is
    # BSD/macOS; fall back to 0 (always-stale) if neither works.
    cache_age=$(( $(date +%s) - $(stat -c %Y "$PR_CACHE_FILE" 2>/dev/null || stat -f %m "$PR_CACHE_FILE" 2>/dev/null || echo 0) ))
    if [ "$cache_age" -ge 0 ] && [ "$cache_age" -lt "$PR_CACHE_TTL" ]; then
      # `|| true` so a TOCTOU delete (concurrent tmp-cleaner between the [ -f ]
      # check and here) can't make this `cat` abort the hook under `set -e`.
      pr_blob="$(cat "$PR_CACHE_FILE" 2>/dev/null || true)"
    fi
  fi
  if [ -z "$pr_blob" ]; then
    pr_blob="$(gh pr list --state open --json title --limit 50 2>/dev/null || true)"
    if [ -n "$pr_blob" ]; then
      printf '%s' "$pr_blob" >"$PR_CACHE_FILE" 2>/dev/null || true
    fi
  fi
  claimed="$(printf '%s' "$pr_blob" | jq -r '.[] | .title' 2>/dev/null | grep -oE '#[0-9]+' | tr -d '#' || true)"
fi

# Numbers referenced by an existing local branch or worktree (branch name
# contains the issue number, e.g. `feat/123-foo` or `issue-123`).
#
# `--porcelain` filtered to the worktree/branch lines, NOT plain `git worktree
# list`: that form prints the abbreviated HEAD sha next to each path, and a sha
# is mostly hex digits — `e928e8cc` matches the `[^0-9]8[^0-9]` probe below, so
# every low-numbered issue read as "already being worked" and was silently
# dropped from the prompt.
branch_blob="$(git branch --format='%(refname:short)' 2>/dev/null || true)"
worktree_blob="$(git worktree list --porcelain 2>/dev/null | grep -E '^(worktree|branch) ' || true)"

is_worked() {
  local num="$1"
  printf '%s\n' "$claimed" | grep -qx "$num" && return 0
  printf '%s' "$branch_blob" | grep -qE "(^|[^0-9])${num}([^0-9]|$)" && return 0
  printf '%s' "$worktree_blob" | grep -qE "(^|[^0-9])${num}([^0-9]|$)" && return 0
  return 1
}

unworked=""
for line in "${issue_lines[@]}"; do
  num="${line%%$'\t'*}"
  title="${line#*$'\t'}"
  [ -n "$num" ] || continue
  if ! is_worked "$num"; then
    unworked+="  - #${num} ${title}"$'\n'
  fi
done

[ -n "$unworked" ] || exit 0

printf 'Open issues assigned to %s that are not yet being worked (no open PR or branch):\n' "$assignee"
printf '%s' "$unworked"
printf 'Consider picking one up, or ignore if not relevant to the current request.\n'
