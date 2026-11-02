# Preview and Review in browser

This document describes the two ways `branch-review` shows the branch the way GitHub would, with what changed marked. **Preview** draws a markdown file's page right in the review, in place of its diff. **Review in browser** opens one page for the whole branch in a cmux browser split or your default browser, laid out like a pull request on GitHub: a card for every changed file, with its diff, a markdown file's rich view, and an image's versions side by side. **All files in browser** opens the same page at its top. This document also covers the first-time tip and the key list, the `--export-html` option, the marks in a rich view, files that also look different, the links and images that won't resolve on GitHub, which images a page includes, how close a page is to github.com, and the JSON reports. For the other options, see the [Options](../README.md#options) section of the README.

## Review the branch in the browser

To open the branch's changes at the file in view, press `r`, or click **Review in browser ⇗** in the file header. The button comes first in the header of a markdown, image, or SVG file, after **Preview** on a markdown file, and the two are the last to go when the header is too narrow for every button. `r` works on any file, code included: the page opens at that file's card, which glows once unless you started `branch-review` with `--no-animations`. To open the page at its top, press `R` for **All files in browser**. Neither key changes what the review shows, and you can keep reading while the page opens.

Where the page opens depends on where you run `branch-review`:

| Where you run it | Where the page opens |
| --- | --- |
| In a cmux workspace | A browser split to the right of the review. The split doesn't take the keyboard, and each later press sends the same split to the file's card, with no reload. |
| In cmux, with its browser turned off in its settings | Your default browser. cmux opens it there itself. |
| In another terminal on macOS or Linux | A new tab in your default browser, on each press. On Linux, `xdg-open` on your `PATH` opens it. |
| Over SSH | Nothing opens. On a markdown file that Preview can draw, press `v` to read the page in the review. |

After each press the footer says where the page went, such as `⇗ setup.md opened in the browser split` or `⇗ all files opened in your browser`.

In a review with a markdown, image, or SVG file, the page is made in the background while you read, so it's usually ready before you press `r`. A review that changed only code makes its page the first time you press `r` or `R`. If the page isn't ready, the footer reads `preparing setup.md…` until it opens. After 10 seconds it gives up with `setup.md took too long to prepare`.

A press draws every file on the branch, and waits up to 2.5 seconds for the rich views and pictures that aren't drawn yet. A card whose rich view or picture is still on its way says `Still being prepared`. On a large branch, the files past the first 4 seconds of coloring show their diff without syntax colors, and their expand arrows are off. Such a page is made again a moment later, so the next `r` or `R` opens it whole. The page is also made again after a push, an amend, or a new commit, so its pill and **Commits** tab say what Git says now.

The footer names the following problems:

| Message | What it means |
| --- | --- |
| `opened in your browser · cmux didn't answer` | cmux didn't place the page within 1.5 seconds, so your default browser opened it. If a split from an earlier press was closed, the next press opens a new one without a message. |
| `opened in the browser split · cmux was slow to answer` | cmux took more than 1.5 seconds to send the split to the page. The page might land a moment late, and the next press uses the same split. |
| `opened in your browser · cmux's browser is off` | cmux's browser is turned off in its settings. Each press opens the page in your default browser. |
| `open isn't available over SSH` | Over SSH, nothing opens on the remote machine. To get the page there, run `branch-review --export-html DIR`. On a markdown file that Preview can draw, the message names `v`, which previews the page in the review. |
| `no browser opener found` | On Linux, no `xdg-open` is on your `PATH`. |
| `Preview and Review in browser turned off` | The page worker failed three times in a minute, so `v`, `r`, and `R` stay off for the session. Image previews keep working. |
| `can't write the page: disk full` | The session's temp directory is full. |

The page lives in the session's temp directory, which only you can read, and `branch-review` removes it when you quit. For the temp directory's location, see `BRANCH_REVIEW_TMPDIR` in the [Environment variables](../README.md#environment-variables) section of the README.

In watch mode, an edit writes a new page in the background, and the split follows it. Within a second of the new page, the split goes to it and lands where you were reading, with your viewed marks. Each card keeps what you did to it: the **Source** or **Rich** view you picked, a card you folded or opened, a viewed one included, and a long diff you loaded. A card that the edit changed opens again, its **Viewed** mark cleared as GitHub clears one, and its outline pulses once in the accent color. Other cards don't move. With **Reduce motion** on, or with `--no-animations`, nothing pulses. The split goes only while it still shows the page, so after you follow a link out of it, the next edit leaves it alone. A page made again only to fill in what was still being prepared leaves the split as it is, with the lines you expanded. Press `r` to see it whole. A page in a browser tab stays as it was until the next `r` or `R`.

### Motion on the way

While the page opens, a shade band sweeps the diff toward the split, for about a third of a second. The band crosses only the rows that hold diff text. Block headers, the blank rows under the last file, and pictures in the diff stay as they are.

A new split narrows the review as it opens, so a press that opens one plays the band first and opens the split after it. A press that goes to an open split opens the page while the band plays.

A page that opens in a new tab or a new split starts at its card. A press that goes to a split that already shows the page scrolls it to the card.

The following settings change the motion:

- `--no-animations` turns the band off, along with the review's other motion. The page then scrolls to its card at once.
- `NO_COLOR` turns the band off.
- With **Reduce motion** on in macOS's accessibility settings, the band gives way to one short flash of the **Review in browser ⇗** button. `branch-review` reads the setting once per session, and not over SSH. The page follows the system's setting too, and scrolls with no motion.
- `BRANCH_REVIEW_MOTION` overrides the macOS setting for the band: `full`, `reduce`, or `off`.

## Read the review page

The page names the branch and its base, such as `feature/docs-refresh into main`, under a bar that names the repo by its folder and says the page was built **On this machine**. A note under the bar says that nothing leaves the machine; its **×** dismisses it in this browser. A pill beside the title says where the branch stands against its upstream:

| Pill | What it means |
| --- | --- |
| **Not pushed** | The branch has no upstream. |
| **Ahead of origin by 2** | The branch has commits that its upstream on `origin` doesn't. The pill names the upstream's remote. |
| **Behind origin by 3** | The upstream has commits that the branch doesn't, as after a teammate's push that you fetched. |
| **Ahead 2, behind 3** | Each side has commits the other doesn't, as after an amend or a rebase of pushed commits. The pill's tooltip says which side has which. |
| **Up to date with origin** | The branch and its upstream have the same commits. |
| **Branch state unavailable** | Git didn't answer in time. The page is made again, and the next press shows the pill. |

A ref that isn't a local branch, such as a commit, gets no pill. `branch-review` reads the upstream from local refs and never fetches, so **Behind** counts the commits your last fetch brought.

The page has the following tabs:

- **Files changed** lists every changed file, in the review's order, with the branch's added and removed lines summed at its right.
- **Commits** lists the commits on the branch that the base doesn't have, by day, newest first. Each row shows the commit's subject, how long ago it was committed, how many files it changed, and its short hash. No author name or email is shown. The tab lists the newest 250 commits, and its count, the title and the toolbar give the full number, such as `Showing the newest 250 of 260 commits.` at the end of the list.

Under the tabs, a toolbar stays at the top while you scroll. It says which changes the page shows, such as `Showing changes from all 2 commits`, or `and uncommitted changes` for a review of the working tree. Its ring counts the files you've marked viewed, such as `1 / 6 files viewed`. **Unified** and **Split** switch every diff between one column and two. The browser remembers the choice. A window narrower than 700 pixels shows unified diffs.

The file tree beside the cards lists the files in the cards' order, under their folders. A folder that holds only one folder shares its row, such as `src/rendered`. Click a file to scroll to its card, or a folder to fold it. To find a file, type part of its path in **Filter changed files**. The button at the left of the toolbar hides and shows the tree.

In a window narrower than 900 pixels, such as a narrow split or a phone, the tree hides behind the **Files** button at the left of the toolbar, which opens it over the page. `Esc` or a click beside it closes it. The cards take the window's width, and a diff line wider than its card scrolls inside the card, so the page itself never scrolls sideways. Below 700 pixels, the toolbar drops **Unified** and **Split** and shows unified diffs, the header buttons keep their icons, and the bar drops its **On this machine** chip and its keyboard button.

### File cards

Each changed file gets a card. Its header shows the file's path with a copy button, its added and removed line counts with five blocks for their share, a **Viewed** checkbox, and a **…** menu. A renamed file shows its old path before its new one, such as `docs/old.md → docs/new.md`. The chevron at the left folds the card. The header stays at the top of the window while you read its card.

A code or text file's card shows its diff the way GitHub draws one:

- Each line has its number on the base and on the branch, and the code keeps the syntax colors of GitHub's own grammars. A comment or string that runs over several lines is colored on each of them. A file with a line longer than 4 KB, such as minified code or a one-line JSON file, shows without colors, as does more than 400 KB of text, so the page still opens in time.
- A changed line paired with the line it replaced highlights the words that differ on both. When the only change is the line's ending, from LF to CRLF or back, the line with the carriage return ends in a highlighted `^M`. A file whose lines all end in CRLF shows no `^M`.
- Each hunk starts with its header, such as `@@ -28,11 +28,15 @@ program`, with the function name that Git printed for it.
- The arrow at the left of a header shows 5 more unchanged lines above the hunk, and the rest of a gap of 5 lines or fewer at once. The arrow under the last hunk shows lines below it. The header's numbers count the lines it shows after each click.

The page carries the branch's version of each file for these lines, up to 400 KB of text a file, in the review's order. It carries only the lines no hunk shows, since each hunk's lines are in its table already. A file past the limit, or past what the page has left of its 2 MiB of file text, keeps its diff, and its arrows are off, with `Open the file to see more` beside them in the hunk's header. In a narrow window, those words move under the header's text, so they stay on screen. In a partial clone, the page fetches nothing, so a file whose versions the clone lacks shows only its diff's own lines.

A diff longer than 3,000 lines or 1 MiB arrives folded, as GitHub folds one, with **Load diff** over `Large diffs are not rendered by default.`. A deleted file's diff arrives folded at any length, over `This file was deleted.`, and a deleted markdown file keeps its **Rich** view. Click **Load diff** to draw it in place. Its lines are in the page already, so it loads at once and needs no network.

The page carries at most 2 MiB of file text: the lines of every folded diff, in the review's order, and then the context for the arrows. A folded diff that doesn't fit what is left shows one line in its place. A diff past 2 MiB on its own is too large to show. A smaller one says the page has no room left for it. A deleted file's says only that the file was deleted, since the branch has no file to open.

A file with no diff to show gets one line in place of a diff, with an icon for its kind, as GitHub draws it. Its header shows no line counts, since a submodule's or an LFS pointer's lines are Git's and not the file's. In a narrow window, what follows the line after its dot, such as `renamed from docs/old.md`, moves to a line of its own. The following table lists the lines:

| Line | When it shows |
| --- | --- |
| `Binary file not shown.` | A file Git reads as binary, other than an image the page shows. |
| `Empty file added.` or `Empty file deleted.` | A new or deleted file with no content. |
| `File renamed without changes. · renamed from docs/old.md` | A file the branch moved without changing it. The header shows both paths too. |
| `File mode changed from 100644 to 100755.` | A file whose mode changed and nothing else. A mode change that comes with changes to the text shows as `100644 → 100755` in the card's header. |
| `Submodule updated from 1a2b3c4 to 5d6e7f8.` | A submodule the branch moved to another commit. A new submodule shows `Submodule added at 5d6e7f8.`, and a removed one `Submodule removed, it was at 1a2b3c4.`. |
| `Git LFS file not shown. · 2.4 MB` | A file stored with Git LFS, whose diff shows only its pointer. The size is the stored file's, as its pointer gives it. A file counts as a pointer only when the whole file is one, as the Git LFS spec writes it, so a file that starts like a pointer and goes on shows its diff. |
| `This diff is too large to show here. Open the file to see it. · 5.2 MB` | A folded diff past the page's 2 MiB of file text on its own, with its size. Its header keeps its line counts. |
| `This page has no room left for this diff. Open the file to see it. · 1.2 MB` | A folded diff that would fit in 2 MiB, after the diffs before it used up the page's file text, with its size. Its header keeps its line counts. |
| `This file was deleted.` | A deleted file whose diff the page has no room for, with no **Load diff**. Its header keeps its line counts. |
| `This file's diff couldn't be read:` | Git couldn't print the file's diff, with the reason. |

A markdown file's card has **Source** and **Rich** buttons. **Source** shows its diff. **Rich** shows the file the way GitHub draws it, with change marks: a bar beside each block the branch added or changed, a **before** chip on a changed block, and a marker where the branch removed content. For more information about the marks, see [Read the marks in a rich view](#read-the-marks-in-a-rich-view). The rich view's bar names the three marks, and its **≈ GitHub rendering** note lists where it differs from github.com. A new file's rich view says `New file. Everything below is added in this branch.`, with one green bar along the whole file. A link to another file on the branch opens that file's card in its rich view. In a changed paragraph, heading, or quote, the words the branch added are highlighted, the same way a changed line of code highlights them.

The **before** chip of a changed paragraph or heading sits at the end of its last line, and one on a code block or a picture sits in its top right corner. Click it to show the block as it was, under the block. A changed table is one block: one bar beside it, added rows tinted green, changed rows tinted amber, and one **before** chip under it that shows the whole table as it was.

An image's card shows its two versions, with each one's dimensions and size, such as `600 × 240 · 16 KB → 600 × 240 · 15 KB`, on a checkerboard so its transparent parts show. The following modes compare them:

- **2-up** shows the base's version and the branch's side by side.
- **Swipe** lays the branch's version over the base's. Drag the handle, or focus it and press the Left or Right arrow, to move the line between them.
- **Onion skin** fades the branch's version over the base's. The slider sets how much of it shows.

A new image shows alone, and a deleted one shows its base version dimmed. An SVG's card has **Source** and **Rich** buttons too: **Rich** compares its versions as pictures, the same way GitHub shows an SVG, so a script in it never runs. The page includes images up to 8 MiB each and 32 MiB for the page, in the review's order, counting the images in rich views as well as the images' own cards. A version past the limit shows a card in its place, and so does an image in a rich view, as `image not inlined · page limit`. While an image's versions are still being prepared, its header shows no line counts.

### Viewed and the card menu

To mark a file viewed, check **Viewed** in its header, or press `v` while its card is the current one. A viewed card folds, its name dims in the tree with a check, and the toolbar's ring counts it. The browser keeps the marks for this review, under a name made from the repo's path and its refs, so they survive a reload and the page of the next edit. A mark made before the file changed clears, whether its diff changed or, for an image, a binary file, or a mode change, its contents or its mode did. The marks stay in your browser.

The **…** menu in a card's header has the following items:

- **Copy file path** copies the path to the clipboard.
- **Show in file tree** selects the file in the tree, and shows the tree when it's hidden.
- **Mark as viewed**, or **Mark as not viewed** on a viewed file.
- **Collapse all files** and **Expand all files** fold or unfold every card.

### Keys on the review page

The page has keys of its own, which work in the split after you click into it. The following table lists them:

| Key | Action |
| --- | --- |
| `j` | Scroll to the next file's card |
| `k` | Scroll to the previous file's card |
| `v` | Mark the current file as viewed, and move to the next one. Press it again on a viewed file to unmark it. |
| `?` | Show the keys. The keyboard button in the bar does the same. |
| `Esc` | Close the keys, a menu, or the file list |

The current file is the card under the toolbar, and the tree marks it as you scroll.

The three buttons at the right of the bar set the theme: your system's, light, or dark. The browser remembers it and applies it before the page first paints. With scripts turned off in the browser, the page shows its unified diffs, and the controls that need the script stay hidden.

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
| `r` | Open the branch's page in the split or your browser, at this file's card |

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

## Export the page

To write the review page for the whole branch to a directory, pass `--export-html` with the directory:

```sh
branch-review --export-html ../pages
```

`branch-review` builds the same review that the UI shows, writes the page as `index.html`, prints a summary, and exits. The page is the one that `R` opens, with a card for every changed file, as the preceding sections describe, and it has all the time it needs: every card has its syntax colors and its rich view. The directory also gets `links.json`, which lists every link in the rich views. For more information about `links.json`, see [Use the JSON reports](#use-the-json-reports). It doesn't open the UI or a browser, and it doesn't watch for changes. A relative directory resolves from where you run the command, and `branch-review` creates the directory when it doesn't exist. Pick a directory outside the repo: a page written inside it shows up as an untracked file in the next review.

The summary names the files it wrote, then lists each changed file with its status letter, its card on the page, and what changed:

```
Wrote ../pages/index.html and ../pages/links.json for 3 files · nothing left this machine
  M docs/setup.md   #file-0  3 changed · 1 removed
  A docs/flow.md    #file-1  new file
  M src/cli.ts      #file-2  +12 −3
```

A markdown file's line says how many blocks its rich view marks, and one whose changes left nothing to mark, such as a new link definition, reads `no blocks marked`. A code file's line gives its added and removed lines, an image's line gives its sizes, and a file with no diff to show gives the line its card shows, such as `Binary file not shown.`. A file that also looks different is listed after the changed files, with a `·` for its status. A file that Git was too slow to check in full, even when made a second time, adds `git was slow · some links and images unchecked`.

Open `index.html` in a browser. `#file-2` at the end of its address opens it at that card. A run on the same branch writes the same two file names and replaces them. It replaces only an `index.html` and a `links.json` that `branch-review` wrote before, and refuses to write over any other file, such as a site's own `index.html`: the export then stops with nothing written and says which file is in the way.

`--export-html` takes the same refs as the UI. For example, `branch-review my-feature main --export-html ../pages` writes the page of `my-feature`'s commits against `main`.

## Read the marks in a rich view

A rich view shows the file the way GitHub's file view draws it, with GitHub's stylesheet, in the page's theme. Changes are marked by block. A block is a paragraph, a heading, a code block, a list item, or a table row:

- A green bar in the margin marks a block that the branch added. A table row's bar sits in the same margin, as tall as the row.
- An amber bar marks a block that the branch changed. A paragraph that was only rewrapped counts as changed. The **before** chip on a changed block shows the whole block as it was on the base. In a list item, the chip follows the item's text and stays there when you open it.
- A dashed red marker, such as `− 1 paragraph removed · show`, sits where the branch removed content. Click it to see the removed text on a red tint.

When the branch rewrote a stretch of the file, each new block is matched with the old block it replaced, by kind and wording. A matched block is marked changed. A new block with no match is marked added, and an old block with no match gets a removed marker. Blocks match only when their wording is close, so a new paragraph never shows as an edit of unrelated old text. A block of images matches by the images it shows. A block whose text is the same on both sides, such as a heading that Git's diff lists as removed and added again around a rewritten section, carries no mark.

A block that the diff didn't touch carries no mark. Changes in blank lines alone carry no mark either, and neither does text that shows as nothing, such as a link definition or an HTML comment. A block whose text changed but renders the same also carries no mark, such as a list item renumbered by an item added above it, or a line that lost a trailing space.

A table is marked by its rows. A changed row is matched with the old row that has the same first cell, so a row added under an edited one is marked added. A change to a column's alignment marks the header row.

A deleted file's rich view shows the base version under `Deleted file. Shown as it was on the base branch.`, with its images dimmed and its text at full contrast. An untracked file's says `Untracked file. Everything below is new, and not part of a push yet.`, and a renamed file's names its old path.

A file that can't be shown as a rich view gets a card in its place:

- An empty file shows `this file is empty`.
- A file over 2 MiB shows `too large to show` with its size, followed by the start of its text.
- A file that isn't UTF-8 text shows `not UTF-8 text`.
- A file whose rich view fails shows `couldn't show this file` with the reason, followed by its text. A file whose rich view takes more than 5 seconds to make shows `took too long to prepare` as the reason, and the other cards are still made.
- A file whose diff couldn't be read gets the same card, with the reason the review gives. A file whose terminal diff failed still gets its rich view, since the rich view needs only the diff.
- A working tree file that changes after `branch-review` reads its diff gets the same card, with the reason `doesn't match the diff`, so no mark lands on the wrong text. Run the command again to show the new text.

## Pages that also look different

A markdown file that the branch didn't change can still look different on GitHub, when it shows an image that the branch changed. `branch-review` searches the branch for markdown files that name a changed image's file name, or the name a moved image had before, for 2 seconds at most, and reads up to 40 of them. In the review, they count toward the 40 files that are drawn in the background, after the review's own files, so a review with 40 such files or more searches for none. A file that shows a changed image gets a card on the review page, after the changed files, under **Also looks different**, and a row under the same name in the file tree. The card opens on the file's rich view, which says `Not changed on this branch. It shows docs/hero.png, which this branch changed.`, and the block that shows the image carries a bar and a **before** chip, the way any changed block does. It has no **Viewed** box, and the files count and the viewed ring leave it out. In the summary of `--export-html`, its line reads `text unchanged · embeds docs/hero.png`. A file that only names the image in its text gets no card.

## Find what won't resolve on GitHub

Each rich view checks its links and images against what GitHub would find. A link that won't resolve gets a red wavy underline, and a tooltip names the reason. A link to a heading in another file of the review is checked against that file's headings. A link to a heading in a markdown file the review didn't change is checked against the headings of that file as Git holds it on the branch. A link to `#top` opens a file at its top, and a heading named in other capitals, such as `#Install` for `## Install`, counts as found. The following table lists the reasons:

| Reason | What it means |
| --- | --- |
| `anchor not found` | No heading or anchor in the file has that name. |
| `file not found` | No file or folder has that path on the branch. |
| `file is untracked` | The file is in the working tree, and Git doesn't track it. |
| `ignored by git` | The ignore rules hide the file. |
| `case mismatch: Docs/Setup.md vs docs/setup.md` | The file exists with other capitals. macOS finds it, and GitHub doesn't. |

A link to a file that Git tracks and the review has no card for keeps its dotted underline. An image that won't render on GitHub keeps its red card, described in [Images on a page](#images-on-a-page).

A rich view's link checks get 3 seconds, as its images do. A link that names no file on the branch is found missing at once. Git has to say whether such a file is untracked or ignored, and whether a heading in another file is there. A link that Git hasn't answered for by then keeps its first answer. One that has no answer at all is plain text with the tooltip `not checked in time`, and it isn't counted. The page is made again after Git answers. `--export-html` makes such a rich view once more.

A list at the top of **Files changed**, such as `Won't render on GitHub · 2 broken links`, names each finding's file and line, and a click on one scrolls to its file's card. Its **×** hides it until the page loads again. A deleted file and a file that also looks different aren't checked, and neither is the old text in a **before** view or a removed marker. Their links keep a dotted underline.

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

The **≈ GitHub rendering** note at the top of a rich view lists what differs in that file, with a count. A rich view can differ from github.com in the following ways:

- A Mermaid diagram, a math block, a map, or a 3D model shows as its source with a tag, such as `diagram · GitHub draws this`. Inline math stays as text.
- A remote image, such as a badge, shows as a dashed card with its alt text and host, such as `build passing · img.shields.io · not loaded (offline)`. An image marked `#gh-dark-mode-only` or `#gh-light-mode-only` shows its card only in that theme, and a pair of them counts once.
- A link to a file that isn't part of the review is inert, with a dotted underline. A link to another file of the review opens that file's card in its rich view, and a link to a heading scrolls to it. A link that won't resolve on GitHub is drawn broken, as described in [Find what won't resolve on GitHub](#find-what-wont-resolve-on-github).
- Code colors come from the same grammars as GitHub's and can drift between versions.

## What a page can reach

Nothing on a page leaves your machine. A page is one self-contained file, and its content security policy blocks every request: no remote image, font, or stylesheet loads, and the page can't fetch anything or submit a form. The policy lets only the page's own stylesheet and its own two scripts apply, each allowed by its hash. The scripts read the page, the data it carries, and the hash of its URL. It puts the repo's text on screen as plain text, never as markup.

Repo content can't run on a page. HTML in a markdown file passes GitHub's sanitizer model, which removes scripts, event handlers, styles, forms, frames, and `javascript:` links, and prefixes ids with `user-content-`. Repo HTML can't add a change bar or forge any other mark. A repo link whose `#` part reads like the page's own hash, such as `#file-2&l=1`, shows as an inert link, so repo text can't fake a live refresh or move the page.

`branch-review` reads the files' text and images from Git or from the working tree, the same way the review does. The page that `r` and `R` open goes in the session's temp directory. `--export-html` writes only to the directory you pass it.

To open a page, `branch-review` runs cmux, `/usr/bin/open` on macOS, or `xdg-open` on Linux, each by its full path. Each one gets the page's file URL, whose name is a hash. cmux also gets the workspace and the split it named. No repo text reaches any of them.

## Use the JSON reports

To print the report as JSON in place of the summary, add `--json`:

```sh
branch-review --export-html ../pages --json
```

The report has the following fields:

| Field | Value |
| --- | --- |
| `version` | `2` |
| `base`, `branch` | The refs, as the UI names them, such as `HEAD + worktree` |
| `dir` | The directory's absolute path |
| `page` | `index.html`, or `null` when no file changed and nothing was written |
| `files` | One entry per changed file, in the page's order |
| `also` | One entry per file that also looks different |
| `findings` | Each link and image that won't resolve on GitHub |

Each entry in `files` and `also` has the following fields:

| Field | Value |
| --- | --- |
| `path` | The file's path relative to the repo root |
| `status` | `modified`, `added`, `deleted`, `renamed`, or `untracked` |
| `oldPath` | Where a renamed file was |
| `card` | The file's card on the page, such as `index.html#file-2` |
| `kind` | `markdown`, `raster` for an image, `svg`, or `text` for every other file |
| `additions`, `deletions` | The file's added and removed lines |
| `note` | On a file with no diff to show, the line its card shows, such as `Binary file not shown.` |
| `state` | On a markdown file, an image, or an SVG, what its rich view or sides show: `markdown`, `image`, `empty`, `tooLarge`, `notUtf8`, or `failed` |
| `changes` | On a markdown file, `changed`, the number of blocks marked added or changed, and `removed`, the number of removed markers |
| `differences` | On a markdown file, each way its rich view differs from github.com, as `kind` and `count`. The kinds are `mermaid`, `math`, `diagram`, `remoteImage`, and `outsideLink`. |
| `image` | On an image or an SVG, `before` and `after`, each with `bytes`, `width`, and `height` |
| `embeds` | On a file that also looks different, the changed images it shows |
| `late` | `true` when Git was slow to answer for some of the file's links and images, even when its rich view was made a second time. Those links read `unchecked`, and a file that also looks different may show its changed image unmarked. |
| `reason` | Why the rich view failed, when `state` is `failed` |

Each entry in `findings` has the following fields:

| Field | Value |
| --- | --- |
| `path`, `line` | The file and the line the link or image is on |
| `target` | The link or image path as the file writes it |
| `what` | `link` or `image` |
| `kind` | `badAnchor`, `missing`, `untracked`, `ignored`, or `caseMismatch` for a link, and the reason an image card gives for an image, such as `caseMismatch` or `lfs` |
| `reason` | The reason in words, as the page says it |

`links.json` in the directory has `version`, `base`, `branch`, the same `findings`, and `links`, every link in the review's rich views. Each link has its `path`, `line`, the `href` as written, and a `status`: `ok`, `outside` for a file Git tracks that the review has no card for, `unchecked` for a link Git didn't answer for in time, or one of the link kinds in the preceding table.

Hidden characters in paths and ref names, such as control characters and bidi overrides, are written as `\u` escapes, so the reports print as plain text and decode to the real names.

When no file changed, the summary reads `nothing to export · no files changed on this branch`, the JSON report has `page` set to `null` and empty lists, and the directory gets no files.

If the directory can't be written, `branch-review` prints a one-line reason, such as `can't write the pages to ../pages: not a directory`, and exits with status 1. `--json` without `--export-html` is an error too.
