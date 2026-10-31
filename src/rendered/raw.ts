import type {FileStatus} from '../git.js';
import type {ChangeGroup} from './changes.js';

// The page's first frame is the text the reader just saw in the diff: the
// file's source with its added lines tinted and its removed lines back in
// place, as delta draws them. The page carries the whole file this way, so
// whichever line a trip opens at, the frame can be cut around it.

/**
 * The file's lines as the diff reads them, `\n`-joined, and one tint a
 * line: `+` added, `-` removed (base text, back where it was), `x` removed
 * but the page's own (a deleted file's page is its base text), ` ` neither.
 * Lines that aren't `-` are the file's own, in order, so the n-th of them
 * is source line n.
 */
export type RawSource = {text: string; tints: string};

export function rawSource(source: string, groups: readonly ChangeGroup[], status?: FileStatus): RawSource {
  // A carriage return would end a line in the page's parser and in no
  // other count, so none is kept.
  const lines = source.replace(/\r/g, '').split('\n');
  // A final newline ends the last line; it starts no line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const added = new Set<number>();
  const removedAt = new Map<number, string[]>();
  for (const group of groups) {
    if (group.after) for (let line = group.after[0]; line <= group.after[1]; line += 1) added.add(line);
    if (group.removedLines.length > 0) removedAt.set(group.anchorLine, [...(removedAt.get(group.anchorLine) ?? []), ...group.removedLines.map((line) => line.replace(/\r/g, ''))]);
  }
  const text: string[] = [];
  let tints = '';
  const removed = (line: number) => {
    for (const each of removedAt.get(line) ?? []) {
      text.push(each);
      tints += '-';
    }
  };
  // A new or deleted file has no change runs (changeGroups), and the diff
  // drew every line of it green or red.
  const whole = status === 'added' || status === 'untracked' ? '+' : status === 'deleted' ? 'x' : null;
  for (const [index, line] of lines.entries()) {
    removed(index + 1);
    text.push(line);
    tints += whole ?? (added.has(index + 1) ? '+' : ' ');
  }
  // Text removed from the end of the file sits after its last line.
  for (const line of [...removedAt.keys()].filter((at) => at > lines.length).sort((a, b) => a - b)) removed(line);
  return {text: text.join('\n'), tints};
}
