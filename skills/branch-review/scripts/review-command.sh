#!/usr/bin/env bash
# Build the branch-review command for a repo and copy it to the clipboard.
#
# Usage: review-command.sh [PATH] [BRANCH] [BASE]
#
#   PATH    File or directory inside the repo to review. Default: cwd.
#   BRANCH  Ref to review. Default: HEAD (includes uncommitted changes).
#   BASE    Ref to diff against. Default: let branch-review detect it.
#
# Prints a state report on stderr and the command on stdout. Refuses a repo
# path or ref name that holds control or invisible characters.

set -uo pipefail

target="${1:-$PWD}"
branch="${2:-HEAD}"
base="${3:-}"

# Inherited by every git call, submodule children included. Optional locks off
# keeps a submodule status check from rewriting the submodule's index, and a
# git that needs credentials (a partial clone fetching a missing object) fails
# instead of prompting.
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0

# Escapes the characters a terminal acts on or hides: C0 controls (newline
# and tab included), DEL, C1 controls, bidi controls and invisible format
# characters. They come out as \xHH, \uHHHH or \UHHHHHHHH, the way bash's
# $'...' writes them; everything else, invalid UTF-8 included, is unchanged.
# Works on bytes, so it behaves the same in any locale and in bash 3.2.
escape_hidden() {
  local LC_ALL=C s=$1 out= i=0 len k b cp
  # Every escaped character starts with one of these bytes.
  if [[ $s != *[$'\x01'-$'\x1f'$'\x7f'$'\xc2'$'\xd8'$'\xe2'$'\xef'$'\xf3']* ]]; then
    printf '%s' "$s"
    return
  fi
  while (( i < ${#s} )); do
    case ${s:i:4} in
      [$'\x01'-$'\x1f'$'\x7f']*) len=1 ;;
      # U+0080-009F, U+00AD, U+061C
      $'\xc2'[$'\x80'-$'\x9f'$'\xad']* | $'\xd8\x9c'*) len=2 ;;
      # U+200B-200F, U+2028-202E, U+2060-2064, U+2066-2069, U+FEFF
      $'\xe2\x80'[$'\x8b'-$'\x8f'$'\xa8'-$'\xae']* \
        | $'\xe2\x81'[$'\xa0'-$'\xa4'$'\xa6'-$'\xa9']* \
        | $'\xef\xbb\xbf'*) len=3 ;;
      # U+E0000-E007F
      $'\xf3\xa0'[$'\x80'$'\x81'][$'\x80'-$'\xbf']*) len=4 ;;
      *) out+=${s:i:1}; i=$((i + 1)); continue ;;
    esac
    cp=0
    for ((k = 0; k < len; k++)); do
      # bash 3.2 reads bytes above 0x7f as negative.
      printf -v b '%d' "'${s:i+k:1}"
      b=$(((b + 256) % 256))
      if ((k == 0)); then
        cp=$((len == 1 ? b : b & (0xff >> (len + 1))))
      else
        cp=$(((cp << 6) | (b & 0x3f)))
      fi
    done
    if ((len == 1)); then
      printf -v b '\\x%02x' "$cp"
    elif ((cp <= 0xffff)); then
      printf -v b '\\u%04x' "$cp"
    else
      printf -v b '\\U%08x' "$cp"
    fi
    out+=$b
    i=$((i + len))
  done
  printf '%s' "$out"
}

die() { printf 'error: %s\n' "$(escape_hidden "$1")" >&2; exit 1; }
note() { printf '%s\n' "$(escape_hidden "$1")" >&2; }

# The pasted command can't carry these safely: the terminal would act on them
# or hide them (ESC[201~ ends a bracketed paste early).
refuse_hidden() {
  [[ $(escape_hidden "$2") == "$2" ]] \
    || die "$1 contains control or invisible characters: $2"
}

refuse_hidden branch "$branch"
refuse_hidden base "$base"

[[ -e $target ]] || die "path does not exist: $target"
[[ -d $target ]] || target=$(dirname "$target")

# The x keeps $(...) from stripping newlines that belong to the path.
root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null && printf x) \
  || die "not inside a git repository: $target"
root=${root%x}
root=${root%$'\n'}
refuse_hidden "repo path" "$root"

# Read-only access to the repo. fsmonitor is off so no hook or daemon runs,
# and a split index stays off so git never writes a shared index into .git.
git_root() { git -C "$root" -c core.fsmonitor=false -c core.splitIndex=false "$@"; }

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
# main shell, not in $(...), so the EXIT trap sees the directory to remove.
tmp_dir=
tmp_index=
index_error=
cleanup() { if [[ -n $tmp_dir ]]; then rm -rf "$tmp_dir"; fi; }
trap cleanup EXIT

# Returns non-zero, with index_error saying which step failed, when no private
# copy could be made.
make_private_index() {
  local index parent=${TMPDIR:-/tmp} cp_error
  index=$(git_root rev-parse --git-path index) \
    || { index_error="cannot locate the index (git rev-parse --git-path index failed)"; return 1; }
  [[ $index == /* ]] || index="$root/$index"
  # Git runs in $root, so a relative TMPDIR would point it at a missing file,
  # which reads as an empty index.
  [[ $parent == /* ]] || parent="$PWD/$parent"
  # mktemp -d makes the directory 0700, which keeps the copy private whatever
  # mode cp -p carries over from the index.
  tmp_dir=$(mktemp -d "${parent%/}/branch-review.XXXXXX" 2>/dev/null) || {
    tmp_dir=
    index_error="cannot copy the index to a temp file in ${TMPDIR:-/tmp}"
    return 1
  }
  tmp_index="$tmp_dir/index"
  # A repo with no index file yet has an empty index; a missing file reads that way.
  [[ -e $index ]] || return 0
  # -p keeps the index's mtime. Git rechecks the content of any entry modified
  # in the same second the index was written; a fresh mtime on the copy would
  # make it trust the stat data and miss that edit.
  cp_error=$(cp -p "$index" "$tmp_index" 2>&1) \
    || { index_error="cannot copy the index: ${cp_error:-cp failed}"; return 1; }
}

# Counts NUL-terminated paths on stdin. A trailing slash marks an untracked
# nested repository, which the CLI leaves out because it has no diff.
count_paths() {
  local path count=0
  while IFS= read -r -d '' path; do
    [[ -n $path && $path != */ ]] && count=$((count + 1))
  done
  printf '%s' "$count"
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
  # The CLI diffs base...branch, which needs a merge base.
  git_root merge-base "$resolved_base" "$resolved_branch" >/dev/null \
    || die "no merge base for $resolved_base and $resolved_branch"
  diff_arg="$resolved_base...$resolved_branch"
  includes_worktree=no
fi

# --- state report -----------------------------------------------------------

current_branch=$(git_root branch --show-current 2>/dev/null)
untracked=0
# A git failure makes a count unknown, never 0: pipefail gives each count the
# status of the git call feeding it.
tracked_error=
# -M counts a rename as one file, as the CLI lists it, whatever diff.renames says.
if [[ $includes_worktree == yes ]]; then
  if make_private_index; then
    tracked=$(GIT_INDEX_FILE=$tmp_index git_root diff --no-ext-diff -M --name-only -z "$diff_arg" | count_paths) \
      || tracked_error="git diff failed"
  else
    tracked_error=$index_error
  fi
  untracked=$(git_root ls-files -z --others --exclude-standard | count_paths) || untracked=unknown
  if porcelain=$(git_root --no-optional-locks status --porcelain); then
    uncommitted="$(printf '%s' "$porcelain" | grep -c . || true) entries"
  else
    uncommitted="unknown (git status failed)"
  fi
  reviewed_tip=HEAD
else
  tracked=$(git_root diff --no-ext-diff -M --name-only -z "$diff_arg" | count_paths) \
    || tracked_error="git diff failed"
  uncommitted="not in this review (reviewing $branch, not the worktree)"
  reviewed_tip=$resolved_branch
fi
[[ -z $tracked_error ]] || tracked=unknown
if [[ $tracked != unknown && $untracked != unknown ]]; then
  changed=$((tracked + untracked))
  in_review="$changed files ($tracked tracked, $untracked untracked)"
else
  [[ $tracked == unknown ]] && tracked_part="tracked count unknown" || tracked_part="$tracked tracked"
  [[ $untracked == unknown ]] && untracked_part="untracked count unknown" || untracked_part="$untracked untracked"
  in_review="unknown ($tracked_part, $untracked_part)"
fi
ahead=$(git_root rev-list --count "$resolved_base..$reviewed_tip" 2>/dev/null) \
  && ahead="$ahead ahead of base" \
  || ahead="unknown (git rev-list failed)"

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
note "commits:     $ahead"
note "uncommitted: $uncommitted"
note "in review:   $in_review"

command -v branch-review >/dev/null 2>&1 \
  || note "warning: branch-review is not on PATH — install with: pnpm add -g --allow-build=branch-review github:hcastro/branch-review"
command -v delta >/dev/null 2>&1 \
  || note "warning: git-delta is not on PATH — diffs need it: brew install git-delta"
[[ -n $tracked_error ]] \
  && note "warning: $tracked_error, so the tracked count is unknown"
[[ -n ${changed:-} && $changed -eq 0 ]] \
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
