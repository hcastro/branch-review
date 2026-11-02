# Guide

This guide walks through installing widget, watching a queue and previewing a job.

## Install

```sh
npm install -g widget
```

widget needs Node 20 or later.

## Watch the queue

Run `widget watch` in any repo that has a `.widget.toml`. The dashboard lists every job with its status and how long it has been running.

> [!NOTE]
> The queue refreshes every 2 seconds. Pass `--interval 5` to slow it down.

## Preview a job

1. Pick a job with the arrow keys.
2. Press `p` to open its output in a side panel.
3. Press `f` to follow new output, and `Esc` to close the panel.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between jobs |
| `p` | Preview the selected job |
| `f` | Follow new output |
| `q` | Quit |
