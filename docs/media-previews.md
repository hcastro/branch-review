# Image and video previews

This document describes how `branch-review` shows changed images, SVG files, and videos in the diff pane, which terminals draw them, and how to set up tmux. For the keys that work on a preview, see the [Keys and mouse](../README.md#keys-and-mouse) section of the README.

## Images

In a terminal that draws images, added, deleted, and modified PNG, JPEG, GIF, WebP, and AVIF files show as pictures in the diff pane. Each one keeps its aspect ratio and shrinks to fit the pane when it's too large. An image is never enlarged, except an icon under 8 cells wide, which is scaled up by a whole factor of up to 8 times so its pixels stay sharp.

A phone photo shows turned the way an image viewer shows it, following its EXIF orientation. An image with transparency draws over a checkerboard, or over the pane color in a block preview.

In Kitty and in Ghostty 1.4 or later, an animated GIF or WebP plays in a loop, run by the terminal itself. Everywhere else, with `--no-animations`, or when the animation is too large, it shows its first frame and says how many frames it has. An animated PNG (APNG) file is labeled as showing its first frame.

The metrics row shows the format, pixel size, and bytes of each version, with the change in bytes colored. To swap the picture for a table of those details, press `v`.

## Compare a modified image

A modified image opens with its old and new versions side by side. You can switch modes with the keys or with the tab row above the picture:

- `1`: side by side.
- `2`: flip mode, which shows one version at a time. To swap versions, press `2` again or click the picture.
- `3`: the difference. Changed pixels are marked over a darkened copy of the new version, with the share of the image that changed.

The mode that you pick stays for the rest of the session. When half of the pane is narrower than 16 columns, the side-by-side view stacks the versions, with the old version above the new one.

The difference view ignores noise from re-encoding. A re-encode with the same pixels reports no change, and a color channel that moves by 8 levels or less doesn't count. A change in transparency alone counts. When the versions differ in size, they're aligned at the top-left corner.

## SVG files

An SVG shows its rendered picture first, with its source blocks collapsed under it. `Enter` or `Space` expands a block like any other, and a block that you expanded stays expanded through refreshes. When the SVG itself changes, its blocks collapse again.

To show the source alone, press `v`, and press it again to return to the picture. The picture view collapses only the blocks that you didn't expand yourself.

An SVG's header has **Copy path**, **Copy diff**, and **Copy file**. `o` and `O` open a PNG copy rendered from the SVG, so no script in the SVG can run.

`branch-review` draws an SVG without fetching anything it points to outside itself, and it refuses an SVG that declares an external entity. An SVG over 4 MiB is refused without drawing it.

## Video

An added, deleted, or changed MP4, M4V, MOV, or WebM file shows a table of its length, size, resolution, codec, and frame rate. For a changed video, the new version's row marks what changed: shorter or smaller in green, longer or larger in red.

Under the table, each version gets a strip of up to four frames taken evenly through it, with their times underneath. A pane narrower than 51 columns gets two frames per strip. `2` shows one version's strip at a time as two larger frames, and `2` again swaps it. `1` shows both strips again, and `3` says that the difference view works only on images.

The metadata and frames come from `ffprobe` and `ffmpeg` on your `PATH`. They're optional. Without them, a video shows its size, and the strip says what to install:

```sh
brew install ffmpeg
```

When `ffprobe` or `ffmpeg` stops responding, `branch-review` stops it, and that video shows without metadata or frames. The next video still gets its own try.

A video's header is **Copy path**, **Play**, and **Quick Look** on macOS, and **Copy path** and **Open** elsewhere. A video has no **Copy diff**.

`o` plays the video. On macOS, `o` plays an MP4 or MOV from the working tree in QuickTime as the file itself, and `O` previews any working-tree video in Quick Look as the file itself. `branch-review` checks the path again right before either one starts. Every other `o` on a working-tree video, and every open of a committed version, uses a verified read-only temp copy.

## Terminal support

At startup, `branch-review` asks the terminal what it can draw. The following table shows what each terminal gets:

| Terminal | Images |
| --- | --- |
| Ghostty, cmux, Kitty | Drawn as pictures |
| Apple Terminal, Alacritty, iTerm2, WezTerm, VS Code, Warp, Konsole, and any other terminal with 256 colors or more | A block preview |
| Inside tmux | Drawn as pictures when tmux passes graphics through to Ghostty or Kitty (`set -g allow-passthrough all`), a block preview otherwise |
| Terminals with fewer than 256 colors, or that don't answer the startup query | The usual `binary file changed` line |

WezTerm and Konsole answer the query, but they can't place images the way `branch-review` draws them, so they get the block preview.

A block preview draws the picture in colored half-block characters, two pixels to a cell and at most 60x20 cells. That resolution shows which image you're looking at and what changed, in every compare mode. `o` opens the real image, and the footer says `no image support detected` while a block preview is on screen.

Keys you press while the terminal answers the startup query reach the app. A reply that arrives late from a slow terminal can't trigger a key or quit the app.

## Use with tmux

To draw pictures inside tmux, add the following line to your tmux config:

```
set -g allow-passthrough all
```

With `allow-passthrough on`, tmux drops graphics sent while the pane is hidden behind another window. A picture redrawn by a refresh then appears as empty cells, and a quit from a hidden pane leaves its images in the terminal. With passthrough off, startup waits up to a second for an answer that never comes.

Only the first `branch-review` session in a tmux server draws images, because every pane draws on the same outer terminal. Later sessions show block previews, and their footer says that another `branch-review` draws images in this tmux server.

Inside tmux, every graphics command is wrapped for tmux's passthrough, including the startup query and the deletes at exit. `branch-review` uses pictures only when the wrapped query gets an answer back, so a tmux that blocks passthrough gets the block preview with no stray text on screen.

tmux answers terminal queries itself, and its environment describes the terminal that the tmux server started in, which might not be the one you're using. So `branch-review` asks tmux which terminal the attached client runs in, and draws pictures only when that terminal is Ghostty or Kitty. When tmux can't say, you get the block preview.

## Open a file in a viewer

A raster image's file header has an **Open** button where other files have **Copy file**, because an image's contents aren't text. `f` still reports `not UTF-8 text`.

`o` and **Open** give the viewer a private temp copy of the bytes on screen, so the viewer never touches the file in your repo. If a viewer saves over that copy, the next `o` exports a fresh one.

Opening a file needs macOS, or `xdg-open` on Linux and BSD. On other systems, `o` reports `no program to open media found`. Over SSH, `o` reports that opening isn't available, so nothing opens on the remote machine.

## Turn previews off

Previews are off in the following cases:

- With `--no-images`, or with `BRANCH_REVIEW_IMAGES` set to `off`, `none`, `0`, or `false`.
- When color is off, through `NO_COLOR`, `FORCE_COLOR`, or `TERM=dumb`.
- When the input or the output isn't a terminal.
- When `TERM` is `linux`, or `screen*` outside tmux. Those terminals might print graphics codes as text.

The app then shows media files as plain diffs. `BRANCH_REVIEW_IMAGES=kitty` forces pictures in a terminal that supports them but isn't recognized, and `BRANCH_REVIEW_IMAGES=blocks` forces the block preview. For all the environment variables, see the [Environment variables](../README.md#environment-variables) section of the README.

## How previews work

`branch-review` decodes every image in a separate background process, with [sharp](https://sharp.pixelplumbing.com/). Before it draws anything, `branch-review` checks the bytes against the object ID in Git's diff. A file that changed on disk, or that a Git filter rewrites, never shows as a stale or wrong picture. A file that can't be previewed shows the reason in its place, such as `changed on disk · refreshing`, and the next refresh tries again.

If the background process stops responding or crashes, `branch-review` stops it and starts a new one after a delay. After three failures, previews turn off for the session and the review continues. If sharp can't load at all, the app says once that previews are unavailable, and it still passes small PNG files to a terminal that can draw them.

`branch-review` refuses a hostile file before it decodes anything. It refuses the following files:

- A raster image over 16 MiB, or an SVG over 4 MiB.
- An image whose header declares more than 16,384 pixels on a side or more than 64 megapixels.
- A working-tree video over 1 GiB, or a committed video over 512 MiB.

`branch-review` runs `ffprobe` and `ffmpeg` only from `PATH` directories outside the repo, so a program checked into the repo never runs. They read the video from an open, checked file, or from a checked temp copy for a committed version. The container format is forced, and they accept only plain files as input.

Each picture goes to the terminal once. `branch-review` keeps the pictures it sent within a byte budget and deletes the least recently used ones that are off screen. The pictures in view, and the ones in the first files of the review, are decoded before the others. A refresh that leaves a picture unchanged sends nothing.

The arrival highlight and the selection color never tint a picture. At exit, `branch-review` deletes its images from the terminal, wrapped for tmux when needed, and removes its media temp directory. The next start removes directories left by a session that crashed.
