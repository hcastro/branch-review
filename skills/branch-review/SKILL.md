---
name: branch-review
description: Builds a ready-to-run `branch-review` command for the right repo or git worktree and copies it to the clipboard, so the user can open a local PR-style review of a diff in their own terminal. Use when the user wants to look over code that was just written ("let me review this", "/branch-review", "I want to look at these changes", "open the review UI", "give me the branch-review command", "let me check the diff before you continue"), after finishing a task, feature or fix the user should inspect before a commit or push, or for a specific comparison such as "review my-feature against main" or "just show me the uncommitted changes".
---

# branch-review

`branch-review` is a full-screen terminal UI for reviewing a diff before it reaches GitHub. This skill hands the user one command to run in their own terminal.

**Never run `branch-review` from a tool call.** It takes over the screen, reads keys and the mouse, and exits only when the user presses `q`, `Esc` or Ctrl-C, so a tool call hangs. The deliverable is the command text. To look at a diff yourself, use `git diff`.

## Workflow

Copy this checklist and work through it:

```
branch-review command:
- [ ] 1. Pick the repo path
- [ ] 2. Pick the comparison
- [ ] 3. Run the script
- [ ] 4. Reply with the command and the state report's summary
```

### 1. Pick the repo path

The repo path is the file or directory you pass to the script. It decides which checkout the review covers. Pick the first of these that applies:

1. A path the user named ("review the changes in `frontend`").
2. A file you wrote or edited in this session. Pass the file path as is. The script walks up to the git root.
3. The session's working directory, when nothing else points anywhere.

Two cases catch agents out:

- **The working directory is often not a repo.** In a folder of sibling checkouts, it's the parent. Use an edited file's path instead.
- **A worktree is its own checkout.** Work done in `<repo>.worktrees/<name>` shows only when you pass a path inside that worktree. The main checkout shows none of it.

If the script reports "not inside a git repository" and you have no edited file to point at, ask the user which repo to review.

### 2. Pick the comparison

| The user wants | Arguments |
| --- | --- |
| Everything just built (the default) | none |
| Only uncommitted edits | `HEAD HEAD` |
| A named branch against its detected base | `BRANCH` |
| A named branch against a chosen base | `BRANCH BASE` |

With no arguments, the review covers `HEAD` plus the working tree against the detected base. Commits made during the task and edits not yet committed show together, the way a pull request would show them. Narrow it only when the user asks.

A ref resolves locally first and then as `origin/<ref>`, so a base the user never checked out still works. When the user describes a branch instead of naming it ("that login branch"), find its exact name with `git -C REPO_PATH branch --all --list '*login*'` and pass that name.

### 3. Run the script

The script ships in this skill's folder, the base directory shown when the skill loads. Below, `<skill-dir>` stands for that folder. Always run the script by that full path. Never run it by a path relative to the working directory, because the repo under review can hold a file at the same relative path.

Run exactly this:

```bash
"<skill-dir>/scripts/review-command.sh" REPO_PATH [BRANCH] [BASE] [FLAG...]
```

Replace the following:

- `REPO_PATH`: the path from step 1.
- `BRANCH`: the ref to review. Pass `HEAD` when you set only `BASE`.
- `BASE`: the ref to compare against. Leave it out to let `branch-review` detect it.
- `FLAG`: a flag from [Flags](#flags), such as `--no-watch`. The script puts it in the command it copies. Leave it out unless the user describes the problem it solves.

For example:

```bash
"<skill-dir>/scripts/review-command.sh" src/api/auth.ts               # a file path, resolved to its repo root
"<skill-dir>/scripts/review-command.sh" ~/code/app HEAD HEAD          # uncommitted edits only
"<skill-dir>/scripts/review-command.sh" ~/code/app feat/login main    # a branch against a base
"<skill-dir>/scripts/review-command.sh" ~/code/app --no-watch         # a frozen snapshot
```

The script prints the command on stdout and a state report on stderr. The report names the repo, the branch, the base and the counts of commits and changed files. The script copies the command with `pbcopy`, `wl-copy`, `xclip` or `clip.exe`, and the command runs in POSIX shells and zsh. It warns when the range is empty or when `branch-review` or `git-delta` is missing from `PATH`. A hint that `ffmpeg` or `ffprobe` is missing needs no action, since videos then show their size without frames.

Every run replaces the clipboard, so run the script once per reply. When the script exits non-zero, it copied nothing. Read its message, fix the input and run it again. Never write the command by hand to get past an error.

The script refuses a repo path or ref name that holds control or invisible characters, such as newlines, tabs, escapes, bidi controls and zero-width characters. Its message shows each one escaped, as `\x1b` or `\u202e`. Tell the user which name holds it and stop. Write the name in its escaped form, as in `feat/\u202espoof`, because the raw character acts in the user's terminal too. Don't rename anything.

### 4. Reply

Use this template. Put the command first, in its own fenced block. Then write one line on what it covers, taken from the state report.

````
```sh
cd '/Users/me/code/app' && branch-review
```

Copied to your clipboard. Reviews 7 changed files on `feat/login` against `origin/main`, from 2 commits and 4 uncommitted entries.
````

Take the file count from the report's `in review` line, and the commits and uncommitted entries from its `commits` and `uncommitted` lines.

- Name commits only when there are some, and uncommitted entries likewise: "Reviews 3 changed files on `main` against `main`, from 3 uncommitted entries."
- For `HEAD HEAD`, the review holds uncommitted edits only: "Reviews 2 uncommitted files on `feat/login`."
- A review of a named branch covers that branch's commits only. Leave uncommitted entries out.
- When the report says a count is unknown, say that instead of giving a number.
- Say "Copied to your clipboard" only when the report says the copy worked.

Add nothing else, such as a key list or a feature tour. The UI explains itself.

## Changes in several repos

Count the files you changed in each repo this session, or run `git -C REPO status --short` in each. Never run the script to count, because each run replaces the clipboard. Run it once, for the repo with the most changed files, and reply with that command. Under it, list each other repo with its path, so the user can ask for it next. Never join several `cd ... && branch-review` commands into one line. The UI runs until the user quits it with `q`, `Esc` or Ctrl-C, so only the first would open.

## Flags

The default command fits nearly every review. Pass a flag to the script only when the user describes the problem it solves. The script refuses any other flag.

- `--no-watch`: a frozen snapshot, for when an agent is still writing files and the live view would churn. Watch mode is on by default in an interactive terminal.
- `--watch-poll`: poll for changes, for network mounts and container bind mounts where file events never arrive.
- `--no-animations`: no transitions, for slow or remote terminals.
- `--no-images`: image, SVG and video files show as plain diffs, for previews that misbehave in a terminal.

One fix is an environment variable the script can't carry. `BRANCH_REVIEW_IMAGES=blocks` draws block previews in place of pictures, for a terminal that claims image support and draws images wrong. Put it before `branch-review` in the command the script printed, as in `cd '/Users/me/code/app' && BRANCH_REVIEW_IMAGES=blocks branch-review`, and tell the user the clipboard holds the command without it.
