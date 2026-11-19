# branch-review reference

This document lists the arguments, options, and environment variables of the `branch-review` command, and every key and mouse gesture in a review. For what `branch-review` does and how to install it, see the [README](../README.md).

## Command

The command takes up to two refs:

```
branch-review [BRANCH [BASE]] [OPTIONS]
```

Replace the following:

- `BRANCH`: the branch to review. The default is `HEAD`, which also includes uncommitted and untracked files. Any other branch is reviewed by its commits only.
- `BASE`: the branch to compare against. The default is the detected base.

The following examples show common comparisons:

```sh
branch-review                      # HEAD plus the working tree vs. the detected base
branch-review my-feature           # my-feature's commits vs. the detected base
branch-review my-feature main      # my-feature vs. main
branch-review HEAD HEAD            # uncommitted changes only
```

From a subdirectory, the review still covers the whole repo, with paths relative to the repo root. Outside a repo, `branch-review` exits with a one-line `not a git repository` error.

The detected base is `origin/HEAD` when the remote has one. Otherwise, `branch-review` uses the first of `development`, `main`, `master`, and `trunk` that exists, locally or on `origin`. If none of those exists, it uses the current branch, which leaves only uncommitted changes in the review. A repo where nothing resolves makes it exit and ask for a base, such as `branch-review HEAD main`.

Refs resolve locally first and then on `origin`, so you can review against a remote base that you never checked out:

```sh
branch-review my-feature release/2026.04
```

## Options

`branch-review` accepts the following options:

| Flag | Effect |
| --- | --- |
| `--watch` | Refresh live as files change. On by default in an interactive terminal. |
| `--no-watch` | Open a snapshot that doesn't refresh, for when an agent is mid-write and the view keeps changing. It overrides `--watch` and `--watch-poll`. |
| `--watch-poll` | Turn on watch mode, and poll for changes in place of filesystem events. Use it on network mounts and container bind mounts. |
| `--no-animations` | Skip the arrival highlights, the sweep toward a page in the browser, the page's glow on the card it opens at and its pulse on a live refresh, and Preview's arrival, and show an animated GIF or WebP as its first frame. Use it on slow or remote terminals. |
| `--animations` | Turn animations back on after an earlier `--no-animations`. |
| `--no-images` | Show image, SVG, and video files as plain diffs. |
| `--images` | Turn previews back on after an earlier `--no-images`. `BRANCH_REVIEW_IMAGES=off` and `NO_COLOR` still turn them off. |
| `--browser` | Open the review page for the whole branch where `r` would, in a cmux split or your default browser, then exit without opening the UI. It can't be combined with `--watch` or `--export-html`. |
| `--export-html DIR` | Write the review page for the whole branch to `DIR` as `index.html`, with `links.json`. Then print a summary and exit without opening the UI. |
| `--json` | With `--export-html`, print the report as JSON. |

For `--animations` and `--images`, the last flag of each pair wins.

## Environment variables

`branch-review` reads the following environment variables:

| Variable | Effect |
| --- | --- |
| `NO_COLOR` | Any non-empty value turns off color and image previews. |
| `FORCE_COLOR` | `0` or `false` turns off color and image previews. |
| `TERM` | `dumb` turns off color and image previews. `linux`, and `screen*` outside tmux, turn off image previews. |
| `BRANCH_REVIEW_IMAGES` | `auto`, the default, detects what the terminal can draw. `kitty` forces pictures in a terminal that supports them but isn't recognized. `blocks` forces the block preview. `off`, `none`, `0`, or `false` turns previews off. |
| `BRANCH_REVIEW_MOTION` | `full`, `reduce`, or `off` sets the motion of Preview and on the way to a page in the browser, in place of the quiet default and the macOS **Reduce motion** setting. |
| `BRANCH_REVIEW_PREVIEW` | `off`, `0`, `false`, or `none` turns Preview off, the page a markdown file shows in the review on `v`, in a terminal that draws Kitty images. `on`, like any other value, leaves it on. |
| `BRANCH_REVIEW_CHROME` | The absolute path of the headless Chromium or Chrome that Preview draws pages with, in place of the one `branch-review` finds on disk. |
| `BRANCH_REVIEW_PREVIEW_DPR` | A fixed scale for Preview's pages, such as `2`, in place of the one that makes their text as tall as the terminal's. For comparing the two. |
| `BRANCH_REVIEW_TMPDIR` | The directory for temp files, such as the private index copy and media files. The default is the system temp directory. |

The same settings turn off color in delta's diffs and in the rest of `branch-review`. With color off, diffs keep their `+` and `-` markers, and a selection shows in inverse video.

## Keys and mouse

The following table lists the keys for moving through a review:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Jump to the previous or next file |
| `j` / `k` | Scroll the diff down or up one line |
| `g` / `G` | Jump to the top or bottom |
| `[` / `]` | Focus the previous or next diff block |
| `Enter` / `Space` | Collapse or expand the focused block |
| `t` | Show or hide the file tree |
| `v` | Preview: on a markdown file, in a terminal that draws Kitty images, show the file as GitHub shows it, in place of its diff, and back. In a Preview, `[` and `]` move between changes and `c` copies the markdown of the block at the top. |
| `r` | Review in browser: open the branch's changes as one page in a browser split or your browser, at the file in view |
| `R` | All files in browser: open the branch's page at its top |
| `?` | List every key, in a review with a file to preview or open. `Esc` or `?` closes the list. |
| `q` / `Esc` / `Control+C` | Quit |

The tree highlights the file at the top of the diff and keeps that row in view as you scroll. That file's header shows its added, deleted, and changed line counts and its place in the review, such as `file 6/8`. Each block header names the file and the block's first line, such as `src/middleware/rateLimit.ts:1:`.

The focused block is the one at the top of the diff pane until you move the focus with `[` or `]`. Heavy `┃` bars mark its header, so the mark reads without color. The footer keeps a short hint of the keys that apply to the file in view. For more information about the copy keys, see the [Copy buttons and keys](#copy-buttons-and-keys) section.

While an image or video preview is on screen, the following keys work:

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Compare a modified image side by side, by flipping between its versions, or as a difference. `2` again flips to the other version. On a video, `1` shows both frame strips and `2` shows one. |
| `v` | Switch an image or video to a details table and back. On an SVG, show its source only, and back. |
| `o` | Open the image or video in the default viewer |
| `O` | Preview the image or video in Quick Look on macOS. On Linux and BSD, `O` works like `o`. |

You can also do most of this with the mouse:

| Gesture | Action |
| --- | --- |
| Click a file | Jump the diff to that file |
| Click a folder | Collapse or expand it |
| Click a block header | Collapse or expand that diff block |
| Click **Preview** in a file header | Show the file's Preview, like `v` |
| Click **Diff** in a file header | Go back from the Preview to the diff, like `v` |
| Click **⇗ Review in browser** in a file header | Open the branch's page in the browser at that file, like `r` |
| Click a link in a Preview | Scroll to a heading on the page, open another file of the review, or copy a web address |
| Drag across code | Select lines and copy them |
| Drag the tree's right border | Resize the file tree. Dragging it to its minimum width collapses it to a rail. |
| Click `‹` or `›` in the tree header | Collapse or expand the file tree |
| Scroll | Scroll whichever pane is under the pointer, three lines per notch |

To see what a button, badge, or label does, hold the pointer over it. A short hint appears in the top bar, such as `copies block with file and line context`.

The branch's page in the browser has keys of its own, which work after you click into the page:

| Key | Action |
| --- | --- |
| `j` / `k` | Scroll to the next or previous file's card |
| `v` | Mark the current file as viewed and move to the next, or unmark it |
| `?` | Show the page's keys |
| `Esc` | Close the keys, a menu, or the file list |

A page that `--export-html` writes has the same keys.

## Copy buttons and keys

File keys copy from the file at the top of the diff, and block keys copy from the focused block. The following table lists every copy:

| Where | Button | Key | Copies |
| --- | --- | --- | --- |
| File header | **Copy path** | `y` | The path relative to the repo root |
| File header | **Copy absolute path** | `Y` | The full path on disk. The button appears when you hold the pointer over **Copy path**. |
| File header | **Copy diff** | `d` | The file's diff |
| File header | **Copy file** | `f` | The file's contents in the reviewed version: the file on disk by default, or the branch's version when you review a named branch |
| Diff block | **Copy code** | `c` | The block's added lines, without diff markers |
| Diff block | **Copy diff** | `p` | The block's diff |
| Diff block | **Copy block** | `b` | The block as agent-ready context |
| Tree row | **Copy** | None | That file's path |
| Tree header | **Copy tree** | `T` | The changed files as a fenced ASCII tree |

A file header always shows its buttons. A diff block shows its buttons when it's focused or when you hold the pointer over it, and a tree row shows **Copy** while the pointer is over the row. After a copy, the button reads **✓ Copied** for a moment, and the footer names what you copied, such as `✓ Copied block · src/a.ts:12`.

Some copies refuse on purpose, and the footer names the reason. A file that isn't UTF-8 text, for example, reports `not UTF-8 text`. For more information about refusals and payload formats, see [Clipboard copies in branch-review](copying.md).

## Small terminals

When the terminal is narrower than 74 columns, the file tree collapses to a rail beside the diff, and it opens again after the window is wide enough. Below 58 columns by 14 rows, `branch-review` shows `Terminal too small` with the current and required size. Until you make the window bigger, only `q`, `Esc`, and `Control+C` work.
