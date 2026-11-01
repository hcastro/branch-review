# Preview and Review in browser

This document describes the two ways `branch-review` shows a changed markdown, image, or SVG file the way GitHub would, with what changed marked on the page. **Preview** draws a markdown file's page right in the review, in place of its diff. **Review in browser** opens the page in a cmux browser split or your default browser, and **All files in browser** opens a page that lists every such file. This document also covers how a page arrives, the first-time tip and the key list, the `--export-html` option, what a page shows and its keys, image pages, pages that also look different, the links and images that won't resolve on GitHub, which images a page includes, how close a page is to github.com, and the JSON reports. For the other options, see the [Options](../README.md#options) section of the README.

## Review a file in the browser

To open the changes of the markdown, image, or SVG file in view, press `r`, or click **Review in browser ⇗** in the file header. The button comes first in the header of each of those files, after **Preview** on a markdown file, and the two are the last to go when the header is too narrow for every button. An image or an SVG opens its own page, described in [Image pages](#image-pages). To open a page that lists every file, press `R` for **All files in browser**. Neither key changes what the review shows, and you can keep reading while the page opens.

Where the page opens depends on where you run `branch-review`:

| Where you run it | Where the page opens |
| --- | --- |
| In a cmux workspace | A browser split to the right of the review. The split doesn't take the keyboard, and each later press sends the same split to the new page. |
| In cmux, with its browser turned off in its settings | Your default browser. cmux opens it there itself. |
| In another terminal on macOS or Linux | A new tab in your default browser, on each press. On Linux, `xdg-open` on your `PATH` opens it. |
| Over SSH | Nothing opens. On a markdown file that Preview can draw, press `v` to read the page in the review. |

After each press the footer says where the page went, such as `⇗ setup.md opened in the browser split` or `⇗ setup.md opened in your browser`. When the file in view has no page, `r` opens the review's first page and names it, such as `⇗ docs/setup.md opened in the browser split · the first file with a page`. When the branch changed no markdown, image, or SVG file, the footer reads `nothing to open in the browser · no markdown, images or SVG on this branch`.

The pages are made in the background while you read, so a page is usually ready before you press `r`. If it isn't, the footer reads `preparing setup.md…` until the page opens. After 5 seconds it gives up with `setup.md took too long to prepare`.

The footer names the following problems:

| Message | What it means |
| --- | --- |
| `opened in your browser · cmux didn't answer` | cmux didn't place the page within 1.5 seconds, so your default browser opened it. If a split from an earlier press was closed, the next press opens a new one without a message. |
| `opened in the browser split · cmux was slow to answer` | cmux took more than 1.5 seconds to send the split to the page. The page might land a moment late, and the next press uses the same split. |
| `opened in your browser · cmux's browser is off` | cmux's browser is turned off in its settings. Each press opens the page in your default browser. |
| `open isn't available over SSH` | Over SSH, nothing opens on the remote machine. To get the pages there, run `branch-review --export-html DIR`. On a markdown file that Preview can draw, the message names `v`, which previews the page in the review. |
| `no browser opener found` | On Linux, no `xdg-open` is on your `PATH`. |
| `Preview and Review in browser turned off` | The page worker failed three times in a minute, so `v`, `r`, and `R` stay off for the session. Image previews keep working. |
| `can't write the page: disk full` | The session's temp directory is full. |

The pages live in the session's temp directory, which only you can read, and `branch-review` removes it when you quit. For the temp directory's location, see `BRANCH_REVIEW_TMPDIR` in the [Environment variables](../README.md#environment-variables) section of the README.

### All files in the browser

The page that `R` opens lists every page of the review, in the review's order. Each row shows the file's status letter, its path, and what its page marks, such as `3 changed · 1 removed`, and opens that page. An image's row gives its sizes, such as `1200×480 · 84 KB → 1200×520 · 91 KB`. Under the pages, it has the following groups:

- **Also looks different** lists markdown files the branch didn't change that show an image it did. For more information, see [Pages that also look different](#pages-that-also-look-different).
- **Deleted** lists deleted files. Each one's page shows the base version.
- **Won't render on GitHub** lists each link and image that won't resolve on GitHub, with its file and line, such as `README.md:41  setup.md#tokenz · anchor not found`. Each row opens its page at that line. For more information, see [Find what won't resolve on GitHub](#find-what-wont-resolve-on-github).

The rail counts each group, and the strip's red chip, such as `1 broken link · 2 images won't render`, jumps to the last group. The foot of the page sums the ways the pages differ from github.com.

`R` waits up to 3 seconds for pages that aren't ready yet. A file whose page isn't ready by then reads `not ready yet` and has no link. Press `R` again later to see it. A row links only to a page made from the review as it is now, so a file you edited since its last page reads `not ready yet` too. When its page can't be written, the row adds the reason, such as `not ready yet · disk full`.

A page you open before the other files' pages are ready shows no count beside them in its rail, and a tooltip on each says `not ready yet`. Once they're ready, that page is written again with their counts, and the next `r` opens the new one.

### Motion on the way

While the page opens, a shade band sweeps the diff toward the split, for about a third of a second. The band crosses only the rows that hold diff text. Block headers, the blank rows under the last file, and pictures in the diff stay as they are.

A new split narrows the review as it opens, so a press that opens one plays the band first and opens the split after it. A press that goes to an open split opens the page while the band plays.

The following settings change the motion in the terminal:

- `--no-animations` turns the band off, along with the review's other motion.
- `NO_COLOR` turns the band off.
- With **Reduce motion** on in macOS's accessibility settings, the band gives way to one short flash of the **Review in browser ⇗** button. `branch-review` reads the setting once per session, and not over SSH.
- `BRANCH_REVIEW_MOTION` overrides the macOS setting: `full`, `reduce`, or `off`.

## How a page arrives

A page opens on the block you were reading. `branch-review` takes the diff line at the top of the diff, and the page scrolls so that the block holding that line sits as far down the window as the line sat down the diff. To open a page at a given change, press `]` until the change is at the top of the diff, then press `r`.

The first time a file's page opens in a session, it starts as the text you were reading: the file's source in your terminal's colors, with added lines tinted green and removed lines back in red. A new file starts all green, and a deleted one all red. After a moment the text develops into the page. Each block in view grows from its lines into place while the tints shrink into the bars in the margin. The **before** chips and removed markers appear after their blocks have landed, and then the changed blocks glow once. The page is final in under a second. Any key, click, or scroll finishes the develop at once.

A split that has just opened paints your terminal's background from its first frame, so it never flashes white before the source shows.

A split in a cmux workspace you aren't looking at holds its page still. A page that opens there plays its develop when you switch to it, unless you pressed a key or scrolled in it first. A develop that the browser holds back past its schedule ends on the final page.

A later trip to a page you've seen this session scrolls to the block and glows it once, with no develop.

`branch-review` asks the terminal for its text and background colors at startup. A terminal that doesn't answer gets light gray text on a near-black background. The colors, the line to open at, and the motion setting ride in the hash of the page's URL, such as `#at=L42&f=0.35&d=full&m=1`, so a page that's already open in the split only gets a new hash.

The following settings change how the page arrives:

- With **Reduce motion** on in your system's accessibility settings, the page fades from the raw text once, with no movement and no glow.
- `--no-animations` opens the page final at once.
- With scripts turned off in the browser, the page shows final, and its keys and buttons stay hidden.

### Live updates in watch mode

In watch mode inside cmux, when the file you last opened with `r` changes, or an edit to another file changes what its page shows, such as a link that no longer resolves, the split goes to its new page within a second, at the place you scrolled the split to. The new page doesn't develop. The blocks that are new since the last page glow once instead. The split gets at most one update a second, and an update never takes the place of a page you just opened with `r`. After you close the split, the updates stop until the next `r` opens one. The page in a browser tab, and the page of all files, don't update.

Before each update, `branch-review` asks cmux which page the split shows. The split updates only while it shows that file's page. After you go to another page with `{`, `}` or a link, the split stays where you went, and updates to the file resume after you go back to its page. When cmux doesn't answer within 1.5 seconds, that update is skipped. To follow the page you moved to, press `r` on its file in the review.

## Preview a markdown file

**Preview** draws a markdown file's page inside the review, in place of its diff. It's on in a terminal that can draw it, and then the footer lists `v preview` and the header shows **Preview** on a markdown file. To turn it off, set `BRANCH_REVIEW_PREVIEW` to `off`, `0`, `false`, or `none` before you start `branch-review`:

```sh
BRANCH_REVIEW_PREVIEW=off branch-review
```

`BRANCH_REVIEW_PREVIEW=on` is accepted and changes nothing.

Preview needs the following:

- A terminal that draws Kitty images, such as Ghostty, cmux, or Kitty. Other terminals keep the diff, and `v` on a markdown file does nothing new. Inside tmux, only the session that draws pictures gets Preview, and over SSH it needs a terminal that draws Kitty images on your side.
- A terminal that reports its cell size in pixels. Each tile is cut to fill its cells exactly, so the terminal never scales it. Ghostty, cmux, and Kitty report it.
- A headless Chromium on disk. `branch-review` never installs one. When `BRANCH_REVIEW_CHROME` is set, it's used only when it's an absolute path to a program outside the repo. A `BRANCH_REVIEW_CHROME` that can't be used turns Preview off, and `branch-review` looks for no other Chromium. With it unset, `branch-review` uses the newest `chrome-headless-shell` that Playwright or Puppeteer installed, else Google Chrome on macOS. On Linux it then takes the first of `chrome-headless-shell`, `chromium`, `chromium-browser`, and `google-chrome` on your `PATH`. A program inside the repo under review is never used.

To preview the markdown file in view, press `v`, or click **Preview**. The page takes the diff's width up to the width GitHub lays a file out at, centered, and its text is the same height as the terminal's. The diff's text dissolves, the page's colors arrive as shade characters, and an accent line sweeps down with the sharp page above it. The page opens on the block that was at the top of the diff. To go back, press `v` again or click **Diff**, and the diff comes back in one frame, at the line the page showed at the top.

The Preview stays on while you move to another markdown file with `↑`, `↓`, or the tree. Other files keep their diff, and `v` on an image or an SVG keeps its own meaning.

The bars in the margin are text beside the page: green for an added block, amber for a changed one, and a dotted red line where the branch removed content. A removed block's marker reads `r shows it in the split`, because the Preview has no click to open it.

In a Preview, the following keys change:

| Key | Action |
| --- | --- |
| `v` | Go back to the diff |
| `[` / `]` | Scroll to the previous or next change |
| `c` | Copy the markdown source of the block at the top, as the page shows it, even when the file changed on disk since |
| `p` / `b` | Copy the diff or the prompt of the change the block at the top shows. On a block the branch didn't change, nothing is copied, and the footer says to press `v` for the diff. |
| `r` | Open the page in the split or your browser, at the block at the top |

`j`, `k`, `g`, `G`, and the mouse wheel scroll the page. Clicking a link on the page follows it in the review: a heading on the page scrolls there, and a link to another file of the review opens that file. A web or email address is copied to the clipboard and never opened, because it's the repo's. A link that holds control characters isn't copied, and the footer says so. The footer reads `◆ Preview · as GitHub shows it` while the page is on screen.

Each page is laid out and cut into tiles by the headless Chromium, in the session's temp directory, with scripts and every network request off. `branch-review` starts Chromium on the first `v`, never at startup, so a review you don't preview never runs it. The page loads as a document, never as a file or a URL, and every host resolves to nothing. The tiles go to the terminal as images before any row of the review shows them, and at most ten of them are kept in the terminal at a time. When the tiles on screen aren't in the terminal yet, the Preview holds on the page's colors, and after a moment the footer reads `drawing the page…`.

### When Preview can't draw the page

A page that can't be drawn never leaves you waiting. The diff comes back in one frame, at the line the page showed at the top, and the footer reads `✗ Preview isn't available:` with the reason and that `r` opens it in the browser. Over SSH, where `r` opens nothing, the footer names `branch-review --export-html <dir>` in its place. That happens in the following cases:

- Chromium couldn't lay out the page or cut a tile of it, or it crashed. Laying out a page has 15 seconds, which covers Chromium's first start.
- The tiles on screen still haven't arrived 5 seconds after the page was laid out. When Chromium lost the page and lays it out again, as after it starts anew, the 5 seconds start again once that layout lands.
- The terminal has no room left for a tile on screen, because its image memory or its image ids are used up.

When the page worker turns off, the diff comes back the same way, and the footer reads `✗ Preview and Review in browser turned off:` with the reason. `v`, `r`, and `R` then stop working for the session.

The file keeps its diff until you press `v` again, which tries the page once more. Other markdown files keep their pages. When a page fails while you read another file, the review stays where you are, and the footer says why after you reach that file. After Chromium fails three times in a minute, Preview stays off for the session, the footer no longer lists `v preview`, and `v` says why.

The following settings change Preview:

- `--no-animations`, **Reduce motion** in macOS, and `BRANCH_REVIEW_MOTION` turn its motion off. The page then replaces the diff at once.
- Over SSH and inside tmux, Preview sends fewer frames, skips the page's colors, and sends tiles ahead only one below the screen.
- `BRANCH_REVIEW_PREVIEW_DPR` draws the page at a fixed scale, such as `2`, in place of the one that makes its text as tall as the terminal's. It's there to compare the two by eye.

The footer names the following problems, each after `✗ Preview isn't available:`, except the last two:

| Message | What it means |
| --- | --- |
| `no Chrome found` | No headless Chromium was found, or `BRANCH_REVIEW_CHROME` names one that can't be used. Set `BRANCH_REVIEW_CHROME` to the absolute path of one, or install `chrome-headless-shell`. `r` still opens the page. The footer doesn't list `v preview` until a Chromium is found at the next start. |
| `the terminal didn't report its cell size` | The terminal didn't answer the cell size query, so a tile would be scaled and blurred. `r` still opens the page. |
| `the page didn't draw within 5 s` | The tiles on screen didn't arrive in time, as from a Chromium that stopped answering. The review shows the file's diff. To try again, press `v`. |
| `the terminal's image memory is full` or `every terminal image id is in use` | The terminal has no room for a tile on screen, because the pictures and tiles on screen already fill it. Pictures off screen don't count, since `branch-review` lets them go to make room. The review shows the file's diff. |
| Any other reason | This file's page couldn't be drawn, for that reason, so the review shows its diff. To try again, press `v`. |
| A reason that ends with `off for this session` | Chromium failed three times in a minute, so Preview stays off for the session. `r` still works. |
| `✗ Preview and Review in browser turned off` | The page worker failed three times in a minute. The diff comes back, and `v`, `r`, and `R` stop working for the session. The footer no longer lists `v preview`. |
| `too narrow to preview` | This line takes the page's place when the review is too narrow to read a page in. Make the window wider, or hide the file tree with `t`. |
| `the rest of the page is too long to preview` | This line ends a page taller than the 10,000 rows Preview draws, as a page whose HTML sets a huge height can be. Preview draws the top of it, and `r` opens all of it. |

## Learn the keys

The first time in a session that the file in view is one that Preview or Review in browser can show, the footer shows one line about them for about 6 seconds, or until you press a key or click: `Tip: press v to preview this file as GitHub shows it, or r to open its changes in the browser`. On an image or an SVG, and wherever Preview can't draw, the tip names only `r`. The tip doesn't show again that session, and it doesn't show once you've opened a Preview. Moving the pointer over the terminal doesn't end it. A message in the footer, such as a copy's, never hides behind the tip: a message that comes while the tip shows waits for it, and the tip waits for a message on screen.

To list every key, press `?`. The list groups the keys under **Move around**, **Copy**, **Preview and browser**, and **Images and video**, and says what each does in a few words. To close it, press `Esc` or `?`. While it's open, `j` and `k` scroll it when it's taller than the window, `q` quits, and other keys do nothing. The footer ends with `? keys` in a review with a file to preview or open. A review with neither, such as one that changed only code, looks as it always has, and `?` does nothing there.

## Export the pages

To write a page for every changed markdown, image, and SVG file, pass `--export-html` with a directory:

```sh
branch-review --export-html ../pages
```

`branch-review` builds the same review that the UI shows, writes one HTML file per page, prints a summary, and exits. The directory also gets `overview.html`, the page of all files that `R` opens, and `links.json`, which lists every link on the pages. For more information about `links.json`, see [Use the JSON reports](#use-the-json-reports). It doesn't open the UI or a browser, and it doesn't watch for changes. A relative directory resolves from where you run the command, and `branch-review` creates the directory when it doesn't exist. Pick a directory outside the repo: pages written inside it show up as untracked files in the next review.

The summary lists each page with its status letter, its file, and what changed:

```
Wrote 2 pages to ../pages/ · nothing left this machine
  M docs/setup.md     ../pages/4c1e9a7b20d1c3e5f6a8.html  3 changed · 1 removed
  A docs/flow.md      ../pages/9be1f0c2d4a6b8e0f2a4.html  new file
```

A page whose changes left nothing to mark, such as a new link definition, reads `no blocks marked`. An image's line gives its sizes, and a page that also looks different is listed after the review's pages, with a `·` for its status. A page that Git was too slow to check in full, even when made a second time, adds `git was slow · some links and images unchecked`. Such a page that shows a changed image is listed with the pages that also look different, though its mark might be missing.

Open any page in a browser. The rail on its left links to the other pages.

Each page's file name is a hash of the file's content and of the set of files with pages, so a file name never carries repo text. A run on the same content writes the same names and replaces its earlier files. `branch-review` writes nothing else in the directory and never deletes a file there.

`--export-html` takes the same refs as the UI. For example, `branch-review my-feature main --export-html ../pages` writes the pages of `my-feature`'s commits against `main`.

## Read a page

A page shows the file the way GitHub's file view draws it, with GitHub's stylesheet, in light or dark to match your system. The strip at the top names the base and the branch, and the head over the article shows the file's status and its changes, such as `M · 3 changed · 1 removed`. When there's no count to show, the status letter is followed by its word, such as `A · new file` or `D · deleted`.

Changes are marked by block. A block is a paragraph, a heading, a code block, a list item, or a table row:

- A green bar in the margin marks a block that the branch added. A table row's bar sits in the same margin, as tall as the row.
- An amber bar marks a block that the branch changed. A paragraph that was only rewrapped counts as changed. The **before** chip under the right end of a changed block fades in the whole block as it was on the base. In a list item, the chip follows the item's text and stays there when you open it. In a table, the chip sits at the bottom right of the changed row's last cell, in room the row keeps under its text, so the columns keep the widths GitHub gives them. Opening it lays the old row, under its header, over the rows below it.
- A dashed red marker, such as `− 1 paragraph removed · show`, sits where the branch removed content. Click it to see the removed text on a red tint.

When the branch rewrote a stretch of the file, each new block is matched with the old block it replaced, by kind and wording. A matched block is marked changed. A new block with no match is marked added, and an old block with no match gets a removed marker. Blocks match only when their wording is close, so a new paragraph never shows as an edit of unrelated old text. A block of images matches by the images it shows. A block whose text is the same on both sides, such as a heading that Git's diff lists as removed and added again around a rewritten section, carries no mark.

A block that the diff didn't touch carries no mark. Changes in blank lines alone carry no mark either, and neither does text that shows as nothing, such as a link definition or an HTML comment. A block whose text changed but renders the same also carries no mark, such as a list item renumbered by an item added above it, or a line that lost a trailing space.

A table is marked by its rows. A changed row is matched with the old row that has the same first cell, so a row added under an edited one is marked added. A change to a column's alignment marks the header row.

On a narrow screen, such as a narrow split, the rail folds into a one-line file switcher above the file's head. The switcher lists what the rail lists, and its count, such as `1 of 7`, counts the review's files. The fidelity chip shortens to `≈ GitHub`, the findings chip to a count such as `✗ 2`, and the theme button to its sign. The **Changes** button keeps its word. Under 400 pixels wide, the fidelity chip shortens to `≈`.

### Keys on a page

A page has keys of its own, which work in the split after you click into it. The following table lists them:

| Key | Action |
| --- | --- |
| `[` / `]` | Scroll to the previous or next change. The file head counts where you are, such as `change 2 of 4`, and its `↑` and `↓` buttons do the same. |
| `{` / `}` | Open the previous or next file in the rail. On the page of all files, move to the previous or next row, and press `Enter` to open it. |
| `t` | Switch the theme between your system's, light, and dark. The **◐** button in the strip does the same. |
| `m` | Show or hide the change marks: the bars, the removed markers, and the **before** chips. The **▍ Changes** button in the strip does the same. |
| `?` | Show the keys. `Esc` closes them. |

An image page has keys of its own too. For more information, see [Image pages](#image-pages).

When the page has links or images that won't resolve on GitHub, a red chip in the strip counts them, such as `1 broken link`. Click it to scroll to each one in turn.

The browser remembers your theme and marks choice for the pages it opens, when it allows the pages to store it.

A new file shows a `new file` banner in place of bars, and an untracked file shows `untracked · not part of a push yet`. A deleted file shows the base version under `deleted on this branch`, with its images dimmed and its text at full contrast. A renamed file names its old path.

A file that can't be shown as a page gets a card in its place, and its head names the state, such as `M · couldn't show`:

- An empty file shows `this file is empty`.
- A file over 2 MiB shows `too large to show` with its size, followed by the start of its text.
- A file that isn't UTF-8 text shows `not UTF-8 text`.
- A file whose page fails shows `couldn't show this file` with the reason, followed by its text. A file whose page takes more than 5 seconds to make shows `took too long to prepare` as the reason, and the other pages are still made.
- A file whose diff couldn't be read gets the same card, with the reason the review gives. A file whose terminal diff failed still gets its page, since the page needs only the diff.
- A working tree file that changes after `branch-review` reads its diff gets the same card, with the reason `doesn't match the diff`, so no mark lands on the wrong text. Run the command again to show the new text.

## Image pages

An image or an SVG that the branch changed gets a page of its own. Its head gives each version's dimensions and size, such as `1200×480 · 84 KB → 1200×520 · 91 KB`. Under the pictures, `appears in` names each line of the review's pages that shows the image, such as `README.md:18`, and each one opens that page at that line.

A modified image shows its two versions side by side, the base's on the left, each on a checkerboard so its transparent parts show. The following keys compare them, the same digits as an image preview in the review:

| Key | Action |
| --- | --- |
| `1` | Show the two versions side by side. |
| `2` | Flip between the versions in one place, the branch's first. Press `2` again, press `f`, or click the picture to show the other one. |
| `3` | Show the difference: the branch's version laid over the base's, dark where they match and light where they differ. |

The buttons over the pictures do the same. **◐ checkerboard** turns the checkerboard off and on, and **fit** switches between fitting the picture to the page and showing it at its own size. The browser remembers the compare mode for the next image page.

A new image shows alone on its checkerboard under a `new file` banner. A deleted image shows its base version dimmed under `deleted on this branch`. A version that can't go on the page, such as one over 8 MiB, shows a card in its place, such as `image not inlined · page limit · o opens it in branch-review`. The compare keys then stay off.

An SVG goes on its page as an image, the same way GitHub shows it, so a script in it never runs and it loads nothing.

## Pages that also look different

A markdown file that the branch didn't change can still look different on GitHub, when it shows an image that the branch changed. `branch-review` searches the branch for markdown files that name a changed image's file name, or the name a moved image had before, for 2 seconds at most, and reads up to 40 of them. In the review, they count toward the 40 files whose pages are made in the background, after the review's own pages, so a review with 40 pages or more searches for none. A file whose page shows a changed image gets a page. Its head reads `text unchanged · embeds docs/hero.png`, and the block that shows the image carries a bar and a **before** chip, the way any changed block does.

These pages are listed under **ALSO LOOKS DIFFERENT** in every page's rail and under **Also looks different** on the page of all files. A file that only names the image in its text gets no page.

## Find what won't resolve on GitHub

Each page checks its links and images against what GitHub would find. A link that won't resolve gets a red wavy underline, and a tooltip names the reason. A link to a heading on another page of the review is checked against that page's headings. A link to a heading in a markdown file the review didn't change is checked against the headings of that file as Git holds it on the branch. A link to `#top` opens a page at its top, and a heading named in other capitals, such as `#Install` for `## Install`, counts as found. The following table lists the reasons:

| Reason | What it means |
| --- | --- |
| `anchor not found` | No heading or anchor on the page has that name. |
| `file not found` | No file or folder has that path on the branch. |
| `file is untracked` | The file is in the working tree, and Git doesn't track it. |
| `ignored by git` | The ignore rules hide the file. |
| `case mismatch: Docs/Setup.md vs docs/setup.md` | The file exists with other capitals. macOS finds it, and GitHub doesn't. |

A link to a file that Git tracks and the review has no page for keeps its dotted underline. An image that won't render on GitHub keeps its red card, described in [Images on a page](#images-on-a-page).

A page's link checks get 3 seconds, as its images do. A link that names no file on the branch is found missing at once. Git has to say whether such a file is untracked or ignored, and whether a heading in another file is there. A link that Git hasn't answered for by then keeps its first answer. One that has no answer at all is plain text with the tooltip `not checked in time`, and it isn't counted. The page is made again after Git answers. `--export-html` makes such a page once more.

The strip's chip counts the page's own findings. The rail sums the review's in a few words, such as `2 links won't resolve` and `1 image: case mismatch`. The page of all files lists each one. The pages of a deleted file and of a page that also looks different aren't checked, and neither is the old text in a **before** view or a removed marker. Their links keep a dotted underline.

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
| `took too long to read` | A page's images get 3 seconds in all. The page still shows, with this card for each image left, and is made again after Git answers. `--export-html` makes it once more. |

An image whose line endings only differ from what Git holds, as `eol=crlf` writes them, shows as usual.

An SVG goes on the page as an image, the way GitHub shows it, so a script in it never runs and it loads nothing.

## How close a page is to GitHub

The pages are made on your machine with the parser rules, sanitizer, and stylesheet that GitHub uses. Soft line breaks stay soft, so hard-wrapped prose reflows the way it does on GitHub. Alerts such as `> [!NOTE]`, task lists, footnotes, tables, emoji shortcodes, YAML frontmatter, heading anchors, and the raw HTML GitHub allows all show as they do there. Code blocks are highlighted with GitHub's grammars.

The **≈ GitHub** chip in the strip lists what differs on that page, with a count. A page can differ from github.com in the following ways:

- A Mermaid diagram, a math block, a map, or a 3D model shows as its source with a tag, such as `diagram · GitHub draws this`. Inline math stays as text.
- A remote image, such as a badge, shows as a dashed card with its alt text and host, such as `build passing · img.shields.io · not loaded (offline)`. An image marked `#gh-dark-mode-only` or `#gh-light-mode-only` shows its card only in that theme, and a pair of them counts once.
- A link to a file that isn't part of the review is inert, with a dotted underline. A link to another file with a page opens that page, and a link to a heading scrolls to it. A page's address that ends in a heading's link as GitHub writes it, such as `#install`, opens the page at that heading, as it does on github.com. A link that won't resolve on GitHub is drawn broken, as described in [Find what won't resolve on GitHub](#find-what-wont-resolve-on-github).
- Code colors come from the same grammars as GitHub's and can drift between versions.

## What a page can reach

Nothing on a page leaves your machine. A page is one self-contained file, and its content security policy blocks every request: no remote image, font, or stylesheet loads, and the page can't fetch anything or submit a form. The policy lets only the page's own stylesheet and its own script apply, each allowed by its hash. The script reads the page and the hash of its URL. It puts the repo's text on screen as plain text, never as markup.

Repo content can't run on a page. HTML in a markdown file passes GitHub's sanitizer model, which removes scripts, event handlers, styles, forms, frames, and `javascript:` links, and prefixes ids with `user-content-`. Repo HTML can't add a change bar or forge any other mark. A repo link whose `#` part reads like a page's own hash, such as `#d=full`, shows as an inert link, so repo text can't make a page develop or glow.

`branch-review` reads the files' text and images from Git or from the working tree, the same way the review does. The pages that `r` and `R` open go in the session's temp directory. `--export-html` writes only to the directory you pass it.

To open a page, `branch-review` runs cmux, `/usr/bin/open` on macOS, or `xdg-open` on Linux, each by its full path. Each one gets the page's file URL, whose name is a hash. cmux also gets the workspace and the split it named. No repo text reaches any of them.

## Use the JSON reports

To print the report as JSON in place of the summary, add `--json`:

```sh
branch-review --export-html ../pages --json
```

The report has the following fields:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `base`, `branch` | The refs, as the UI names them, such as `HEAD + worktree` |
| `dir` | The directory's absolute path |
| `pages` | One entry per page, in the review's order |
| `also` | One entry per page that also looks different |
| `findings` | Each link and image that won't resolve on GitHub |

Each entry in `pages` and `also` has the following fields:

| Field | Value |
| --- | --- |
| `path` | The file's path relative to the repo root |
| `status` | `modified`, `added`, `deleted`, `renamed`, or `untracked` |
| `file` | The page's file name inside `dir` |
| `state` | `markdown`, `image`, `empty`, `tooLarge`, `notUtf8`, or `failed` |
| `changes` | `changed`, the number of blocks marked added or changed, and `removed`, the number of removed markers |
| `differences` | Each way the page differs from github.com, as `kind` and `count`. The kinds are `mermaid`, `math`, `diagram`, `remoteImage`, and `outsideLink`. |
| `image` | On an image's page, `before` and `after`, each with `bytes`, `width`, and `height` |
| `embeds` | On a page that also looks different, the changed images it shows |
| `late` | `true` when Git was slow to answer for some of the page's links and images, even when the page was made a second time. Those links read `unchecked`, and a page that also looks different may show its changed image unmarked. |
| `reason` | Why the file's page failed, when `state` is `failed` |

Each entry in `findings` has the following fields:

| Field | Value |
| --- | --- |
| `path`, `line` | The page's file and the line the link or image is on |
| `target` | The link or image path as the file writes it |
| `what` | `link` or `image` |
| `kind` | `badAnchor`, `missing`, `untracked`, `ignored`, or `caseMismatch` for a link, and the reason an image card gives for an image, such as `caseMismatch` or `lfs` |
| `reason` | The reason in words, as the page says it |

`links.json` in the directory has `version`, `base`, `branch`, the same `findings`, and `links`, every link on the review's pages. Each link has its `path`, `line`, the `href` as written, and a `status`: `ok`, `outside` for a file Git tracks that the review has no page for, `unchecked` for a link Git didn't answer for in time, or one of the link kinds in the preceding table.

Hidden characters in paths and ref names, such as control characters and bidi overrides, are written as `\u` escapes, so the reports print as plain text and decode to the real names.

When no markdown, image, or SVG file changed, the summary reads `nothing to export · no markdown, images or SVG on this branch`, the JSON report has empty lists, and the directory gets no files.

If the directory can't be written, `branch-review` prints a one-line reason, such as `can't write the pages to ../pages: not a directory`, and exits with status 1. `--json` without `--export-html` is an error too.
