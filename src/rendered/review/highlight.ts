import type {ElementContent, Root} from 'hast';
import {loadStarryNight} from '../markdown.js';
import {escapeText} from './diff.js';

// Syntax colors for the Review in browser page's source diffs, from the
// same grammars and `pl-*` classes the markdown renderer uses for fenced
// code. A whole side is highlighted at once, so a comment or string that
// runs over several lines is colored on each, then cut into one balanced
// piece of HTML per line: each span still open at a newline closes there
// and opens again on the next line. Worker side: the grammars load here.

// Names GitHub's common grammars don't list under the file's own
// extension, read as the nearest one they do.
const ALIASES: Record<string, string> = {tsx: 'ts', mts: 'ts', cts: 'ts', cjs: 'js', mjs: 'js', yml: 'yaml', htm: 'html', markdown: 'md', mdown: 'md', mkd: 'md'};

/** The grammar for a repo path, by its extension or its whole name, or null for none. */
export async function scopeFor(repoPath: string): Promise<string | null> {
  const starry = await loadStarryNight();
  const name = repoPath.slice(repoPath.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const flags = extension ? [ALIASES[extension] ?? extension, `.${extension}`] : [name];
  for (const flag of flags) {
    // Own keys only: a file named `constructor` has no grammar.
    if (!/^\.?[a-z0-9+_-]+$/.test(flag)) continue;
    const scope = starry.flagToScope(flag);
    if (scope) return scope;
  }
  return null;
}

// What the grammars are given at once. A grammar's time grows with the
// square of a line's length (a minified file or a one-line JSON of 200 KB
// holds the worker for minutes), and starry-night can't be stopped once it
// starts, so a side with a longer line, or more text than the page carries
// for a file, is drawn escaped, as GitHub draws long lines. Within these, a
// side takes the worker about a second at most.
export const COLORED_LINE_LIMIT = 4 * 1024;
export const COLORED_TEXT_LIMIT = 400 * 1024;

const colorable = (text: string) => text.length <= COLORED_TEXT_LIMIT && text.split('\n').every((line) => line.length <= COLORED_LINE_LIMIT);

/**
 * `text` as one piece of HTML per line, colored by the grammar for
 * `repoPath`, or null when there is none or the text is past what the
 * grammars are given. A final newline ends the last line rather than
 * starting an empty one, as git counts lines.
 */
export async function highlightLines(text: string, repoPath: string): Promise<string[] | null> {
  if (!colorable(text)) return null;
  const scope = await scopeFor(repoPath);
  if (!scope) return null;
  const starry = await loadStarryNight();
  const lines = splitLines(starry.highlight(text, scope));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** A highlighted tree as one balanced piece of HTML per line: a span still open at a newline closes there and opens again on the next line. */
export function splitLines(root: Root): string[] {
  const lines = [''];
  const open: string[] = [];
  const append = (html: string) => {
    lines[lines.length - 1] += html;
  };
  const visit = (nodes: readonly ElementContent[] | Root['children']) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const pieces = node.value.split('\n');
        for (const [index, piece] of pieces.entries()) {
          if (index > 0) {
            append('</span>'.repeat(open.length));
            lines.push(open.map((name) => `<span class="${name}">`).join(''));
          }
          append(escapeText(piece));
        }
      } else if (node.type === 'element') {
        const className = node.properties.className;
        const name = (Array.isArray(className) ? className : []).map(String).filter((each) => /^pl-[a-z0-9-]+$/.test(each)).join(' ');
        if (!name) {
          visit(node.children);
          continue;
        }
        append(`<span class="${name}">`);
        open.push(name);
        visit(node.children);
        open.pop();
        append('</span>');
      }
    }
  };
  visit(root.children);
  // A span a newline left with nothing in it on either line says nothing,
  // nor does one that held only such spans.
  const empty = /<span class="[^"]*"><\/span>/g;
  return lines.map((line) => {
    for (let text = line; ;) {
      const next = text.replace(empty, '');
      if (next === text) return text;
      text = next;
    }
  });
}
