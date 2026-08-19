---
name: no-decision-trail-comments
description: "Karl rejects code comments that record resolved review discussions or justify a decision — rationale lives in the PR/commit history, comments only for non-obvious constraints"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e0acc804-1264-442f-9957-30eab741f959
  modified: 2026-08-19T04:42:58.477Z
---

On PR gominimal/webapp#628, Karl (as mitodrummer) had a one-line comment removed from src/lib/routes.ts that explained why the store URL deliberately omits a locale segment ("Linked at the root on purpose — the storefront picks the visitor's locale itself...").

**Why:** the comment was review-conversation residue. The locale question was debated and resolved in the PR; writing its resolution into the source annotates a settled decision rather than guarding a real trap. CLAUDE.md's comment policy says this explicitly — comments are for non-obvious constraints the code can't show, never for justifying a change to the reviewer.

**How to apply:** when a detail was debated during review, that is a signal NOT to comment it — the PR/commit history already carries the rationale. Only comment when a future editor would plausibly break something without it (hidden invariant, workaround, boundary contract). Watch for this in subagent-produced diffs especially; instruct fan-out agents accordingly.
