---
name: rerun-reuses-stale-merge-ref
description: "gh run rerun replays the ORIGINAL merge ref — after a fix lands on main, update the branch (merge main / gh pr update-branch) instead of rerunning"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0acc804-1264-442f-9957-30eab741f959
  modified: 2026-08-19T18:03:27.882Z
---

Confirmed empirically during the 2026-08-19 mip-stdout incident on gominimal/webapp: `gh run rerun --failed` reuses the merge commit from the original run's event, so after a repo-wide fix merges to main, reruns of a PR's failed jobs fail identically — they never see the fix.

**How to apply:** to pick up a main-side fix on an open PR, force a fresh merge ref: `gh pr update-branch <n>` (server-side merge of main into the branch) or merge origin/main locally and push. Prefer merge over rebase on branches with review history — and note force-push and `git reset --hard` are blocked by this project's permission hooks anyway. Related: [[coderabbit-rate-limit-false-pass]].
