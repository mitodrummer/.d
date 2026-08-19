---
name: coderabbit-rate-limit-false-pass
description: "CodeRabbit's PR check can report \"pass\" while rate-limited, having reviewed nothing — verify a review submission exists on the head commit"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0acc804-1264-442f-9957-30eab741f959
  modified: 2026-08-19T02:00:21.945Z
---

On gominimal/webapp, CodeRabbit's Fair Usage rate limit (~2 included reviews/hour) can cause it to skip a PR entirely while still reporting its status check as "pass" (observed on PR #628, 2026-08-19; check read "pass — Review rate limited"). A stale APPROVED review object pinned to a superseded commit can then make `reviewDecision: APPROVED` look legitimate when the current head was never read.

**Why:** CLAUDE.md's review-surface checklist covers the frozen "Actionable comments" header and stale CHANGES_REQUESTED, but not this rate-limit false-pass mode.

**How to apply:** before calling a PR reviews-addressed, confirm CodeRabbit actually read the current head — the reliable signal is its summary comment's "up to <sha>" marker matching the head, since BOTH the check status (green while rate-limited) and the formal review submission's commit (stays pinned to an earlier push) can mislead. Do NOT wait for a review submission stamped on the head sha — when a pass finds nothing, CodeRabbit never opens a new formal review; it updates the summary comment and lets the standing APPROVED ride (confirmed on PR #628: a forced FULL review covering base→head reported clean without creating a new submission). If rate-limited, wait out the window (~36 min observed) and comment `@coderabbitai review` (or `full review`) to force a real pass. Related: [[stale-review-dismissal]].
