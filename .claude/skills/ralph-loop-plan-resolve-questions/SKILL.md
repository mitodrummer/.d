---
name: ralph-loop-plan-resolve-questions
description: >-
  Resolves open questions in a .plan.md document by striking through answered
  questions and recording concise resolutions inline. Optionally triggers a
  follow-up RALPH loop to propagate answers into the plan body. Use when the
  user wants to answer open questions, resolve plan questions, close out plan
  questions, or update a plan with decisions.
---

# Resolve Plan Questions

Records answers to open questions in a `.plan.md` document using a consistent
strikethrough + resolution format. Never removes the `## Open Questions`
section — answered questions stay visible as a decision log.

## Inputs

The user provides:

1. **Plan path** — the `.plan.md` file to update (required).
2. **Answers** — one or more answers to open questions. These can come as:
   - Free-form text in the prompt (e.g. "Q1: yes, place it in the toolbar. Q2: no, skip it.")
   - A conversation where the agent asks clarifying questions.
3. **RALPH loop flag** — if the user explicitly says to run a RALPH loop (or
   "run a review loop", "re-review the plan", etc.) after resolving questions,
   trigger one. If they don't mention it, do NOT trigger a loop.

## Workflow

### Step 1 — Read and present

Read the plan file. Extract the `## Open Questions` section. Present the
**unresolved** questions to the user (skip any already struck through). If all
questions are already resolved, tell the user and stop.

### Step 2 — Collect answers

For each question the user wants to answer:

1. If the user already provided answers in their prompt, match them to questions.
2. If answers are missing or ambiguous, ask the user for clarification.
3. If a question can be answered by exploring the codebase (e.g. "does function X
   exist?"), explore and propose an answer for the user to confirm.

### Step 3 — Update the plan

For each answered question, apply the strikethrough + resolution format described
below. Then, if the answer materially changes the plan's approach:

- Update the relevant section(s) of the plan body to reflect the decision.
- If the answer invalidates or adds a todo, update the `todos` array in the
  YAML frontmatter accordingly.

**Do NOT remove any open questions** — the section is a decision log.

### Step 4 — Optional RALPH loop

Only if the user **explicitly** requested a follow-up review loop:

1. Read the `ralph-loop-plan-review` skill.
2. Follow that skill's instructions, entering at Phase 2 (Review) with the
   updated plan as the existing document.
3. The review cycle limit defaults to **2** for post-resolution loops (lighter
   pass), unless the user specifies a different number.

If the user did NOT mention a RALPH loop, skip this step entirely.

---

## Strikethrough + Resolution format

### Answered question — with plan section reference

When the resolution is reflected in a specific section of the plan, point to it:

```markdown
1. ~~**Back button scope**: The requirement says "next to the company name."
   The company name lives in the `CompanyNavigationSlotComponent`...~~
   **Resolved**: Place the back button inside PageToolbar via a `backHref` prop —
   keeps changes local to affected pages. See [Step 1](#step-1-extend-pagetoolbar-with-breadcrumb-and-optional-back-button).
```

### Answered question — standalone decision (no section reference)

When the answer is self-contained and doesn't correspond to a plan section:

```markdown
2. ~~**"Next →" button — what happens on the last task?** When the current task
   is the last task...~~
   **Resolved**: Correct — the button simply does not render when there is no
   next task.
```

### Rules

- Wrap the **entire original question text** (from the bold title through the
  last sentence) in `~~strikethrough~~`.
- Append ` **Resolved**: ` on the same list item (no new bullet/number).
- Keep the resolution to 1–2 sentences. Be specific enough that someone reading
  the log understands the decision without scrolling to the plan body.
- When the resolution is reflected in a plan section, add
  `See [Section Title](#anchor).` at the end. Use the actual markdown anchor.
- When the resolution does NOT affect the plan body (e.g. "no, we don't need
  this"), no section reference is needed.
- Preserve the original numbering — do not renumber questions.
- Leave unresolved questions untouched.

---

## Example

### Before

```markdown
## Open Questions

1. **Back button scope**: Should the back button appear on all company
   sub-pages, or only on the three listed pages?

2. **"Next →" button — what happens on the last task?** When the current
   task is the last task and it's complete, there's no "next" task. The
   button should not render. Confirm this is the expected behavior.

3. **Financials title**: Should the breadcrumb use "Financial Documents"
   or a shorter "Financials"?
```

### After (questions 1 and 2 answered, 3 still open)

```markdown
## Open Questions

1. ~~**Back button scope**: Should the back button appear on all company
   sub-pages, or only on the three listed pages?~~
   **Resolved**: Only on the three task pages. The back button is rendered
   inside PageToolbar via the `backHref` prop. See [Step 5](#step-5-back-button-in-pagetoolbar).

2. ~~**"Next →" button — what happens on the last task?** When the current
   task is the last task and it's complete, there's no "next" task. The
   button should not render. Confirm this is the expected behavior.~~
   **Resolved**: Confirmed — the button does not render when `getNextTaskUrl`
   returns `null`.

3. **Financials title**: Should the breadcrumb use "Financial Documents"
   or a shorter "Financials"?
```

---

## Execution rules

1. Always read the plan file before making any changes.
2. Never delete or rewrite the `## Open Questions` section — only modify
   individual question items.
3. Preserve the original question text verbatim inside the strikethrough.
4. If an answer changes the plan's approach, update the affected plan sections
   in the same edit pass — don't leave the plan body inconsistent with the
   resolution.
5. After all edits, re-read the plan to verify the formatting is correct.
6. Only trigger a RALPH loop when the user explicitly asks for it.
