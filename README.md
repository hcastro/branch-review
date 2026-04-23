# branch-review-cli

An interactive terminal UI for reviewing a git branch's diff against a base ref. Built with [Ink](https://github.com/vadimdemedes/ink) and rendered through [git-delta](https://github.com/dandavison/delta) for syntax-highlighted hunks.

- Two-pane layout: a file tree on the left, a scrollable diff on the right.
- Mouse and keyboard navigation — click a file to jump, or arrow through sections.
- Branch-level and per-file stats (+/- and total changed lines).
- Works with any base ref — local or `origin/*`.

## Requirements

- **Node.js** ≥ 20
- **git** on your `PATH`
- **[git-delta](https://github.com/dandavison/delta)** on your `PATH` (the diff pane shells out to `delta` for syntax highlighting)

```sh
# macOS
brew install git-delta
```

## Install

### Global (recommended)

```sh
pnpm add -g @hcastro/branch-review-cli
```

This exposes two equivalent binaries: `branch-review` and `branch_review`.

### One-off with `pnpm dlx`

```sh
pnpm dlx @hcastro/branch-review-cli
```

### Directly from GitHub

```sh
pnpm add -g github:hcastro/branch-review-cli
```

## Usage

Run inside any git repository:

```sh
branch-review                      # HEAD vs the detected base branch
branch-review my-feature           # my-feature vs the detected base branch
branch-review my-feature main      # my-feature vs main
```

When you do not pass a base ref, the CLI uses `origin/HEAD` when available, then falls back to common base branch names such as `development`, `main`, `master`, and `trunk`.

Both refs are resolved against local branches first, then `origin/<ref>`, so you can point at remote-only branches without checking them out.

### Keybindings

| Key                  | Action                              |
| -------------------- | ----------------------------------- |
| `↑` / `↓`            | Jump to previous / next file        |
| `j` / `k`            | Scroll diff down / up by one line   |
| `PgDn` / `PgUp`      | Page down / up                      |
| `g` / `G`            | Jump to top / bottom                |
| *click on a file*    | Jump diff to that file              |
| *trackpad scroll*    | Scroll the diff pane                |
| `q` / `Esc`          | Quit                                |

## Development

```sh
pnpm install
pnpm dev           # run from source with tsx
pnpm build         # bundle to dist/ with tsup
pnpm test          # vitest
```

To try a local build as a global command:

```sh
pnpm build
pnpm link --global
branch-review
```

## How it works

- `git diff --name-only <base>...<branch>` drives the file list.
- `git diff --numstat` drives the per-file and branch-wide metrics.
- For each file, `git diff --color=always <base>...<branch> -- <file>` is piped through `delta` to produce the highlighted hunk the TUI renders.

## License

MIT © hcastro
