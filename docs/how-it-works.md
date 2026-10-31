# How branch-review works

This document describes how `branch-review` builds a review, how watch mode decides when to refresh, how the app treats your terminal, and what it touches on disk. For more information about image and video previews, see [Image and video previews](media-previews.md).

## Diffs and files

`branch-review` asks Git for the changed files in the range, pipes each file's diff through `delta` with a fixed theme, and lays out the result with [Ink](https://github.com/vadimdemedes/ink). Untracked files are diffed against `/dev/null`, so new files show up before anyone stages them.

delta runs with line numbers and the Monokai Extended theme. `branch-review` ignores your delta settings in your Git config and in `DELTA_FEATURES`, so the layout always matches what the app expects. A diff over 1 MiB and a line longer than 3,000 characters render in full, with nothing cut off.

Git runs with fixed settings, so repo config can't change what you read or copy. The following rules apply to every review:

- `branch-review` ignores repo settings that could swap in another diff or run a program, such as `diff.external`, textconv drivers, and `core.fsmonitor` hooks.
- Diffs keep their `a/` and `b/` prefixes and blank context lines under `diff.noprefix`, `diff.mnemonicPrefix`, and `diff.suppressBlankEmpty`, so a copied patch still applies.
- File names are literal. A name such as `app/[id]/page.tsx`, or one that starts with pathspec magic, never acts as a pattern.
- A renamed file is diffed against its old path, and copy detection never pairs the wrong files.

A symlink shows as its link text, and a symlink to a FIFO never blocks the app. A file that's too large, or isn't a regular file, is refused before it's read.

A submodule shows as its old and new `Subproject commit` lines, marked `-dirty` when it has local edits. A `chmod +x` shows the new mode, counting only the owner's execute bit, the way Git records it.

One bad file never stops the review. Some files can't load: a file that can't be read, one deleted between the listing and the diff, or a blob that a partial clone can't fetch. Each becomes an error row with the reason, and the rest of the review loads.

If a file fails while it's being drawn, the pane shows `✗ could not render PATH`, where `PATH` is the file's path, with the reason. The next scroll or refresh tries again.

## Watch mode

Watch mode follows the working tree plus the Git state that moves on a commit, push, or fetch: `HEAD`, `FETCH_HEAD`, the index, the current branch ref, remote refs, and packed refs. On macOS and Windows, it uses one recursive watch from the operating system on the repo root. On Linux, it watches only directories, so files add no handles and the count follows the number of directories.

Either way, the watcher skips what Git ignores, never follows symlinks, and doesn't descend into submodules or nested repos. `--watch-poll` is the fallback when filesystem events don't arrive.

The watcher tracks changes to the tree itself:

- Writes to ignored files, such as logs, build output, and `node_modules`, never trigger a refresh. Editing `.gitignore` or `.git/info/exclude` starts or stops watching paths as the rules change.
- `branch-review` asks Git about a new directory before it walks into it, so a fresh `npm install` or a new build directory opens no watch handles.
- Directories created after startup are watched, and a directory that a checkout deleted and created again keeps working.
- A `git init` inside the tree, or a nested clone that loses its `.git` directory, moves its files into or out of the review.
- A submodule that commits, checks out another commit, or gets local edits refreshes the review, including a submodule added after startup.

In a linked worktree, the review refreshes for that worktree's own `HEAD`, index, and submodules. A commit made from another worktree to a branch that this review covers still shows up.

## Refresh

A burst of writes produces one refresh after 200 ms of quiet. A steady stream of writes, such as a build or a log, still refreshes about once a second.

`branch-review` compares a fingerprint of the repo state to decide whether anything changed. Touching a file without changing its content costs nothing, because delta runs only when the content, the execute bit, or a submodule's state moved.

When something did change, a background process rebuilds the review so the UI keeps responding while delta runs. Each file it finishes counts as progress, and so does each chunk of output from `git` or `delta`. `branch-review` stops that process only after `git` or `delta` sends no output for 30 seconds, so a slow refresh of a large repo can finish.

Each refresh recalculates the range, so the review follows commits, checkouts, and pushes to a remote base. The current-branch label in the top bar follows a checkout too. If a refresh fails, the last good review stays on screen, and the footer shows Git's `fatal` or `error` line, or says that the refresh ran out of memory. The next change tries again.

After a refresh, a new file or block is tinted green and an edited one teal, and the tint fades within about 1.6 seconds. Below truecolor, such as on a 256- or 16-color terminal, the tint is a bright-black background that lasts about 1.2 seconds. The file's tree row stays lit in green or cyan for about 2.6 seconds, and with color off there's no highlight.

A checkout that touches hundreds of files highlights at most 120 entries.

Resizing the terminal lays out the frame for the new size right away. The review wraps again after the width stays the same for 120 ms, and delta's output is rebuilt for the new pane width without restarting the watcher.

## Terminal handling

The first build runs before the UI opens. `Control+C` or `SIGTERM` during a slow startup exits immediately, stops the running `git`, and removes the private index copy. Keys you type before the UI opens stay with your shell when the app exits early.

Startup errors print one line and exit with code 1. A bad ref prints `Base ref not found: REF` or `Branch ref not found: REF`, where `REF` is the ref that `branch-review` couldn't find. Refs with no common ancestor print that the two refs share no history. Without delta on your `PATH`, the app says so and links the delta installation instructions.

A run with watch mode off and no changes prints `No file changes between BASE and BRANCH.` and exits with code 0, without taking over the terminal. `BASE` and `BRANCH` are the resolved refs. In watch mode, the app opens an empty review and waits for changes.

On `q`, `Esc`, `Control+C`, `SIGTERM`, a closed window, or a crash, `branch-review` turns off every mouse mode, shows the cursor, and leaves the alternate screen. Signals exit with code 130 for `SIGINT`, 143 for `SIGTERM`, and 129 for `SIGHUP`. A crash prints one `branch-review: REASON` line, where `REASON` is the error message. `Alt+q` and `Control+q` don't quit.

`branch-review` holds the app's console output until the session ends. After the terminal is restored, it writes that output to stderr with hidden characters escaped.

## What branch-review touches

`branch-review` never writes to the repo it reviews. It leaves the index, the working tree, refs, the stash, config, and hooks alone. Working-tree diffs read a private copy of the index with Git's optional locks off, so a stat-dirty file never makes Git rewrite `.git/index` or a submodule's index. Git runs with `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`.

A few things happen the same way they do for `git status` or `git diff`:

- Configured clean filters such as git-lfs run on working-tree files, and git-lfs might store objects under `.git/lfs`.
- In a split-index repo, Git refreshes the shared index file's modification time on every read. Its content stays the same.
- A partial clone might fetch missing objects on demand, and Git writes what it fetches into `.git/objects` as new pack files. Git is never allowed to prompt, so a fetch that needs credentials shows up as an error on that file.

Outside the repo, `branch-review` writes temp files under the system temp directory, or under `BRANCH_REVIEW_TMPDIR` when it's set. These hold the private index copy, the refresh process's files, and one private directory for media. Images and videos opened in a viewer are temp copies.

`branch-review` removes its temp files when it exits, and a refresh that's stopped, or whose parent quits or crashes, stops its `git` and `delta` and removes its temp directory. The next start removes media directories left by a session that crashed.
