# Rendered markdown pages

This document describes how `branch-review` renders the branch's changed markdown files as the pages GitHub would show, with what changed marked on each page. It covers the `--render-out` option, what a page shows, which images a page includes, how close a page is to github.com, and the JSON report. For the other options, see the [Options](../README.md#options) section of the README.

## Write the pages

To write a page for every changed markdown file, pass `--render-out` with a directory:

```sh
branch-review --render-out ../rendered
```

`branch-review` builds the same review that the UI shows, writes one HTML file per page, prints a summary, and exits. It doesn't open the UI or a browser, and it doesn't watch for changes. A relative directory resolves from where you run the command, and `branch-review` creates the directory when it doesn't exist. Pick a directory outside the repo: pages written inside it show up as untracked files in the next review.

The summary lists each page with its status letter, its file, and what changed:

```
Rendered 2 pages to ../rendered/ · nothing left this machine
  M docs/setup.md     ../rendered/4c1e9a7b20d1c3e5f6a8.html  3 changed · 1 removed
  A docs/flow.md      ../rendered/9be1f0c2d4a6b8e0f2a4.html  new file
```

A page whose changes left nothing to mark, such as a new link definition, reads `no blocks marked`.

Open any page in a browser. The rail on its left links to the other pages.

Each file name is a hash of the file's content and of the set of rendered files, so a file name never carries repo text. A run that renders the same content writes the same names and replaces its earlier files. `branch-review` writes nothing else in the directory and never deletes a file there.

`--render-out` takes the same refs as the UI. For example, `branch-review my-feature main --render-out ../rendered` renders `my-feature`'s commits against `main`.

## Read a page

A page shows the file the way GitHub's file view renders it, with GitHub's stylesheet, in light or dark to match your system. The strip at the top names the base and the branch, and the head over the article shows the file's status and its changes, such as `M · 3 changed · 1 removed`.

Changes are marked by block. A block is a paragraph, a heading, a code block, a list item, or a table row:

- A green bar in the margin marks a block that the branch added. A changed table row carries its bar on its first cell, inside the table, since a wide table scrolls sideways on its own.
- An amber bar marks a block that the branch changed. A paragraph that was only rewrapped counts as changed. The **before** chip under the right end of a changed block opens the whole block as it was on the base. In a list item, the chip follows the item's text.
- A dashed red marker, such as `− 1 paragraph removed · show`, sits where the branch removed content. Click it to see the removed text on a red tint.

When the branch rewrote a stretch of the file, each new block is matched with the old block it replaced, by kind and wording. A matched block is marked changed. A new block with no match is marked added, and an old block with no match gets a removed marker. Blocks match only when their wording is close, so a new paragraph never shows as an edit of unrelated old text. A block of images matches by the images it shows. A block whose text is the same on both sides, such as a heading that Git's diff lists as removed and added again around a rewritten section, carries no mark.

A block that the diff didn't touch carries no mark. Changes in blank lines alone carry no mark either, and neither does text that renders as nothing, such as a link definition or an HTML comment. A block whose text changed but renders the same also carries no mark, such as a list item renumbered by an item added above it, or a line that lost a trailing space.

A table is marked by its rows. A change to a column's alignment marks the header row.

On a narrow screen, such as a narrow split, the rail folds into a one-line file switcher above the file's head.

A new file shows a `new file` banner in place of bars, and an untracked file shows `untracked · not part of a push yet`. A deleted file shows the base version, dimmed, under `deleted on this branch`. A renamed file names its old path.

A file that can't render as a page shows a card in its place, and its head names the state, such as `M · couldn't render`:

- An empty file shows `this file is empty`.
- A file over 2 MiB shows `too large to render` with its size, followed by the start of its text.
- A file that isn't UTF-8 text shows `not UTF-8 text`.
- A file that fails to render shows `couldn't render this file` with the reason, followed by its text. A file that takes the renderer more than 5 seconds shows `took too long to render` as the reason, and the other pages still render.
- A file whose diff couldn't be read gets the same card, with the reason the review gives. A file whose terminal diff failed still renders, since its page needs only the diff.
- A working tree file that changes after `branch-review` reads its diff gets the same card, with the reason `doesn't match the diff`, so no mark lands on the wrong text. Run the command again to render the new text.

## Images on a page

A page carries each image from the repo inside its own file, so the image shows with no network and no other file. A page includes an image when GitHub would show it too: the path stays inside the repo, the file is a regular file, and Git tracks it on that side of the diff or the review changed it. The page shows the branch's version of each image. A **before** view and a removed marker show the base's version. In a file the branch moved, they find each image from the file's old folder, the way the base showed it. In a review of the working tree, an image the review changed shows as it is on disk.

A block whose text didn't change is marked changed when an image it shows changed on the branch. Its **before** view shows the base's version of the image.

In a review of the working tree, an untracked image that the review shows goes on the page as it is on disk, with the note `untracked · not part of a push yet` under it. GitHub shows it after you commit and push it.

An image that GitHub won't show gets a red card in its place. The card starts with `won't render on GitHub:`, gives the reason, and ends with the path. The reasons are the following:

| Reason | What it means |
| --- | --- |
| `file is untracked` | The file is in the working tree, and Git doesn't track it. GitHub shows it after you commit and push it. |
| `ignored by git` | The ignore rules hide the file. `branch-review` doesn't read an ignored file. |
| `case mismatch: logo.png vs Logo.png` | The file exists with other capitals. macOS finds it, and GitHub doesn't. |
| `file not found` | No file has that path on that side of the diff. |
| `symlink · not followed` | The path, or a folder on it, is a symbolic link. |
| `outside the repo` | The path climbs out of the repo with `..`, names an absolute path, or leads through a folder that resolves outside the repo. |
| `LFS object · not fetched` | Git holds a Git LFS pointer for the file, and `branch-review` doesn't fetch the object. A checked-out LFS image gets this card too. |
| `submodule · not rendered` | The path is a submodule, or a file inside one. |
| `not an image` | The file isn't a PNG, JPEG, GIF, WebP, AVIF, SVG, BMP, or ICO image. |

An amber card marks an image that GitHub can show and the page leaves out. `image not inlined · page limit` stands for an image over 8 MiB, an SVG over 4 MiB, or any image after a page holds 32 MiB of images, **before** views and removed markers included. `image not inlined` with a reason stands for an image `branch-review` couldn't read:

| Reason | What it means |
| --- | --- |
| `can't read the file` | The working tree file can't be opened, for example because nobody may read it. |
| `can't read it from git` | Git couldn't give the image's bytes. In a partial clone, `branch-review` fetches nothing, so an image whose blob the clone lacks gets this card. Git 2.44 and later can read a partial clone without fetching. With an older Git, every image in a partial clone gets this card. |
| `doesn't match git: changed since the review read it, or by a git filter` | The working tree file isn't the content the review read. Run the command again to include it. |
| `took too long to read` | A page's images get 3 seconds in all. The page still renders, with this card for each image left. |

An image whose line endings only differ from what Git holds, as `eol=crlf` writes them, shows as usual.

An SVG goes on the page as an image, the way GitHub shows it, so a script in it never runs and it loads nothing.

## How close a page is to GitHub

The pages are rendered on your machine with the parser rules, sanitizer, and stylesheet that GitHub uses. Soft line breaks stay soft, so hard-wrapped prose reflows the way it does on GitHub. Alerts such as `> [!NOTE]`, task lists, footnotes, tables, emoji shortcodes, YAML frontmatter, heading anchors, and the raw HTML GitHub allows all render. Code blocks are highlighted with GitHub's grammars.

The **≈ GitHub** chip in the strip lists what differs on that page, with a count. A page can differ from github.com in the following ways:

- A Mermaid diagram, a math block, a map, or a 3D model shows as its source with a tag, such as `diagram · GitHub draws this`. Inline math stays as text.
- A remote image, such as a badge, shows as a dashed card with its alt text and host, such as `build passing · img.shields.io · not loaded (offline)`. An image marked `#gh-dark-mode-only` or `#gh-light-mode-only` shows its card only in that theme, and a pair of them counts once.
- A link to a file that isn't part of the review is inert, with a dotted underline. A link to another rendered file opens that file's page, and a link to a heading scrolls to it.
- Code colors come from the same grammars as GitHub's and can drift between versions.

## What a page can reach

Nothing on a page leaves your machine. A page is one self-contained file with no script, and its content security policy blocks every request: no remote image, font, or stylesheet loads, and the page can't fetch anything or submit a form.

Repo content can't run on a page. HTML in a markdown file passes GitHub's sanitizer model, which removes scripts, event handlers, styles, forms, frames, and `javascript:` links, and prefixes ids with `user-content-`. Repo HTML can't add a change bar or forge any other mark.

`branch-review` reads the files' text and images from Git or from the working tree, the same way the review does. It writes only to the directory you pass to `--render-out`.

## Use the JSON report

To print the report as JSON in place of the summary, add `--json`:

```sh
branch-review --render-out ../rendered --json
```

The report has the following fields:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `base`, `branch` | The refs, as the UI names them, such as `HEAD + worktree` |
| `dir` | The directory's absolute path |
| `pages` | One entry per page, in the review's order |

Each entry in `pages` has the following fields:

| Field | Value |
| --- | --- |
| `path` | The file's path relative to the repo root |
| `status` | `modified`, `added`, `deleted`, `renamed`, or `untracked` |
| `file` | The page's file name inside `dir` |
| `state` | `rendered`, `empty`, `tooLarge`, `notUtf8`, or `failed` |
| `changes` | `changed`, the number of blocks marked added or changed, and `removed`, the number of removed markers |
| `differences` | Each way the page differs from github.com, as `kind` and `count`. The kinds are `mermaid`, `math`, `diagram`, `remoteImage`, and `outsideLink`. |
| `reason` | Why the file failed to render, when `state` is `failed` |

Hidden characters in paths and ref names, such as control characters and bidi overrides, are written as `\u` escapes, so the report prints as plain text and decodes to the real names.

When no markdown changed, the summary reads `nothing to render · no markdown files on this branch`, and the JSON report has an empty `pages` list.

If the directory can't be written, `branch-review` prints a one-line reason, such as `can't write the pages to ../rendered: not a directory`, and exits with status 1. `--json` without `--render-out` is an error too.
