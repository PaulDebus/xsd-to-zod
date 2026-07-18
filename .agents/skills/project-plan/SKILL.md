---
name: project-plan
description: Fetches open GitHub issues, picks the most impactful one, creates a brief plan (issue summary + proposed solution), and asks for confirmation before implementing — unless the user explicitly said to just implement it.
---

## Usage

Trigger this skill when the user asks you to do something with "issues", "plan", "project", or any open-ended work that affects the codebase. Also when they say something like "what should I work on?" or "find something to do".

## Process

### 1. Fetch open issues

Run `gh issue list --repo PaulDebus/xsd2zod --state open --limit 30 --json number,title,labels,body,createdAt,comments` to get all open issues.

### 2. Identify the most impactful issue

Rank by (in order):

1. **Bug report** over enhancements (unblocks users faster)
2. **Number of comments** (community interest / pain)
3. **Recency** (fresh issues are top of mind)
4. **Scope** — prefer issues whose fix touches a contained area (avoid sprawling foundational reworks unless that's what the user wants)

Pick **one** issue. If multiple are close, pick the one that removes a limitation more people are likely to hit.

### 3. Read the issue body in full

Use `gh issue view <number> --json body,comments` to get the full issue text and discussion.

### 4. Formulate a plan

Keep it short — 5 sentences max:

- **What the issue is** (one sentence).
- **What the root cause / missing piece is** (one sentence).
- **Proposed approach** (two to three sentences: which files to touch, what to change, trade-offs if any).

### 5. Ask for confirmation

Present the plan and wait for the user to say "yes" or give feedback.

**Exception**: if the user's original prompt explicitly says to just implement it (e.g., "just implement the fix", "go ahead and do it", "don't ask, just do"), skip the confirmation and proceed directly.

### 6. Branch before implementing

When implementing (after confirmation or by direct instruction), always create a new branch off `origin/main`:

```bash
git fetch origin main && git checkout -b <issue-type>/<short-description> origin/main
```

Follow the branching convention from AGENTS.md.

### 7. Implementation
Fully implement what is required to fix the issue
Ask the user at the end if they want to close the issue
