---
name: animate-terminal-flow
description: Turns a running terminal app (a TUI or a CLI) into a motion video built from its real screens. Records the app in a pseudo-terminal that answers like Ghostty, so Kitty images and previews draw. Replays the recording as a crisp DOM cell grid and animates camera moves over the real frames in a HyperFrames composition. Use when someone asks for a demo, launch, promo or explainer video of a terminal app, CLI or TUI, wants fluid close-up shots of a terminal UI in action, or needs the terminal counterpart of animate-web-flow.
---

# Animate a terminal flow

A run produces a HyperFrames project whose terminal shots are the app's own output, replayed cell by cell. The camera pushes, pans and punches in on live text, so reads stay sharp at any scale.

**Never run the app attached to a real terminal from a tool call.** It takes over the screen and hangs the call. Always run it inside `scripts/record-tui.py`.

## Guardrails

- **Fake the outside world.** Put stand-in `pbcopy`, `open` and `xdg-open` first on `PATH`, logging to a file, so the real clipboard and browser are never touched. An app that calls `/usr/bin/open` by absolute path can't be stubbed: leave out the keys that open things, and show that result another way.
- **Use a demo repo or data set built by a script.** Rebuild it before every take, because live edits change it. Give every invented name a generic label, with no real companies or brands.
- **Keep frames on the machine.** Pass `--describe false` to `hyperframes snapshot`. Nothing gets published without the person's go-ahead.
- **Delete only what you created,** by exact path. Kill only pids the recorder printed.

## Workflow

Copy this checklist and work through it:

```
Terminal flow video:
- [ ] 1. Plan the shots and the takes
- [ ] 2. Build the demo data
- [ ] 3. Record each take
- [ ] 4. Convert and check the contact sheets
- [ ] 5. Compose in HyperFrames
- [ ] 6. Review and render
```

### 1. Plan the shots and the takes

Write the story first (the `hyperframes` skill: `references/story.md`, `references/spec.md`). Then list the takes. A take is one recording, and each shot that must cut cleanly into the next one gets its own take, starting on the frame the previous shot ends on. One long take that wanders through other states between two shots makes a jump at the seam.

### 2. Build the demo data

Write a script that builds the repo or data from scratch. Plant the one detail the story turns on (a bug, a number) on a line that's on screen when the view opens.

### 3. Record each take

Write a steps file, then run:

```bash
python3 scripts/record-tui.py --cols 120 --rows 34 --cwd REPO --steps take.json \
  --out take.cast --env KEY=VALUE -- your-app args
```

- Steps: `wait`, `send` (with `delay` per character), `key` (`times`, `interval`), `waitFor` (a regex on the output, with `timeout`), `sh` (a live edit), `mark`, `mouse`, `resize`. Run `python3 scripts/record-tui.py --help` for every field.
- Use 120 x 34. At 100 x 30, long lines wrap.
- `--terminal ghostty` (the default) answers the Kitty graphics, cell-size and color queries, so the app draws real images. `--terminal xterm` tests the fallback.
- A `waitFor` timeout exits 2 with the last output. Fix the steps and record again.
- To record a shell typing the command, run `bash --norc --noprofile -i` with `--env "PS1=demo % "`.

### 4. Convert and check

```bash
node scripts/cast-to-frames.mjs take.cast --out take/frames --png --cell 9x19 --font-size 15
```

Read `take/frames/contact-sheet.png` and every marker PNG before composing. Look for wrong colors, images out of place and garbage cells, and fix the take, not the composition.

Install the converter's dependencies once with `npm install` in this skill's folder. `node scripts/selftest.mjs` checks the whole pipeline. Run it after changing any script.

### 5. Compose

Copy each `frames/` folder into the project's `assets/captures/<take>/`. Then load these in the root `index.html` `<head>`: `scripts/render-grid.js`, each take's `capture.js`, and `assets/stage.js` from this skill. Rename each `capture.js` global first, because every take sets `window.TERMINAL_CAPTURE`:

```bash
sed "s/^window\.TERMINAL_CAPTURE = /window.CAPTURES = window.CAPTURES || {}; window.CAPTURES['TAKE'] = /" \
  take/frames/capture.js > assets/captures/TAKE/capture.js
```

The rules that keep it deterministic and sharp:

- **Mount at the read size.** `Stage.grid(el, 'TAKE')` uses 18 x 38 px cells at JetBrains Mono 30 px, so a line is 3.5% of 1080. Wide shots scale the wrapper down. Punch-ins go up to about 1.4 times.
- **One driver per grid.** `Stage.drive(tl, grid, [[sceneT, captureT], ...], sceneDuration)` maps scene time to capture time over the whole scene. A separate seek tween per beat renders on creation and shows a later frame early.
- **Find positions from the capture.** `Stage.find('TAKE', t, /status >= 400/)` returns the row and column of on-screen text at time t. Build marks and camera poses from it, never from a guess.
- **Camera on a wrapper.** Tween one pose object (`x`, `y`, `scale`, `blur`) and write the transform in `onUpdate`. `Stage.at(rect, scale, cx, cy)` and `Stage.fit(rect, box)` give poses for a cell rectangle.
- **Preload images.** Put a hidden `<img>` for every file in each take's `images/` in the root, so a seek never shows an image still decoding.
- **Recoloring is partial.** A theme changes the 16 palette colors only. Truecolor output, such as delta's syntax colors, stays as recorded.

### 6. Review and render

Follow the `hyperframes` skill's review: `npx hyperframes check`, then `snapshot --review --describe false`. Read the seam strips, and fix any jump at a cut with a new take. Then `npx hyperframes render -q delivery`.

## Gotchas

- **Scene CSS is scoped.** A selector that starts with `html[...]` inside a scene's `<template>` never matches. Put look or theme rules in the root `index.html` with `!important`.
- **`snapshot -o DIR` clears DIR.** Give each run its own folder.
- **Apps that animate on arrival**, such as a highlight that fades after a live edit, are captured frame by frame. Play that stretch at real speed.

## Scripts

| File | Runs in | What it does |
|---|---|---|
| `scripts/record-tui.py` | Python 3 stdlib | Records a pty session to asciicast v2 with markers, and answers terminal queries |
| `scripts/cast-to-frames.mjs` | Node | Replays the cast into `frames.json`, `images.json`, `capture.js`, PNGs and a contact sheet |
| `scripts/render-grid.js` | browser | Draws a frame as DOM on an exact cell grid (`TerminalGrid.mount`, `seek`) |
| `scripts/kitty-diacritics.mjs` | Node | The Kitty placeholder diacritics table |
| `scripts/selftest.mjs` | Node | Records a small test app and checks every step |
| `assets/stage.js` | browser | Composition helpers: `grid`, `drive`, `find`, `fit`, `at`, marks, titles, key caps |
