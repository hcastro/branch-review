import type {ReviewFile} from '../review/model.js';
import {truncateAnsi, visibleWidth, type SectionRow, type WrappedSection} from '../sections.js';
import {planMedia, type PlanRow, type PlanTextRow, type Tone} from '../media/layout.js';
import type {MediaRowInput} from '../media/service.js';
import type {MediaRef} from '../media/types.js';
import {palette} from './palette.js';
import {toDisplayText} from './text.js';

// Splices media rows into wrapped sections: a picture's label and box rows in
// place of the `binary file changed` line, or above an SVG's source hunks.
// Rows are built at the pane's inner width, already cut to fit, so neither
// frameLine nor Ink ever has to cut one. Box rows carry only geometry; the
// pane fills them in when it draws.

export type MediaRowsLayout = {innerWidth: number; viewportRows: number};

const TONES: Record<Tone, string> = {
  plain: '',
  dim: palette.sgr.gray,
  before: palette.sgr.red,
  after: palette.sgr.green,
  difference: palette.sgr.magenta,
  active: palette.sgr.cyanBold,
  error: palette.sgr.red,
  smaller: palette.sgr.green,
  larger: palette.sgr.red,
  changed: palette.sgr.yellow,
};
const RESET = palette.sgr.reset;

function styled(parts: PlanTextRow['pieces'][number]['parts']) {
  return parts.map((part) => {
    const text = toDisplayText(part.text);
    const tone = TONES[part.tone];
    return tone ? `${tone}${text}${RESET}` : text;
  }).join('');
}

/** A plan text row as an ANSI line of at most `width` cells. */
export function styledPlanRow(row: PlanTextRow, width: number) {
  let out = '';
  for (const piece of row.pieces) {
    const used = visibleWidth(out);
    out += used < piece.at ? ' '.repeat(piece.at - used) : out ? ' ' : '';
    out += styled(piece.parts);
  }
  if (row.right) {
    const right = styled(row.right);
    const used = visibleWidth(out);
    if (used + 2 + visibleWidth(right) <= width) out += ' '.repeat(width - used - visibleWidth(right)) + right;
  }
  return truncateAnsi(out, width);
}

function planLines(ref: MediaRef, media: MediaRowInput, layout: MediaRowsLayout) {
  const view = media.viewState(ref.fileKey);
  const sides = {
    ...(ref.before ? {before: media.sideState(ref, 'before')} : {}),
    ...(ref.after ? {after: media.sideState(ref, 'after')} : {}),
  };
  const plan = planMedia(ref, sides, view, {...layout, caps: media.caps, watching: media.watching}, media.drawnFacts(ref));
  // The hidden flip side rides on every box row, so it is sent ahead
  // whenever the shown side is near the viewport.
  const prefetch = plan.prefetch.length > 0 ? {prefetch: plan.prefetch} : {};
  const lines: string[] = [];
  const rows: SectionRow[] = [];
  for (const row of plan.rows as PlanRow[]) {
    if (row.type === 'box') {
      lines.push('');
      rows.push({block: -1, kind: 'media', continuation: false, media: {fileKey: ref.fileKey, boxes: row.boxes, boxRow: row.boxRow, ...(row.swap ? {swap: true} : {}), ...prefetch}});
    } else {
      lines.push(styledPlanRow(row, layout.innerWidth));
      rows.push({block: -1, kind: 'media', continuation: false, media: {fileKey: ref.fileKey, ...(row.spans ? {spans: row.spans} : {})}});
    }
  }
  return {lines, rows, textView: plan.textView};
}

// The `binary file changed` line build.ts draws for a binary file: a body
// row outside any block.
function isPlaceholderRow(row: SectionRow | undefined) {
  return row?.kind === 'body' && row.block === -1;
}

/**
 * The sections with media rows added, and start lines renumbered after
 * them. The same array when no section is media, or nothing can be drawn.
 */
export function addMediaRows<S extends WrappedSection & {file?: ReviewFile}>(sections: S[], media: MediaRowInput | null, layout: MediaRowsLayout): S[] {
  if (!media || media.caps.protocol === 'none') return sections;

  let changed = false;
  let cursor = 0;
  const next = sections.map((section) => {
    let result = section;
    const ref = section.file ? media.refFor(section.file) : null;
    if (ref) {
      const added = planLines(ref, media, layout);
      if (added.lines.length > 0) {
        // The text view keeps the placeholder line and lists details under
        // it. An SVG's picture goes before its first source block, whose
        // frame opens with a blank row under the picture; any line delta
        // prints above that block is source text and stays.
        const firstBlock = ref.hasSourceBlocks ? section.rows.findIndex((row) => row.block >= 0) : -1;
        const replace = firstBlock < 0 && !added.textView && isPlaceholderRow(section.rows[0]) ? 1 : 0;
        const at = firstBlock >= 0 ? firstBlock : added.textView && isPlaceholderRow(section.rows[0]) ? 1 : 0;
        const lines = [...section.lines];
        const rows = [...section.rows];
        lines.splice(at, replace, ...added.lines);
        rows.splice(at, replace, ...added.rows);
        result = {...section, lines, rows};
        changed = true;
      }
    }
    if (result.startLine !== cursor || result.endLineExclusive !== cursor + result.lines.length) {
      result = {...result, startLine: cursor, endLineExclusive: cursor + result.lines.length};
      changed = true;
    }
    cursor += result.lines.length;
    return result;
  });
  return changed ? next : sections;
}
