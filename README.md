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
  <a href="https://github.com/hcastro/branch-review/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hcastro/branch-review/ci.yml?branch=main&style=flat-square&label=ci"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-56d4dd?style=flat-square"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-d2a8ff?style=flat-square">
  <img alt="Powered by git-delta" src="https://img.shields.io/badge/diffs-git--delta-7ee787?style=flat-square">
</p>

<p align="center">
  <img alt="branch-review showing a changed-file tree next to a syntax-highlighted diff of src/middleware/rateLimit.ts" src="assets/review-ui.png" width="100%">
</p>

Run `branch-review` in any Git repo, from the root or any folder inside it. You get a changed-file tree, syntax-highlighted diffs from [`git-delta`](https://github.com/dandavison/delta), and per-file and branch-wide stats. The view updates live while files change on disk.

Every file and diff block has copy buttons. They hand a path, a diff, or an agent-ready block of context to Claude Code, Codex, Cursor, or a Slack thread in one click.

## Watch an agent work

Leave `branch-review` open next to a coding agent. New files land in the tree as they're written. Edits wash in over the diff you're reading, and you never reload.

<p align="center">
  <img alt="An agent writes a new file and edits it while branch-review shows each change arriving live" src="assets/live-review.gif" width="100%">
</p>

By default the review covers `HEAD` plus your worktree against the base branch. Commits the agent made and edits it hasn't committed yet show up together, scoped the way the eventual PR will be.

## Install

You need Node.js 22+, Git, and `git-delta` on your `PATH`. CI runs on Node 22 and 24.

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

From a subdirectory, the review still covers the whole repo, with paths relative to the repo root.

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
| `--no-images` | Show image files as text, the way terminals without image support do. `--images` turns them back on. |

Colour is off when `NO_COLOR` is set to any non-empty value, when `FORCE_COLOR` is `0` or `false`, or when `TERM=dumb`. The same rule covers delta's diffs and the app's own chrome. Diffs keep their `+` and `-` markers.

## Reviewing

### Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Previous / next file |
| `j` / `k` | Scroll the diff down / up |
| `g` / `G` | Jump to the top / bottom |
| `[` / `]` | Previous / next diff block |
| `Enter` / `Space` | Collapse or expand the focused block |
| `t` | Show or hide the file tree |
| `o` | Open the image on screen in the default viewer |
| `O` | Quick Look the image on macOS. Elsewhere it works like `o`. |
| `v` | Switch the image to a details table and back |
| `1` / `2` / `3` | Compare a modified image side by side, by flipping between its versions, or as a difference. `2` again flips to the other version. |
| `q` / `Esc` / `Ctrl-C` | Quit |

The focused block is the one at the top of the diff pane, and it's marked. The footer keeps a short hint of these keys.

Every copy action works from the keyboard too. File keys copy from the current file, and block keys copy from the focused block.

| Key | Copies |
| --- | --- |
| `y` | Path relative to the repo root |
| `Y` | Absolute path |
| `d` | The file's diff |
| `f` | The file's current contents |
| `c` | The block's code |
| `p` | The block's diff |
| `b` | The block as agent-ready context |
| `T` | The changed-file tree |

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

Copies keep the file's exact bytes, from the buttons, the keys, and a drag-select alike. Tabs stay tabs and control characters stay as they are, even though the screen shows them as visible markers.

Some copies fail on purpose, and the toast names the reason:

- A file that isn't valid UTF-8 text can't be copied as text. The copy reports "not UTF-8 text".
- Copying contents (`Copy file` or `f`) fails for a file over 16 MB.
- When a file's diff failed to load, its diff and block copies report that failure as the reason. `Copy file` and `f` still work, since they read the file itself.
- A file whose name isn't valid UTF-8 can't be copied at all, its path included. Every copy of it reports "file name is not UTF-8".
- `Copy tree` and `T` copy nothing when any one file name in the review isn't valid UTF-8. The tree is refused whole, and the toast names that file.

### Images

In a terminal that draws images, added, deleted and modified PNG, JPEG, GIF, WebP and AVIF files show as pictures in the diff pane. Each one keeps its aspect ratio and is sized to fit the pane. Tiny icons are scaled up by a whole factor so their pixels stay sharp. In Kitty and in Ghostty 1.4 or later, an animated GIF or WebP plays in a loop, run by the terminal itself. Everywhere else, and with `--no-animations`, it shows its first frame and says how many it has.

A modified image opens with its old and new versions side by side. `2` (or the tab row above the picture) switches to flip mode, which shows one version at a time: press `2` again or click the picture to swap. `3` shows the difference, with changed pixels marked over a darkened copy of the new version and the share of the image that changed. The mode you pick stays for the rest of the session. The metrics row shows both versions' sizes and the change in bytes.

| Terminal | Images |
| --- | --- |
| Ghostty, cmux, Kitty | Drawn as pictures |
| Apple Terminal, Alacritty, iTerm2, WezTerm, VS Code, Warp, Konsole, and any other terminal with 256 colours or more | A block preview |
| Inside tmux | Drawn as pictures when tmux passes graphics through to Ghostty or Kitty (`set -g allow-passthrough all`), a block preview otherwise |
| Terminals with fewer than 256 colours, or that don't answer the startup query | The usual `binary file changed` line |

A block preview draws the picture in coloured half-block characters, two pixels to a cell and at most 60 × 20 cells. That's enough to tell which image you're looking at and roughly what changed, in every compare mode. `o` opens the real image, and the footer says `no image support detected` while one is on screen.

Inside tmux, every graphics command goes out wrapped for tmux's passthrough, the startup query and the deletes at exit included. Pictures are used only when the wrapped query gets an answer back, so a tmux that blocks passthrough gets the block preview and never shows stray text.

Use `allow-passthrough all`, not `on`. With `on`, tmux drops graphics sent while the pane is hidden behind another window, so a picture redrawn by a refresh then comes back as empty cells, and a quit from a hidden pane leaves its images in the terminal. With passthrough off, startup waits up to a second for an answer that never comes.

tmux answers the question of which terminal it runs in by itself, so inside tmux branch-review knows the outer terminal only from the variables the tmux server started with. A server started from Ghostty and later attached from WezTerm still looks like Ghostty, and the pictures there can show as empty cells. In that case set `BRANCH_REVIEW_IMAGES=blocks`, or start a new tmux server from the terminal you're using.

#### Video

An added, deleted or changed MP4, MOV or WebM shows a table of its length, size, resolution, codec and frame rate. For a changed video, the new version's row marks what changed: shorter or smaller in green, longer or larger in red. Under the table, each version gets a strip of four frames taken evenly through it, with their times underneath. `2` shows one version's strip at a time, larger, and `2` again swaps it. `1` shows both again.

The metadata and frames come from `ffprobe` and `ffmpeg` on your `PATH` (`brew install ffmpeg`). They're optional: without them a video shows its size, and the strip says what to install. Only a program outside the repo is ever run. It reads the video through a checked file descriptor, or a checked temp copy for a committed version, with the container forced and every input but plain files refused.

`o` plays the video in the default player. On macOS the header has `Play` and `Quick Look` buttons, and `O` opens Quick Look. A video in the work tree opens as the file itself, since players don't write to it. A committed version opens from a temp copy.

The file header gains an `Open` button in place of `Copy file`, since an image's contents aren't text. `f` still reports "not UTF-8 text". `o` and `Open` hand the viewer a private temp copy of the exact bytes on screen, never the file in your repo. Over SSH, `o` says it isn't available instead of opening anything on the remote machine.

Images stay off when colour is off (`NO_COLOR` and the rest of the colour rule), when the output isn't a terminal, with `--no-images`, or with `BRANCH_REVIEW_IMAGES=off`. The app then looks exactly as it does without image support. `BRANCH_REVIEW_IMAGES=kitty` forces pictures in a terminal that supports them but isn't recognised, and `BRANCH_REVIEW_IMAGES=blocks` forces the block preview.

Every image is read in a separate background process. Bytes are checked against the object id in Git's diff before anything is drawn, so a file that changed on disk or that a Git filter rewrites never shows as a stale or wrong picture. A file that can't be previewed shows the reason in its place. If that process keeps failing or hanging, previews turn off for the session and the review carries on.

Images are decoded with [sharp](https://sharp.pixelplumbing.com/), which ships prebuilt binaries of libvips. libvips is licensed under LGPL-3.0. Temp files go in one private directory under the system temp directory, and it is removed when the app exits.

### Small terminals

When the terminal is too narrow for both panes, the file tree collapses to a narrow rail beside the diff. Below a minimum size, the app shows "Terminal too small" until you make the window bigger. While it does, only `q`, `Esc` and `Ctrl-C` do anything.

## Agent skill

The repo ships an agent skill in [`skills/branch-review`](skills/branch-review). It teaches Claude Code, or any tool that reads `SKILL.md`, to hand you a ready-to-run `branch-review` command.

An agent can't drive a full-screen TUI, so the skill never runs the CLI itself. It works out which repo or worktree holds the changes, picks the refs, and copies one line to your clipboard:

```sh
cd '/Users/me/code/app' && branch-review
```

Ask for it with "let me review this", "/branch-review", or "show me the diff before you continue". Paste, review, and quit with `q`.

The command is written for POSIX shells and zsh. The script refuses a repo path or ref name that holds control or invisible characters, such as a newline, an escape, or a bidi control, because a pasted command can't carry those safely. Its own report shows them escaped, like `\x1b` or `\u202e`.

Link the skill into your user skills directory so it tracks the repo:

```sh
ln -s "$PWD/skills/branch-review" ~/.claude/skills/branch-review
```

To pin a version, copy it with `cp -R` instead. For one project only, put it in that repo's `.claude/skills/`.

## How it works

`branch-review` asks Git for the changed files in the range, pipes each file's diff through `delta` with a fixed theme, and lays out the result with [Ink](https://github.com/vadimdemedes/ink). Untracked files are diffed against `/dev/null`, so new files show up before anyone stages them.

Watch mode follows the work tree plus the Git state that moves on a commit, push, or fetch: `HEAD`, the index, the current branch ref, and remote refs. On macOS and Windows it uses one native recursive watch on the repo root. On Linux it watches directories only, so the number of handles grows with directories and never with files. Either way it skips what Git ignores, never follows symlinks, and doesn't descend into submodules or nested repos. `--watch-poll` is the fallback when filesystem events don't arrive.

A cheap fingerprint decides whether anything changed. When it did, a background process rebuilds the review so the UI stays responsive while delta runs. Each file it finishes counts as progress, and so does each chunk of output from `git` or `delta`. The process is stopped only when `git` or `delta` produces nothing for 30 seconds. A slow refresh of a large repo finishes, and a hung `git` or `delta` still gets killed.

### What branch-review touches

`branch-review` never writes to the repo it reviews. It leaves the index, the work tree, refs, the stash, config, and hooks alone. Worktree diffs read a private copy of the index with Git's optional locks off, so a stat-dirty file never makes Git rewrite `.git/index` or a submodule's index.

A few things happen the same way they do for `git status` or `git diff`:

- Configured clean filters such as git-lfs run on worktree files, and git-lfs may store objects under `.git/lfs`.
- In a split-index repo, Git refreshes the shared index file's mtime on every read. Its content stays the same.
- A partial clone may fetch missing objects on demand, and Git writes what it fetches into `.git/objects` as new pack files. Git is never allowed to prompt, so a fetch that needs credentials shows up as an error on that file.

## Development

```sh
pnpm install      # also builds dist/
pnpm dev          # run from source with tsx, watch mode included
pnpm test
pnpm typecheck
pnpm build
```

## License

MIT © hcastro
