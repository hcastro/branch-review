# Clipboard copies in branch-review

This document describes what each copy in `branch-review` puts on the clipboard, which clipboard tool it uses, and when a copy refuses. For the list of copy buttons and keys, see the [Copy context back to the agent](../README.md#copy-context-back-to-the-agent) section of the README.

## Clipboard tools

`branch-review` writes to the clipboard through a command-line tool. It picks the tool for your platform as follows:

- macOS: `pbcopy`.
- Windows: `clip.exe`.
- WSL: `clip.exe`, then the Linux tools.
- Linux: `xclip`, `xsel`, or `wl-copy`. Under Wayland, when `WAYLAND_DISPLAY` is set, `wl-copy` comes first.

With no tool installed, a copy fails with `No clipboard tool found. Install xclip or wl-clipboard.`

A clipboard tool gets 5 seconds to finish. After that, `branch-review` stops it and the footer says the copy timed out. A tool such as `xclip` that leaves a background process running still reports success as soon as it exits. When a tool fails, its error output becomes the reason in the footer.

## Exact bytes

Every copy keeps the file's exact bytes, including a drag-select. The screen shows control characters and bidirectional (bidi) overrides as visible markers, and a copy holds the real characters.

A drag-select across code copies the code alone. It leaves out delta's line-number gutter and the `+` and `-` markers, and it copies a wrapped source line as one line. Tabs stay tabs, and a carriage return (CR), an escape, or a bidi control shown as a marker copies as the character itself.

Image previews don't change any copy. Every copy key gives the same payload with previews on or off, and a drag across a picture copies only the text around it.

## Agent-ready blocks

**Copy block**, or `b`, builds a snippet in the following format:

- A `File:` line with the path relative to the repo root.
- A `Lines:` line with the block's line range in the new version.
- A `Function:` line, when Git's hunk header names the enclosing function.
- A blank line, then the block's patch in a `diff` fence.

The fence is longer than any run of backticks in the patch, so no line of code can close it early. The patch keeps its trailing blank context lines, so the fenced text still applies. A CR or line feed (LF) in a file name is written as `\r` or `\n`, so a file name can't forge an extra `File:` line.

## The changed-file tree

**Copy tree**, or `T`, copies every changed file as an ASCII tree under the repo root's absolute path. The following example shows the payload for a review with three changed files:

````
```
/repo
├── README.md
└── src
    ├── app.ts
    └── new.ts
```
````

The fence is longer than any run of backticks in a file name, so no name can close it. A CR or LF in a name is escaped as `\r` or `\n`, which keeps every name on one row. The footer reports how many files it copied.

## Copies during a refresh

A drag-select in progress follows its lines when a refresh adds a file above them. If the selected lines themselves change, `branch-review` drops the selection, so you never copy text that you didn't select. A footer message says that the diff changed while you were selecting.

Block keys act on the focused block. A block that you focused with `[` or `]` keeps its focus through a refresh that leaves its header in place. If the refresh moves the header, the focus returns to the block at the top of the pane, and the copy keys act on that block.

## Copies that refuse

Some copies fail on purpose, and the footer names the reason. A copy never contains altered text. `branch-review` refuses a copy in the following cases:

- A file that isn't valid UTF-8 text can't be copied as text. The copy reports `not UTF-8 text`.
- **Copy file** and `f` refuse a file over 16 MiB.
- A deleted file has no contents, so **Copy file** and `f` copy nothing.
- A file whose diff failed to load refuses its diff and block copies, which report that failure as the reason. **Copy file** and `f` still work, because they read the reviewed version of the file.
- A file whose name isn't valid UTF-8 can't be copied at all, its path included. Every copy of it reports `file name is not UTF-8`.
- **Copy tree** and `T` copy nothing when any one file name in the review isn't valid UTF-8. The tree is refused whole, and the footer message names that file.

A drag-select follows the same rules as the keys. It copies nothing and shows the reason when its lines come from a file that a copy key refuses.

## Copy feedback

After a copy, the button that you clicked reads **✓ Copied** for about 1.2 seconds. For about 2.2 seconds, the footer shows a message that names what you copied, such as `✓ Copied block · src/a.ts:12`. A drag-select message gives the number of characters or lines, and a failed copy shows a red `✗` with the reason.
