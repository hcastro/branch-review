---
name: branch-review
description: Produce a ready-to-run `branch-review` command that opens a local PR-style review UI in the user's terminal, scoped to the right repo or git worktree, and copy it to the clipboard. Use when the user wants to eyeball code that was just written — "let me review this", "/branch-review", "I want to look at these changes", "open the review UI", "give me the branch-review command", "let me check the diff before you continue" — or after finishing a task/feature/fix/bug when the user should inspect the result before commit or push. Also use for specific comparisons like "review my-feature against main" or "just show me the uncommitted changes".
---

# branch-review

`branch-review` is an interactive terminal UI (Ink + git-delta) for reviewing a
diff before it reaches GitHub. This skill hands the user one command to run.

## Never run the CLI yourself

It is a full-screen TTY app: it takes over the alternate screen buffer, captures
mouse and key input, and only exits on `q`, `Esc` or Ctrl-C. Running it from a
tool call hangs the turn and returns ANSI garbage. **The deliverable is the
command text, not its output.** The user runs it in their own terminal.

The same applies to "just checking" — to inspect a diff directly, use `git diff`.

## Workflow

### 1. Resolve the target directory

`branch-review` reviews the repo containing its working directory, so the
directory is the whole game. Resolve it in this order:

1. A path the user named ("review the changes in `frontend`").
2. **The directory holding the files edited this session.** Take a path
   actually written to and pass it straight to the script — it walks up to the
   git root itself, so a file path is fine.
3. The session's cwd, only when there is no better signal.

Two traps worth naming:

- **The session cwd is often not the repo.** In a directory of sibling
  checkouts, cwd may be the parent, which is not a git repo at all. Derive the
  directory from the files that changed instead.
- **Worktrees are separate checkouts.** Work done in
  `<repo>.worktrees/<branch>` must be reviewed from that path; the main checkout
  shows none of it.

If the script reports "not inside a git repository" and no edited-file path is
available, ask which repo to target rather than guessing.

### 2. Choose the comparison

| Situation | Arguments |
| --- | --- |
| Default — anything just built | *(none)* |
| Only uncommitted edits | `HEAD HEAD` |
| Named branch vs. its detected base | `<branch>` |
| Named branch vs. a specific base | `<branch> <base>` |

Default to no arguments. That reviews `HEAD` + worktree against the detected
base, so commits made during the task **and** still-uncommitted edits appear in
one view — the same scope a PR would show. Narrow it only on request.

Refs resolve locally first, then fall back to `origin/<ref>`, so a base branch
that was never checked out still works.

### 3. Build and copy the command

The script ships with this skill. Run it by its full path under the skill's own
directory: the base directory shown when the skill loads, the folder holding
this `SKILL.md`. Below, `<skill-dir>` stands for that path. Never resolve the
script against the session cwd; the repo under review may have a file at the
same relative path.

```bash
"<skill-dir>/scripts/review-command.sh" <path> [branch] [base]
```

The script resolves the git root, reports repo state on stderr, prints the
command on stdout, and copies it to the clipboard (`pbcopy`, `wl-copy`, `xclip`,
or `clip.exe`). It warns when the range is empty or when `branch-review` or
`git-delta` is missing from `PATH`.

Arguments are positional — pass `HEAD` as `branch` when overriding only `base`:

```bash
"<skill-dir>/scripts/review-command.sh" src/api/auth.ts               # file path → repo root
"<skill-dir>/scripts/review-command.sh" ~/code/app HEAD HEAD          # uncommitted only
"<skill-dir>/scripts/review-command.sh" ~/code/app feat/login main    # branch vs base
```

Non-zero exit means nothing was copied. Fix the input and rerun; do not
hand-assemble a command to paper over an error.

### 4. Report back

Lead with the command in its own fenced block so it is easy to spot, then one
line of what it covers, taken from the script's state report. Confirm the
clipboard copy only if the script did it. A named-branch review covers that
branch's commits only; the report says so, and the summary should not mention
uncommitted edits.

````
```sh
cd '/Users/me/code/app' && branch-review
```

Copied to your clipboard. Reviews 7 changed files on `feat/login` — 2 commits
plus 4 uncommitted edits — against `origin/main`.
````

If the report says the tracked count is unknown (the script could not make a
temporary copy of the index), say so instead of giving a file count.

Keep it to that. No key-bindings table, no feature tour; the UI is
self-documenting.

## Changes spanning several repos

Emit the command for the repo with the most changed files and copy that one.
List the other repos with their paths underneath so the user can ask for those
next. Do not chain multiple `cd`s into one command — the UI runs until the user
quits it (`q`, `Esc` or Ctrl-C), so only the first would ever open.

## Flags worth knowing

Rarely needed, but available when the default misbehaves:

- `--no-watch` — disable live refresh, for a frozen snapshot or when an agent is
  still writing files and the view would churn.
- `--watch-poll` — poll instead of using filesystem events, for network mounts
  and container bind mounts where those events never arrive.
- `--no-animations` — drop transitions on slow or remote terminals.

Watch mode is on by default in an interactive terminal, which is what makes a
review update live while an agent keeps working.
