<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img alt="branch-review" src="assets/banner-light.png" width="640">
  </picture>
</p>

<p align="center">
  A PR-style review UI for your terminal, built for checking what you or your coding agent changed before any of it reaches GitHub.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-56d4dd?style=flat-square"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-d2a8ff?style=flat-square">
  <img alt="Powered by git-delta" src="https://img.shields.io/badge/diffs-git--delta-7ee787?style=flat-square">
</p>

<p align="center">
  <img alt="branch-review showing a changed-file tree next to a syntax-highlighted diff of src/middleware/rateLimit.ts" src="assets/review-ui.png" width="100%">
</p>

Run `branch-review` in any Git repo. You get a changed-file tree, syntax-highlighted diffs from [`git-delta`](https://github.com/dandavison/delta), and per-file and branch-wide stats. The view updates live while files change on disk.

Every file and diff block has copy buttons. They hand a path, a diff, or an agent-ready block of context to Claude Code, Codex, Cursor, or a Slack thread in one click.

## Watch an agent work

Leave `branch-review` open next to a coding agent. New files land in the tree as they're written. Edits wash in over the diff you're reading, and you never reload.

<p align="center">
  <img alt="An agent writes a new file and edits it while branch-review shows each change arriving live" src="assets/live-review.gif" width="100%">
</p>

By default the review covers `HEAD` plus your worktree against the base branch. Commits the agent made and edits it hasn't committed yet show up together, scoped the way the eventual PR will be.

## Install

You need Node.js 20+, Git, and `git-delta` on your `PATH`.

```sh
brew install git-delta          # macOS. See the delta docs for other platforms.
```

Install the CLI straight from GitHub. The package builds itself on install, so pnpm needs permission to run that build:

```sh
pnpm add -g --allow-build=branch-review github:hcastro/branch-review
```

Or work from a clone:

```sh
git clone https://github.com/hcastro/branch-review.git
cd branch-review
pnpm install
pnpm link --global
```

## Usage

```sh
branch-review                      # HEAD + worktree vs the detected base
branch-review my-feature           # my-feature vs the detected base
branch-review my-feature main      # my-feature vs main
branch-review HEAD HEAD            # uncommitted changes only
```

The base comes from `origin/HEAD` when the remote has one. Otherwise it falls back to the first of `development`, `main`, `master`, and `trunk` that exists.

Refs resolve locally first and then as `origin/<ref>`. That lets you review against a remote base you never checked out:

```sh
branch-review my-feature release/2026.04
```

### Options

| Flag | Effect |
| --- | --- |
| `--watch` | Refresh live as files change. On by default in an interactive terminal. |
| `--no-watch` | Open a frozen snapshot. Handy while an agent is mid-write and the view would churn. |
| `--watch-poll` | Poll instead of using filesystem events. Use it on network mounts and container bind mounts. |
| `--no-animations` | Skip the arrival highlights. Useful on slow or remote terminals. |

## Reviewing

### Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Previous / next file |
| `j` / `k` | Scroll the diff down / up |
| `g` / `G` | Jump to the top / bottom |
| `q` / `Esc` | Quit |

### Mouse

| Gesture | Action |
| --- | --- |
| Click a file | Jump the diff to that file |
| Click a folder | Collapse or expand it |
| Click a block header | Collapse or expand that diff block |
| Drag across code | Select lines and copy them |
| Drag the tree's edge | Resize the file tree. `‹` collapses it. |
| Scroll | Scroll whichever pane is under the pointer |

### Copy actions

Hover a file header, a diff block, or a tree row to reveal its copy buttons.

| Where | Button | Copies |
| --- | --- | --- |
| File header | `Copy path` | Path relative to the repo root |
| | `Copy absolute path` | Full path on disk. It shows up when you hover `Copy path`. |
| | `Copy diff` | The file's diff |
| | `Copy file` | The file's current contents |
| Diff block | `Copy code` | The block's added lines, without diff markers |
| | `Copy diff` | The block's diff |
| | `Copy block` | Agent-ready context for the block |
| Tree row | `Copy` | That file's path |
| Tree header | `Copy tree` | The changed files as a fenced ASCII tree |

`Copy block` produces a snippet you can paste straight into a prompt:

````md
File: src/server.ts
Lines: 1-8

```diff
@@ -1,7 +1,8 @@
 import {createServer} from 'node:http';
 import {rateLimit} from './middleware/rateLimit.js';
 
-const limit = rateLimit({limit: 10, windowMs: 1_000});
+const limit = rateLimit({limit: 10, windowMs: 1_000, burst: 5});
+const port = Number(process.env.PORT ?? 3000);
 
 const server = createServer((req, res) => {
   limit(req, res, () => {
```
````

When Git can name the enclosing function, the snippet adds a `Function:` line too.

## Agent skill

The repo ships an agent skill in [`skills/branch-review`](skills/branch-review). It teaches Claude Code, or any tool that reads `SKILL.md`, to hand you a ready-to-run `branch-review` command.

An agent can't drive a full-screen TUI, so the skill never runs the CLI itself. It works out which repo or worktree holds the changes, picks the refs, and copies one line to your clipboard:

```sh
cd '/Users/me/code/app' && branch-review
```

Ask for it with "let me review this", "/branch-review", or "show me the diff before you continue". Paste, review, and quit with `q`.

Link the skill into your user skills directory so it tracks the repo:

```sh
ln -s "$PWD/skills/branch-review" ~/.claude/skills/branch-review
```

To pin a version, copy it with `cp -R` instead. For one project only, put it in that repo's `.claude/skills/`.

## How it works

`branch-review` asks Git for the changed files in the range, pipes each file's diff through `delta` with a fixed theme, and lays out the result with [Ink](https://github.com/vadimdemedes/ink). Untracked files are diffed against `/dev/null`, so new files show up before anyone stages them.

Watch mode follows the tracked directories plus the Git state that moves on a commit, push, or fetch: `HEAD`, the index, the current branch ref, and remote refs. A cheap fingerprint decides whether anything changed. When it did, a worker thread rebuilds the review so the UI stays responsive while delta runs.

## Development

```sh
pnpm install      # also builds dist/
pnpm dev          # run from source with tsx
pnpm test
pnpm typecheck
pnpm build
```

## License

MIT © hcastro
