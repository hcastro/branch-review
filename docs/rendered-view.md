# Rendered markdown pages

This document describes how `branch-review` renders the branch's changed markdown files as the pages GitHub would show, with what changed marked on each page. It covers opening a page from the review, how a page arrives, the `--render-out` option, what a page shows and its keys, which images a page includes, how close a page is to github.com, and the JSON report. For the other options, see the [Options](../README.md#options) section of the README.

## Open a page from the review

To open the page of the markdown file in view, press `r`, or click **Rendered ⇗** in the file header. The button is the first one in the header of a changed markdown file, and it's the last to go when the pane is too narrow for all of them. To open an overview of every page, press `R`. Neither key changes what the review shows, and you can keep reading while the page opens.

Where the page opens depends on where you run `branch-review`:

| Where you run it | Where the page opens |
| --- | --- |
| In a cmux workspace | A browser split to the right of the review. The split doesn't take the keyboard, and each later press sends the same split to the new page. |
| In cmux, with its browser turned off in its settings | Your default browser. cmux opens it there itself. |
| In another terminal on macOS or Linux | A new tab in your default browser, on each press. On Linux, `xdg-open` on your `PATH` opens it. |
| Over SSH | Nothing opens. |

After each press the footer says where the page went, such as `⇗ setup.md · in the split →`. The first page of a session adds `nothing left this machine`. When the file in view has no page, `r` opens the review's first page and names it, such as `⇗ docs/setup.md · first rendered file · in the split →`. When the branch changed no markdown, the footer reads `nothing to render · no markdown files on this branch`.

The pages render in the background while you read, so a page is usually ready before you press `r`. If it isn't, the footer reads `rendering setup.md…` until the page opens. After 5 seconds it gives up with `setup.md took too long to render`.

The footer names the following problems:

| Message | What it means |
| --- | --- |
| `cmux didn't answer · opened in your browser` | cmux didn't place the page within 1.5 seconds, so your default browser opened it. If a split from an earlier press was closed, the next press opens a new one without a message. |
| `in the split → · cmux was slow to answer` | cmux took more than 1.5 seconds to send the split to the page. The page may land a moment late, and the next press uses the same split. |
| `opened in your browser · cmux's browser is off` | cmux's browser is turned off in its settings. Each press opens the page in your default browser. |
| `open isn't available over SSH` | Over SSH, nothing opens on the remote machine. To get the pages there, run `branch-review --render-out DIR`. |
| `no browser opener found` | On Linux, no `xdg-open` is on your `PATH`. |
| `rendered view turned off` | The renderer failed three times in a minute, so `r` and `R` stay off for the session. Image previews keep working. |
| `can't write the page: disk full` | The session's temp directory is full. |

The pages live in the session's temp directory, which only you can read, and `branch-review` removes it when you quit. For the temp directory's location, see `BRANCH_REVIEW_TMPDIR` in the [Environment variables](../README.md#environment-variables) section of the README.

### The overview

The overview lists every page of the review, in the review's order. Each row shows the file's status letter, its path, and what its page marks, such as `3 changed · 1 removed`, and opens that page. A deleted file is listed under **Deleted**, and its page shows the base version. The foot of the overview sums the ways the pages differ from github.com.

`R` waits up to 3 seconds for pages that are still rendering. A file whose page isn't ready by then reads `not rendered yet` and has no link. Press `R` again later to see it. A row links only to a page rendered from the review as it is now, so a file you edited since its last page reads `not rendered yet` too. When its page can't be written, the row adds the reason, such as `not rendered yet · disk full`.

A page you open before the other files have rendered shows no count beside them in its rail, and a tooltip on each says `not rendered yet`. Once they render, that page is written again with their counts, and the next `r` opens the new one.

### Motion on the way

While the page opens, a shade band sweeps the diff toward the split, for about a third of a second. The band crosses only the rows that hold diff text. Block headers, the blank rows under the last file, and pictures in the diff stay as they are.

The following settings change the motion in the terminal:

- `--no-animations` turns the band off, along with the review's other motion.
- `NO_COLOR` turns the band off.
- With **Reduce motion** on in macOS's accessibility settings, the band gives way to one short flash of the **Rendered ⇗** button. `branch-review` reads the setting once per session, and not over SSH.
- `BRANCH_REVIEW_MOTION` overrides the macOS setting: `full`, `reduce`, or `off`.

## How a page arrives

A page opens on the block you were reading. `branch-review` takes the diff line at the top of the pane, and the page scrolls so that the block holding that line sits as far down the window as the line sat down the pane. To open a page at a given change, press `]` until the change is at the top of the diff, then press `r`.

The first time a file's page opens in a session, it starts as the text you were reading: the file's source in your terminal's colors, with added lines tinted green and removed lines back in red. A new file starts all green, and a deleted one all red. After a moment the text develops into the rendered page. Each block in view grows from its lines into place while the tints shrink into the bars in the margin. The **before** chips and removed markers appear once their blocks have landed, and then the changed blocks glow once. The page is final in under a second. Any key, click, or scroll finishes the develop at once.

A split in a cmux workspace you aren't looking at holds its page still. A page that opens there plays its develop when you switch to it, unless you pressed a key or scrolled in it first. A develop that the browser holds back past its schedule ends on the final page.

A later trip to a page you've seen this session scrolls to the block and glows it once, with no develop.

`branch-review` asks the terminal for its text and background colors at startup. A terminal that doesn't answer gets light gray text on a near-black background. The colors, the line to open at, and the motion setting ride in the hash of the page's URL, such as `#at=L42&f=0.35&d=full&m=1`, so a page that's already open in the split only gets a new hash.

The following settings change how the page arrives:

- With **Reduce motion** on in your system's accessibility settings, the page fades from the raw text once, with no movement and no glow.
- `--no-animations` opens the page final at once.
- With scripts turned off in the browser, the page shows final, and its keys and buttons stay hidden.

### Live updates in watch mode

In watch mode inside cmux, when the file you last opened with `r` changes, the split goes to its new page within a second, at the place you scrolled the split to. The new page doesn't develop. The blocks that are new since the last page glow once instead. The split gets at most one update a second, and an update never takes the place of a page you just opened with `r`. After you close the split, the updates stop until the next `r` opens one. The page in a browser tab, and the overview, don't update.

`branch-review` can't see a move you make inside the split. After you go to another page with `{`, `}` or a link, the next change to the file you opened with `r` brings the split back to that file. To follow the page you moved to, press `r` on its file in the review.

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

- A green bar in the margin marks a block that the branch added. A table row's bar sits in the same margin, as tall as the row.
- An amber bar marks a block that the branch changed. A paragraph that was only rewrapped counts as changed. The **before** chip under the right end of a changed block fades in the whole block as it was on the base. In a list item, the chip follows the item's text.
- A dashed red marker, such as `− 1 paragraph removed · show`, sits where the branch removed content. Click it to see the removed text on a red tint.

When the branch rewrote a stretch of the file, each new block is matched with the old block it replaced, by kind and wording. A matched block is marked changed. A new block with no match is marked added, and an old block with no match gets a removed marker. Blocks match only when their wording is close, so a new paragraph never shows as an edit of unrelated old text. A block of images matches by the images it shows. A block whose text is the same on both sides, such as a heading that Git's diff lists as removed and added again around a rewritten section, carries no mark.

A block that the diff didn't touch carries no mark. Changes in blank lines alone carry no mark either, and neither does text that renders as nothing, such as a link definition or an HTML comment. A block whose text changed but renders the same also carries no mark, such as a list item renumbered by an item added above it, or a line that lost a trailing space.

A table is marked by its rows. A change to a column's alignment marks the header row.

On a narrow screen, such as a narrow split, the rail folds into a one-line file switcher above the file's head.

### Keys on a page

A page has keys of its own, which work in the split after you click into it. The following table lists them:

| Key | Action |
| --- | --- |
| `[` / `]` | Scroll to the previous or next change. The file head counts where you are, such as `change 2 of 4`, and its `↑` and `↓` buttons do the same. |
| `{` / `}` | Open the previous or next file in the rail. On the overview, move to the previous or next row, and press `Enter` to open it. |
| `t` | Switch the theme between your system's, light, and dark. The **◐** button in the strip does the same. |
| `m` | Show or hide the change marks: the bars, the removed markers, and the **before** chips. The **▍ Changes** button in the strip does the same. |
| `?` | Show the keys. `Esc` closes them. |

The browser remembers your theme and marks choice for the pages it opens, when it allows the pages to store it.

A new file shows a `new file` banner in place of bars, and an untracked file shows `untracked · not part of a push yet`. A deleted file shows the base version under `deleted on this branch`, with its images dimmed and its text at full contrast. A renamed file names its old path.

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

Nothing on a page leaves your machine. A page is one self-contained file, and its content security policy blocks every request: no remote image, font, or stylesheet loads, and the page can't fetch anything or submit a form. The policy lets only the page's own stylesheet and its own script apply, each allowed by its hash. The script reads the page and the hash of its URL. It puts the repo's text on screen as plain text, never as markup.

Repo content can't run on a page. HTML in a markdown file passes GitHub's sanitizer model, which removes scripts, event handlers, styles, forms, frames, and `javascript:` links, and prefixes ids with `user-content-`. Repo HTML can't add a change bar or forge any other mark. A repo link whose `#` part reads like a page's own hash, such as `#d=full`, shows as an inert link, so repo text can't make a page develop or glow.

`branch-review` reads the files' text and images from Git or from the working tree, the same way the review does. The pages that `r` and `R` open go in the session's temp directory. `--render-out` writes only to the directory you pass it.

To open a page, `branch-review` runs cmux, `/usr/bin/open` on macOS, or `xdg-open` on Linux, each by its full path. Each one gets the page's file URL, whose name is a hash. cmux also gets the workspace and the split it named. No repo text reaches any of them.

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
