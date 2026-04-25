# branch-review

A local PR-style review UI for your terminal.

Review your branch, worktree, and AI-generated code changes before you push.

![branch-review terminal UI screenshot](assets/branch-review-screenshot.png)

`branch-review` is for the review pass that happens before GitHub.

It gives you a GitHub-like changed-files view in your terminal, with a file tree,
syntax-highlighted diffs, live refresh, and one-click copy actions for sending
paths, diff blocks, files, or agent-ready context to AI coding tools.

## Why this exists

GitHub has a great code review reading experience, but a lot of code gets
reviewed too late:

- after you already pushed
- after you already opened a PR
- after an AI agent touched 20 files and you want to sanity-check the result locally

`branch-review` brings that review step into the terminal.

## Features

- PR-style review before code leaves your machine
- Real-time updates as you or an AI agent edits code
- Changed-file tree with status markers for what changed
- Collapsible folders for large reviews
- Syntax-highlighted diffs powered by `git-delta`
- Per-file and branch-wide change metrics
- Copy actions for paths, absolute paths, file diffs, full files, block diffs, block code, and agent-ready block context
- Works with local worktree changes, branches, and remote branches

## Copy actions

Hover a file or diff block to copy useful review context:

| Action | Copies |
| --- | --- |
| Copy path | Current file path, relative to the repo |
| Copy absolute path | Current file path as an absolute path |
| Copy diff | Current file diff |
| Copy file | Current file contents |
| Copy code | Added code from the focused diff block |
| Copy block | Agent-ready context for the focused diff block |

This is useful when you want to hand a specific path, file, diff block, or code
snippet to Claude Code, Codex, Cursor, ChatGPT, Slack, or a GitHub comment.

## Requirements

- Node.js 20+
- Git available on your `PATH`
- [`git-delta`](https://github.com/dandavison/delta) available on your `PATH`

macOS:

```sh
brew install git-delta
```

## Install

### pnpm

```sh
pnpm add -g branch-review
```

### one-off usage

```sh
pnpm dlx branch-review
```

This installs the `branch-review` binary.

## Usage

Run inside a Git repository:

```sh
branch-review
```

Default behavior:

- branch: `HEAD + worktree`
- base: the detected base branch
- watch: enabled in interactive terminals

Base detection uses `origin/HEAD` when available, then falls back to common branch
names such as `development`, `main`, `master`, and `trunk`.

Examples:

```sh
branch-review                      # HEAD + worktree vs detected base
branch-review my-feature           # my-feature vs detected base
branch-review my-feature main      # my-feature vs main
branch-review HEAD main            # current local worktree vs main
branch-review HEAD HEAD            # working tree changes only
```

Ref resolution behavior:

- tries local refs first
- falls back to `origin/<ref>` when available

So you can review against remote-only base branches without checking them out
first.

## Navigation

| Key | Action |
| --- | --- |
| `↑` / `↓` | jump to previous / next file |
| `j` / `k` | scroll diff down / up |
| `g` / `G` | jump to top / bottom |
| click file | jump diff to that file |
| click folder | collapse / expand that folder |
| trackpad / mouse wheel | scroll hovered pane |
| `q` / `Esc` | quit |

## Typical workflows

### Review local changes as they happen

```sh
branch-review
```

Use this for end-of-task review, AI-generated changes, and checking untracked
files before commit or push. In an interactive terminal, the view refreshes in
real time as your editor or coding agent changes files.

### Review a feature branch against `main`

```sh
branch-review my-feature main
```

Good for:

- pre-PR review
- stacked branch sanity checks
- seeing the exact scope of a branch before publishing it

### Review against a remote base without checking it out

```sh
branch-review my-feature release/2026.04
```

If the local ref is missing, `branch-review` will try `origin/release/2026.04`.

## Development

```sh
pnpm install
pnpm dev
pnpm build
pnpm test
```

Try the locally linked CLI:

```sh
pnpm build
pnpm link --global
branch-review
```

## License

MIT © hcastro
