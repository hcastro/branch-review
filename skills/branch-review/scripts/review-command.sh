#!/usr/bin/env bash
# Build the branch-review command for a repo and copy it to the clipboard.
#
# Usage: review-command.sh [PATH] [BRANCH] [BASE]
#
#   PATH    File or directory inside the repo to review. Default: cwd.
#   BRANCH  Ref to review. Default: HEAD (includes uncommitted changes).
#   BASE    Ref to diff against. Default: let branch-review detect it.
#
# Prints a state report on stderr and the command on stdout.

set -uo pipefail

target="${1:-$PWD}"
branch="${2:-HEAD}"
base="${3:-}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1" >&2; }

[[ -e $target ]] || die "path does not exist: $target"
[[ -d $target ]] || target=$(dirname "$target")

root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null) \
  || die "not inside a git repository: $target"

# Read-only access to the repo. fsmonitor is off so no hook or daemon runs.
git_root() { git -C "$root" -c core.fsmonitor=false "$@"; }

# Resolve a ref the way the CLI does: local ref first, then origin/<ref>.
resolve_ref() {
  local ref=$1
  if git_root rev-parse --verify --quiet "$ref" >/dev/null; then
    printf '%s' "$ref"
  elif git_root rev-parse --verify --quiet "origin/$ref" >/dev/null; then
    printf 'origin/%s' "$ref"
  fi
}

# Mirrors inferBaseRef in src/git.ts. Reported for the summary only — when the
# caller does not pass BASE, the command omits it so the CLI detects its own.
infer_base() {
  local origin_head candidate resolved current
  origin_head=$(git_root symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [[ -n $origin_head ]] && git_root rev-parse --verify --quiet "$origin_head" >/dev/null; then
    printf '%s' "$origin_head"; return
  fi
  for candidate in development main master trunk; do
    resolved=$(resolve_ref "$candidate")
    [[ -n $resolved ]] && { printf '%s' "$resolved"; return; }
  done
  current=$(git_root branch --show-current 2>/dev/null)
  [[ -n $current ]] && resolve_ref "$current"
}

# Sets clip_tool to the tool that took the text. xclip and wl-copy leave a
# child running that would hold an inherited stdout or stderr open, so the
# tools get neither.
clip_tool=
copy_to_clipboard() {
  local text=$1 tool
  for tool in pbcopy wl-copy xclip clip.exe; do
    command -v "$tool" >/dev/null 2>&1 || continue
    case $tool in
      xclip) printf '%s' "$text" | xclip -selection clipboard >/dev/null 2>&1 ;;
      *)     printf '%s' "$text" | "$tool" >/dev/null 2>&1 ;;
    esac && { clip_tool=$tool; return 0; }
  done
  return 1
}

# Single-quote a word for any POSIX shell. The replacement lives in a variable
# because bash 3.2 (macOS /bin/bash) keeps the backslashes of an inline one.
shell_quote() {
  local q="'\\''"
  printf "'%s'" "${1//\'/$q}"
}

# Worktree diffs refresh stat info in the index they read. They run against a
# private copy so the repo's own index is never rewritten. Call this in the
# main shell, not in $(...), so the EXIT trap sees the file to remove.
tmp_index=
cleanup() { if [[ -n $tmp_index ]]; then rm -f "$tmp_index" "$tmp_index.lock"; fi; }
trap cleanup EXIT

make_private_index() {
  local index
  index=$(git_root rev-parse --git-path index) || die "cannot locate the index in $root"
  [[ $index == /* ]] || index="$root/$index"
  tmp_index=$(mktemp "${TMPDIR:-/tmp}/branch-review-index.XXXXXX") \
    || die "cannot create a temporary index"
  # A repo with no index file yet has an empty index; a missing file reads that way.
  cp "$index" "$tmp_index" 2>/dev/null || rm -f "$tmp_index"
}

effective_base=${base:-$(infer_base)}
[[ -n $effective_base ]] \
  || die "could not infer a base ref in $root — pass BASE explicitly"

resolved_base=$(resolve_ref "$effective_base")
[[ -n $resolved_base ]] || die "base ref not found: $effective_base"

if [[ $branch == HEAD ]]; then
  diff_arg=$(git_root merge-base "$resolved_base" HEAD) || die "no merge base for $resolved_base and HEAD"
  includes_worktree=yes
else
  resolved_branch=$(resolve_ref "$branch")
  [[ -n $resolved_branch ]] || die "branch ref not found: $branch"
  diff_arg="$resolved_base...$resolved_branch"
  includes_worktree=no
fi

# --- state report -----------------------------------------------------------

current_branch=$(git_root branch --show-current 2>/dev/null)
untracked=0
if [[ $includes_worktree == yes ]]; then
  make_private_index
  tracked=$(GIT_INDEX_FILE=$tmp_index git_root diff --no-ext-diff --name-only "$diff_arg" | grep -c . || true)
  untracked=$(git_root ls-files --others --exclude-standard | grep -c . || true)
  dirty=$(git_root --no-optional-locks status --porcelain | grep -c . || true)
  uncommitted="$dirty entries"
  reviewed_tip=HEAD
else
  tracked=$(git_root diff --no-ext-diff --name-only "$diff_arg" | grep -c . || true)
  uncommitted="not in this review (reviewing $branch, not the worktree)"
  reviewed_tip=$resolved_branch
fi
changed=$((tracked + untracked))
ahead=$(git_root rev-list --count "$resolved_base..$reviewed_tip" 2>/dev/null || echo 0)

# A linked worktree has its own git dir inside the main repo's common dir. A
# submodule or --separate-git-dir checkout also has a .git file, but its git
# dir is its own common dir.
abs_dir() { (unset CDPATH; cd "$root" && cd "$1" && pwd -P); }
is_worktree=no
git_dir=$(git_root rev-parse --git-dir 2>/dev/null) \
  && common_dir=$(git_root rev-parse --git-common-dir 2>/dev/null) \
  && [[ $(abs_dir "$git_dir") != "$(abs_dir "$common_dir")" ]] \
  && is_worktree=yes

note "repo:        $root"
note "worktree:    $is_worktree"
note "branch:      ${current_branch:-<detached>}  (reviewing: $branch)"
note "base:        $resolved_base$([[ -z $base ]] && printf ' (auto-detected)')"
note "commits:     $ahead ahead of base"
note "uncommitted: $uncommitted"
note "in review:   $changed files ($tracked tracked, $untracked untracked)"

command -v branch-review >/dev/null 2>&1 \
  || note "warning: branch-review is not on PATH — install with: pnpm add -g --allow-build=branch-review github:hcastro/branch-review"
command -v delta >/dev/null 2>&1 \
  || note "warning: git-delta is not on PATH — diffs need it: brew install git-delta"
[[ $changed -eq 0 ]] \
  && note "warning: no changes in this range — the CLI will report nothing to review"

# --- command ----------------------------------------------------------------

# Every word is quoted: ref names may hold ;, &, |, $(), backticks and quotes.
cmd="cd $(shell_quote "$root") && branch-review"
if [[ -n $base ]]; then
  cmd+=" $(shell_quote "$branch") $(shell_quote "$base")"
elif [[ $branch != HEAD ]]; then
  cmd+=" $(shell_quote "$branch")"
fi

if copy_to_clipboard "$cmd"; then
  note "copied to clipboard via $clip_tool"
else
  note "warning: no clipboard tool found (pbcopy/wl-copy/xclip/clip.exe) — copy manually"
fi

printf '%s\n' "$cmd"
