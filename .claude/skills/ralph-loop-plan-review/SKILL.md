---
name: ralph-loop-plan-review
description: >-
  Orchestrates a RALPH loop (Review And Loop Protocol) that drafts a .plan.md
  document from user requirements (or refines an existing one), then iterates
  through review-update cycles using separate subagents until the reviewer has
  no feedback. This skill only produces plan documents — it never writes code.
  Use when the user asks to run a ralph loop, create a plan with review cycles,
  iterate on a plan document with autonomous agents, or mentions "ralph loop".
---

# RALPH Loop — Plan Document Orchestrator

Autonomous draft → review → update loop that produces a refined `.plan.md` document. Each phase runs in a fresh subagent to avoid context pollution. This skill **only produces plan documents** — no code is written, no files are changed beyond the plan and review files.

## Starting point

There are two ways to start the loop — the orchestrator determines which applies:

| Scenario | How to start |
|---|---|
| **New plan** — user provides requirements | Run Phase 1 (Draft), then enter the review loop |
| **Existing plan** — user provides a `.plan.md` path | Skip Phase 1, go directly to Phase 2 (Review). Derive the base name from the existing filename. |

## File naming

The orchestrator chooses a descriptive kebab-case base name (derived from requirements or the existing filename). Both files share this base name:

| File | Path |
|---|---|
| Plan | `plans/{base-name}.plan.md` |
| Review | `plans/{base-name}.plan.review.md` |

Both files live in the `plans/` folder at the workspace root. The shared base name keeps plan/review pairs unique when multiple RALPH loops run in parallel.

## Review-update cycle limit

Default: **3** cycles. The user may override this by specifying a number in their prompt (e.g. "run 5 loops"). If no number is given, use the default.

## Orchestrator role

You (the parent agent) are the **orchestrator**. You NEVER write plan content yourself. You:

1. Determine the starting point (new plan or existing) and the cycle limit.
2. If new: choose the base name; if existing: derive it from the provided filename.
3. Spawn subagents for drafting, reviewing, and updating.
4. Read the review file after each review to decide the next step.
5. Report progress to the user when the loop completes.

---

## Open Questions convention

Every agent that creates or updates the plan MUST maintain an `## Open Questions` section immediately after the YAML frontmatter (before any other content). When something is ambiguous, unclear, or requires a human decision, add it here as a numbered list item.

Reviewers MUST ignore the `## Open Questions` section entirely — it is not reviewable content. It exists so the human user can address ambiguities after the loop completes.

---

## Phase 1 — Draft *(skip if an existing plan is provided)*

Spawn a subagent (`subagent_type: "general-purpose"`):

```
You are a plan drafter.

The user wants a plan for the following requirements:

{paste the user's requirements here verbatim}

Read CLAUDE.md files (if they exist) for project conventions.
Explore the codebase as needed to understand existing patterns, types, and file structure.
If the plan touches a domain covered by a skill in `.claude/skills/`,
read that skill so the plan's instructions align with established patterns.

Produce a detailed plan as a markdown file named `plans/{base_name}.plan.md`.
Save it to the `plans/` folder at the workspace root.

The plan MUST include:

- A YAML frontmatter block with `name` and `overview`.
- An "## Open Questions" section immediately after the frontmatter. List anything
  ambiguous, unclear, or requiring a human decision as numbered items. If nothing
  is ambiguous, write "None yet." under the heading. This section must always exist.
- A "## Problem" section immediately after "## Open Questions". Write a thorough
  description of the problem this plan solves: what is broken or missing today, why
  it matters, what the expected outcome looks like, and any constraints or non-goals.
  This section is the source of truth reviewers use to judge whether the plan actually
  solves the right problem.
- A `todos` array in the frontmatter. Each todo has `id`, `content`, and `status: pending`.
- A clear description of each step with file paths, types, logic, and test cases
  where applicable.
- A "Files touched" table listing every file that will be created, modified, or
  deleted with a one-line description.
- An "Out of scope" section listing anything explicitly excluded.

Do NOT write any code or modify any files other than the plan document.

Return the full path to the plan file you created.
```

## Phase 2 — Review

Spawn a DIFFERENT subagent:

```
You are a plan reviewer.

Read the plan at {plan_path}.
Read CLAUDE.md files (if they exist) for project conventions.
If the plan touches a domain covered by a skill in `.claude/skills/`,
read that skill to verify the plan's instructions match the established patterns.
Explore the codebase to verify the plan's assumptions — file paths, existing types,
function signatures, DB schema, etc.

IMPORTANT: Completely ignore the "## Open Questions" section. It is reserved for
the human user and is not part of your review scope.

Start by reading the "## Problem" section carefully. Use it as the lens for your
entire review — every issue you raise must tie back to whether the plan correctly
and completely solves the described problem.

Review everything else for:
1. Problem alignment — does the plan actually solve the problem described in "## Problem"?
   Are there steps that are irrelevant, or missing steps that are required?
2. Completeness — are all requirements covered? Any gaps or missing steps?
3. Correctness — do the proposed file paths, types, and logic match the actual codebase?
4. Order — are todos sequenced so dependencies come before consumers?
5. Scope — is anything included that shouldn't be, or excluded that should be?
6. Testability — are test cases specified for non-trivial logic?
7. Conventions — does the plan follow project patterns (check CLAUDE.md)?
8. Architecture conventions — flag any step that contradicts the project-wide
   patterns documented in the project's CLAUDE.md / AGENTS.md (stack choices,
   i18n, auth, validation, migration discipline, ...). Raise contradictions as
   an Issue, not a Nit.

Write your findings to {review_path} in the `plans/` folder:

# Plan Review

## Issues
- [ ] **[section/todo_id]** Description of issue and what should change

## Nits (optional)
- **[section]** Minor suggestion

If there are ZERO issues, write ONLY:

# Plan Review

No feedback

Be rigorous — catch real problems. Do not rubber-stamp, but do not invent issues.
Do NOT write any code or modify any files other than the review file.
```

## Phase 3 — Update loop

Read the review file yourself.

- **"No feedback"** → the plan is done. Tell the user the plan is ready and remind them to review the **Open Questions** section for anything that needs their input.
- **Cycle limit reached** → stop and report the unresolved issues to the user.
- **Has issues** → spawn an updater subagent:

```
You are a plan updater.

Read {review_path} in the `plans/` folder. It contains review feedback for the plan at {plan_path}.

Read CLAUDE.md files (if they exist) for project conventions.
If the plan touches a domain covered by a skill in `.claude/skills/`,
read that skill to ensure updates align with established patterns.

Address EVERY item under "## Issues" (ignore Nits). For each:
1. Read the relevant section of the plan
2. Update the plan document to address the issue
3. If addressing the issue requires codebase exploration, do so to ensure accuracy

If any issue reveals new ambiguity or something you cannot resolve without human input,
add it to the "## Open Questions" section at the top of the plan. Do not remove existing
questions — only append new ones.

Do NOT modify the "## Problem" section unless a review issue explicitly calls it out
as inaccurate or incomplete.

Do NOT write any code or modify any files other than the plan document.

Return a summary of what you changed in the plan.
```

Then return to **Phase 2** (fresh reviewer). Repeat until the review file says "No feedback" or the cycle limit is reached.

---

## Execution rules

1. Always use `subagent_type: "general-purpose"` for all spawned agents.
2. Never write plan content yourself — always delegate to subagents.
3. Between phases, read the review file yourself to decide the next step.
4. When spawning subagents, always include the full plan path and review path in the prompt.
5. Instruct subagents to read CLAUDE.md files if they exist.
6. No agent should write code or modify any file other than the `.plan.md` and `.plan.review.md`.
7. When the loop completes, remind the user to check the **Open Questions** section.
