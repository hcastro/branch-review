import type {ReviewFile} from '../review/model.js';
import type {SectionRow, WrappedSection} from '../sections.js';
import type {TextPart} from '../media/layout.js';
import {placeholderRun} from '../media/kitty.js';
import type {PaneBoxState, RenderedPane} from '../rendered/pane.js';
import {palette} from './palette.js';
import {styledParts, styledPlanRow} from './mediaRows.js';
import {truncateEnd, toDisplayText} from './text.js';

// Splices a rendered page's rows in place of a markdown file's diff rows,
// while the pane shows pages (`v`): its label, then one row per page row,
// each a row of a tile with the gutter's change mark before it. Rows are
// built at the pane's inner width and carry only geometry; the pane draws
// a tile row's cells when it draws the row, so a tile arriving never
// rebuilds the sections. Modeled on addMediaRows.

export type RenderedRowsLayout = {innerWidth: number; viewportRows: number};

/**
 * The sections with each page the pane covers in place of its diff, and
 * start lines renumbered after them. The same array outside the pane's
 * page mode.
 */
export function addRenderedRows<S extends WrappedSection & {key: string; file?: ReviewFile}>(sections: S[], pane: RenderedPane | null | undefined, layout: RenderedRowsLayout): S[] {
  if (!pane || pane.mode() !== 'rendered') return sections;
  let changed = false;
  let cursor = 0;
  const next = sections.map((section) => {
    let result = section;
    if (pane.covers(section.key)) {
      const plan = pane.rows(section.key, {innerCols: layout.innerWidth, viewportRows: layout.viewportRows});
      if (plan.length > 0) {
        const lines: string[] = [];
        const rows: SectionRow[] = [];
        let pageRow = 0;
        for (const row of plan) {
          if (row.type === 'box') {
            lines.push('');
            rows.push({block: -1, kind: 'media', continuation: false, pane: {fileKey: section.key, pageRow, box: row.boxes[0]!, boxRow: row.boxRow, ...(row.lead ? {lead: row.lead} : {})}});
            pageRow += 1;
          } else {
            lines.push(styledPlanRow(row, layout.innerWidth));
            rows.push({block: -1, kind: 'media', continuation: false, pane: {fileKey: section.key}});
          }
        }
        // A blank row between this page and the next file.
        lines.push('');
        rows.push({block: -1, kind: 'media', continuation: false, pane: {fileKey: section.key}});
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

const LOADING_SHADE = '░';

// The gutter while the bars glow: the accent, then the mark's own color
// made bright, then at rest in its own color.
function gutter(lead: readonly TextPart[], glow: 'accent' | 'bright' | null) {
  if (!glow || !palette.enabled) return styledParts([...lead]);
  return lead.map((part) => {
    if (part.tone === 'plain') return part.text;
    if (glow === 'accent') return `${palette.sgr.cyanBold}${toDisplayText(part.text)}${palette.sgr.reset}`;
    return `${palette.sgr.bold}${styledParts([part])}`;
  }).join('');
}

/**
 * A page row as the pane draws it, `inner` cells wide: the gutter, the
 * letterbox, then the tile's placeholder cells once the terminal has the
 * tile. Until then the row is a dim shade, never a stretched old tile; a
 * tile that failed says why on its first row.
 */
export function renderPaneRow(info: NonNullable<SectionRow['pane']>, state: PaneBoxState | null, inner: number, glow: 'accent' | 'bright' | null = null) {
  const {box, lead = []} = info;
  if (!box) return '';
  const boxRow = info.boxRow ?? 0;
  let out = gutter(lead, glow);
  const used = lead.reduce((sum, part) => sum + part.text.length, 0);
  out += ' '.repeat(Math.max(0, Math.min(box.leftPad, inner) - used));
  const width = Math.max(0, Math.min(box.cols, inner - Math.max(used, box.leftPad)));
  if (width === 0) return out;
  if (state?.status === 'kitty') return out + placeholderRun(state.id, boxRow, 0, width);
  if (state?.status === 'error' && boxRow === 0) {
    const shown = truncateEnd(toDisplayText(`couldn't draw this part of the page · ${state.reason}`), width);
    return `${out}${palette.sgr.red}${shown}${palette.sgr.reset}`;
  }
  if (state?.status === 'error') return out;
  return `${out}${palette.sgr.gray}${LOADING_SHADE.repeat(width)}${palette.sgr.reset}`;
}
