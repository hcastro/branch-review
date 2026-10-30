import React, {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Box, DOMElement, Text, useApp, useInput, useStdout} from 'ink';
import {
  MouseProvider,
  useMouse,
  useOnMouseHover,
} from '@zenobius/ink-mouse';
import {applyTreeCollapse, buildTreeRows, findTreeSelectionId, formatTreePayload, type TreeRow} from '../tree.js';
import {writeClipboard} from '../clipboard/write.js';
import {
  fitBlockHeaderLabel,
  flattenSectionLines,
  formatMetrics,
  frameBottomBorder,
  frameLine,
  frameTopBorder,
  getSectionIndexForLine,
  BLOCK_ACTION_LABELS,
  padToWidth,
  truncateAnsi,
  visibleWidth,
  wrapSections,
  type BranchMetrics,
  type DiffSection,
  type SectionRow,
  type WrappedSection,
} from '../sections.js';
import {graphemes, toDisplayText, truncateEnd, truncateStart, type Grapheme} from './text.js';
import {palette, plainDiffMode} from './palette.js';
import {DiffErrorBoundary, renderFailureText} from './DiffErrorBoundary.js';
import {blockSourceLines, mapDrawnToRaw} from './rawText.js';
import {useSettledValue} from './useSettledValue.js';
import {fileKey, type FileStatus} from '../git.js';
import {executeCopyCommand} from '../commands/execute.js';
import type {ClipboardWriter} from '../commands/execute.js';
import type {ReviewFile, ReviewBlock, ReviewModel} from '../review/model.js';
import type {GraphicsCaps} from '../media/types.js';
import {createLoneEscapeGuard} from '../media/replyGuard.js';

/**
 * Adds media rows to the wrapped sections, before blocks are folded, and may
 * put them in place of a media file's placeholder line. Rows it adds have
 * kind 'media'; every other row and line keeps its content and order. It
 * returns the same array when it adds nothing.
 */
export type MediaRowsHook = <S extends WrappedSection>(sections: S[], layout: {innerWidth: number; viewportRows: number}) => S[];

type AppProps = {
  base: string;
  branch: string;
  sections: DiffSection[];
  branchMetrics: BranchMetrics;
  review?: ReviewModel;
  copyWriter?: ClipboardWriter;
  readFileContent?: (file: ReviewFile) => string | null;
  resolveAbsolutePath?: (file: ReviewFile) => string | null;
  repoRoot?: string;
  worktreeBranchName?: string;
  dimensions?: {columns: number; rows: number};
  watchStatus?: string;
  emptyStateHint?: string;
  animations?: boolean;
  // What startup detection found the terminal can draw.
  graphics?: GraphicsCaps;
  addMediaRows?: MediaRowsHook;
};

const SCROLL_STEP = 3;
const DEFAULT_TREE_WIDTH_RATIO = 0.27;
const MAX_TREE_WIDTH_RATIO = 0.75;
const MIN_TREE_WIDTH = 34;
const COLLAPSED_TREE_WIDTH = 18;
const MIN_DIFF_WIDTH = 40;
// Rows outside the panes: the top bar and footer (three rows each with their
// borders) and one spare row, because Ink clears the screen before drawing a
// frame as tall as the terminal.
const CHROME_ROWS = 7;
const MIN_DIFF_ROWS = 3;
// Pane overhead: tree has 2 borders + 1 header row; diff has 2 borders + 2.
const DIFF_PANE_OVERHEAD = 4;
const MIN_TERMINAL_ROWS = CHROME_ROWS + DIFF_PANE_OVERHEAD + MIN_DIFF_ROWS;
const MIN_TERMINAL_COLUMNS = COLLAPSED_TREE_WIDTH + MIN_DIFF_WIDTH;
// Narrowest right-hand label worth showing in the top bar or footer.
const MIN_BAR_RIGHT_WIDTH = 10;
const TOAST_TIMEOUT_MS = 2200;
const COPY_SUCCESS_TIMEOUT_MS = 1200;
const CODE_SELECTION_RENDER_INTERVAL_MS = 33;
// How long the diff pane's width must hold still before the review is wrapped
// again for it. Wrapping a large review takes seconds, so a resize re-wraps
// once it settles; until then the last wrap is drawn, cut or padded to fit.
const WRAP_SETTLE_MS = 120;
const TREE_TOOLTIP_DELAY_MS = 300;
const ARRIVAL_ANIMATION_DURATION_MS = 2600;
const ARRIVAL_ANIMATION_TICK_MS = 130;
const MAX_ANIMATED_ENTRIES = 120;
const COPY_SUCCESS_LABEL = '✓ Copied';
// After a detection that timed out, how long a lone Esc or the input after a
// cut-off reply may still be part of a late terminal reply.
const LATE_REPLY_WINDOW_MS = 1500;
// Footer key hints in the order they are kept when the row is short.
const KEY_HINT_ITEMS = ['q quit', '↑/↓ jump file', 'j/k scroll', '[/] block', '⏎ fold', 'y d f c p b copy', 't tree'];
const KEY_HINT_SEPARATOR = ' • ';
const TREE_HEADER_COPY_LABEL = 'Copy tree';
const TREE_COLLAPSE_LABEL = '‹';
const TREE_EXPAND_LABEL = '›';
const FILE_ACTIONS = [
  {id: 'copy.path', label: 'Copy path'},
  {id: 'copy.fileDiff', label: 'Copy diff'},
  {id: 'copy.fileContents', label: 'Copy file'},
] as const;
const ABSOLUTE_PATH_ACTION = {id: 'copy.absolutePath', label: 'Copy absolute path'} as const;
// Keyboard copy: file commands act on the file in view, block commands on the
// focused block.
const FILE_KEY_COMMANDS: Record<string, string | undefined> = {
  y: 'copy.path',
  Y: 'copy.absolutePath',
  d: 'copy.fileDiff',
  f: 'copy.fileContents',
};
const BLOCK_KEY_COMMANDS: Record<string, string | undefined> = {
  c: 'copy.blockCode',
  p: 'copy.blockDiff',
  b: 'copy.blockPrompt',
};
const BLOCK_ACTIONS = [
  {id: 'copy.blockCode', label: BLOCK_ACTION_LABELS.code},
  {id: 'copy.blockDiff', label: BLOCK_ACTION_LABELS.diff},
  {id: 'copy.blockPrompt', label: BLOCK_ACTION_LABELS.prompt},
] as const;

type ArrivalKind = 'new' | 'changed';
type ArrivalEntry = {startedAt: number; kind: ArrivalKind};
type ArrivalAnimations = {
  files: Map<string, ArrivalEntry>;
  blocks: Map<string, ArrivalEntry>;
};
type ArrivalSnapshot = {
  files: Map<string, {
    signature: string;
    kind: ArrivalKind;
    blocks: Map<string, string>;
  }>;
};

type WrappedSectionCacheEntry = {
  lines: string[];
  rows: SectionRow[];
};

// `key` names the block for collapse state; it survives edits elsewhere in
// the file that move the block's line numbers.
type BlockTarget = {file: ReviewFile; block: ReviewBlock; key: string};
// One rendered diff row with its place in the review: the section it belongs
// to, the absolute index of its block's header row, and the block it maps to.
type DiffRow = SectionRow & {
  sectionIndex: number;
  headerLine: number | null;
  target?: BlockTarget;
  // On the first row of a code line: the line's raw text from the hunk, which
  // selection copies from.
  source?: string;
};
type ActionSpan = {id: string; start: number; end: number};
type ToastKind = 'success' | 'error' | 'info';
type Toast = {text: string; kind: ToastKind};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function applyScrollDelta(currentOffset: number, maxOffset: number, delta: number) {
  return clamp(currentOffset + delta, 0, maxOffset);
}

function ensureVisible(index: number, currentOffset: number, viewportSize: number) {
  if (viewportSize <= 0) {
    return 0;
  }

  if (index < 0) {
    return currentOffset;
  }

  if (index < currentOffset) {
    return index;
  }

  if (index >= currentOffset + viewportSize) {
    return index - viewportSize + 1;
  }

  return currentOffset;
}

function getPrimaryVisibleSectionIndex(
  sections: DiffSection[],
  lines: string[],
  rows: ReadonlyArray<Pick<SectionRow, 'kind'> | undefined>,
  startLine: number,
  endLineExclusive: number,
) {
  if (sections.length === 0) {
    return -1;
  }

  const start = clamp(startLine, 0, Math.max(lines.length - 1, 0));
  const end = clamp(endLineExclusive, start + 1, lines.length);
  // The first line from the top that has text or starts a file names the
  // active file: the blank line that ends a file hands over to the next one,
  // and a file whose only line is blank can still be the active one. A media
  // row counts as text, so a picture box still blank while it loads names
  // its own file.
  let sectionIndex = getSectionIndexForLine(sections, start);
  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    while (sectionIndex < sections.length - 1 && lineIndex >= sections[sectionIndex]!.endLineExclusive) sectionIndex += 1;
    if (lineIndex === sections[sectionIndex]!.startLine || rows[lineIndex]?.kind === 'media' || stripAnsi(lines[lineIndex] ?? '').trim()) {
      return sectionIndex;
    }
  }

  return getSectionIndexForLine(sections, start);
}

function getNodeBounds(node: DOMElement | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yoga: any = node ? (node as {yogaNode?: unknown}).yogaNode : null;
  if (!yoga) return null;

  const layout = yoga.getComputedLayout();
  let x = 0;
  let y = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parent: any = (node as {parentNode?: unknown}).parentNode;
  while (parent) {
    if (!parent.yogaNode) break;
    const parentLayout = parent.yogaNode.getComputedLayout();
    x += parentLayout.left;
    y += parentLayout.top;
    parent = parent.parentNode;
  }

  return {
    left: layout.left + x,
    top: layout.top + y,
    width: layout.width,
    height: layout.height,
  };
}

function getBounds(ref: React.RefObject<DOMElement>) {
  return getNodeBounds(ref.current);
}

type Bounds = {left: number; top: number; width: number; height: number};
type TreeTooltip = {text: string; left: number; top: number; width: number};

function isInside(bounds: Bounds | null, x: number, y: number) {
  if (!bounds) return false;
  return x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
}

function hashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function sectionWrapCacheKey(section: KeyedSection, maxWidth: number) {
  const signature = section.signature
    ?? hashText(`${section.metrics.additions}:${section.metrics.deletions}:${section.metrics.changedLines}:${section.lines.join('\n')}`);
  return `${maxWidth}\0${section.key}\0${signature}`;
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message.split('\n')[0]! : String(error);
}

// One unselectable row in the error colour, for a file whose diff can't be shown.
function errorRow(text: string, maxWidth: number) {
  return {
    line: `${ANSI_RED}${truncateEnd(text, Math.max(1, maxWidth))}${ANSI_RESET}`,
    row: {block: -1, kind: 'body', continuation: false} as SectionRow,
  };
}

// Wraps one section; a section that fails to wrap becomes a single error row
// so one bad file never takes down the rest of the review.
function wrapSectionSafely(section: DiffSection, maxWidth: number): WrappedSectionCacheEntry {
  try {
    const wrappedSection = wrapSections([section], maxWidth, {plusMinusMarkers: plainDiffMode})[0];
    return {lines: wrappedSection?.lines ?? [], rows: wrappedSection?.rows ?? []};
  } catch (error) {
    const failure = errorRow(renderFailureText(section.path, errorText(error), maxWidth), maxWidth);
    return {lines: [failure.line], rows: [failure.row]};
  }
}

function wrapSectionsWithCache<S extends KeyedSection>(
  sections: S[],
  maxWidth: number,
  cache: Map<string, WrappedSectionCacheEntry>,
) {
  const nextCache = new Map<string, WrappedSectionCacheEntry>();
  let cursor = 0;

  const wrapped = sections.map((section) => {
    const key = sectionWrapCacheKey(section, maxWidth);
    let entry = cache.get(key);
    if (!entry) {
      entry = wrapSectionSafely(section, maxWidth);
    }

    nextCache.set(key, entry);
    const startLine = cursor;
    const endLineExclusive = cursor + entry.lines.length;
    cursor = endLineExclusive;

    return {
      ...section,
      lines: entry.lines,
      rows: entry.rows,
      startLine,
      endLineExclusive,
    };
  });

  cache.clear();
  for (const [key, value] of nextCache) {
    cache.set(key, value);
  }

  return wrapped;
}

function blockAnimationKey(filePath: string, block: Pick<ReviewBlock, 'id'>) {
  return `${filePath}\0${block.id}`;
}

function fileArrivalKind(file: Pick<ReviewFile, 'status'> | undefined): ArrivalKind {
  return file?.status === 'added' || file?.status === 'untracked' ? 'new' : 'changed';
}

function buildArrivalSnapshot(review: ReviewModel | undefined, sections: KeyedSection[]): ArrivalSnapshot {
  if (review) {
    return {
      files: new Map(review.files.map((file) => {
        const blocks = new Map(file.blocks.map((block) => [
          blockAnimationKey(reviewFileKey(file), block),
          block.signature ?? hashText(`${block.lineStart}:${block.lineEnd}:${block.rawDiff}:${block.addedCode}`),
        ]));
        return [
          reviewFileKey(file),
          {
            signature: file.signature ?? hashText(`${file.status}:${file.rawDiff}:${file.metrics.additions}:${file.metrics.deletions}`),
            kind: fileArrivalKind(file),
            blocks,
          },
        ];
      })),
    };
  }

  return {
    files: new Map(sections.map((section) => [
      section.key,
      {
        signature: hashText(`${section.metrics.additions}:${section.metrics.deletions}:${section.lines.join('\n')}`),
        kind: 'changed' as const,
        blocks: new Map<string, string>(),
      },
    ])),
  };
}

function diffArrivalSnapshots(previous: ArrivalSnapshot, next: ArrivalSnapshot, startedAt: number): ArrivalAnimations {
  const files = new Map<string, ArrivalEntry>();
  const blocks = new Map<string, ArrivalEntry>();
  let count = 0;

  for (const [path, file] of next.files) {
    if (count >= MAX_ANIMATED_ENTRIES) break;
    const previousFile = previous.files.get(path);
    const fileKind = previousFile ? 'changed' : file.kind;
    if (!previousFile || previousFile.signature !== file.signature) {
      files.set(path, {startedAt, kind: fileKind});
      count += 1;
    }

    for (const [blockKey, blockSignature] of file.blocks) {
      if (count >= MAX_ANIMATED_ENTRIES) break;
      if (previousFile?.blocks.get(blockKey) !== blockSignature) {
        blocks.set(blockKey, {startedAt, kind: fileKind});
        count += 1;
      }
    }
  }

  return {files, blocks};
}

function pruneArrivalAnimations(animations: ArrivalAnimations, now: number): ArrivalAnimations {
  const files = new Map<string, ArrivalEntry>();
  const blocks = new Map<string, ArrivalEntry>();

  for (const [key, entry] of animations.files) {
    if (now - entry.startedAt < ARRIVAL_ANIMATION_DURATION_MS) {
      files.set(key, entry);
    }
  }

  for (const [key, entry] of animations.blocks) {
    if (now - entry.startedAt < ARRIVAL_ANIMATION_DURATION_MS) {
      blocks.set(key, entry);
    }
  }

  return {files, blocks};
}

function hasArrivalAnimations(animations: ArrivalAnimations) {
  return animations.files.size > 0 || animations.blocks.size > 0;
}

function arrivalProgress(entry: ArrivalEntry, now: number) {
  return clamp((now - entry.startedAt) / ARRIVAL_ANIMATION_DURATION_MS, 0, 1);
}

function arrivalBackgroundStyle(entry: ArrivalEntry, now: number) {
  return palette.arrivalBackground(entry.kind, arrivalProgress(entry, now));
}

function applyArrivalWash(line: string, entry: ArrivalEntry | undefined, now: number) {
  if (!entry) return line;
  const style = arrivalBackgroundStyle(entry, now);
  if (!style) return line;

  const cells = toStyledCells(line);
  for (const cell of cells) {
    cell.style = `${cell.style}${style}`;
  }

  return renderStyledCells(cells);
}

function treeArrivalColor(entry: ArrivalEntry | undefined, now: number) {
  if (!entry) return null;
  const progress = arrivalProgress(entry, now);
  if (progress >= 1) return null;

  if (entry.kind === 'new') {
    return palette.ink(progress < 0.4 ? 'greenBright' : 'green');
  }

  return palette.ink(progress < 0.4 ? 'cyanBright' : 'cyan');
}

function getTreeWidthLimits(columns: number) {
  const maxWithDiff = columns - MIN_DIFF_WIDTH;
  const maxByRatio = Math.floor(columns * MAX_TREE_WIDTH_RATIO);
  const max = Math.max(MIN_TREE_WIDTH, Math.min(maxWithDiff, maxByRatio));
  return {min: Math.min(MIN_TREE_WIDTH, max), max};
}

function defaultTreeWidth(columns: number) {
  const {min, max} = getTreeWidthLimits(columns);
  return clamp(Math.floor(columns * DEFAULT_TREE_WIDTH_RATIO), min, max);
}

function isTreeResizeTarget(bounds: Bounds | null, x: number, y: number) {
  if (!bounds) return false;
  if (y <= bounds.top || y >= bounds.top + bounds.height - 1) return false;

  const rightBorder = bounds.left + bounds.width - 1;
  return x >= rightBorder - 1 && x <= rightBorder + 2;
}

function treeHeaderActionLabel(collapsed: boolean, copied = false) {
  if (collapsed) return TREE_EXPAND_LABEL;
  const copyLabel = copied ? successLabel(TREE_HEADER_COPY_LABEL) : TREE_HEADER_COPY_LABEL;
  return `${TREE_COLLAPSE_LABEL}  ${copyLabel}`;
}

function isTreeToggleTarget(panelBounds: Bounds | null, x: number, y: number, contentWidth: number, collapsed: boolean, copied = false) {
  if (!isInside(panelBounds, x, y) || !panelBounds) return false;

  const headerY = panelBounds.top + 1;
  if (y !== headerY) return false;

  const rowLeft = panelBounds.left + 2;
  const actionLabel = treeHeaderActionLabel(collapsed, copied);
  const actionStart = rowLeft + Math.max(0, contentWidth - visibleWidth(actionLabel));
  return x >= actionStart && x < actionStart + visibleWidth(collapsed ? TREE_EXPAND_LABEL : TREE_COLLAPSE_LABEL);
}

function buildTreeTooltip(text: string, bounds: Bounds, columns: number, terminalRows: number): TreeTooltip {
  const maxWidth = Math.max(12, columns - 4);
  const width = clamp(visibleWidth(text) + 4, 12, maxWidth);
  const tooltipHeight = 3;
  const preferredLeft = bounds.left + bounds.width + 1;
  const left = preferredLeft + width <= columns
    ? preferredLeft
    : clamp(bounds.left, 0, Math.max(0, columns - width));
  const preferredTop = bounds.top + 1;
  const top = preferredTop + tooltipHeight <= terminalRows
    ? preferredTop
    : Math.max(0, bounds.top - tooltipHeight);

  return {text, left, top, width};
}

function treeTooltipsEqual(left: TreeTooltip | null, right: TreeTooltip | null) {
  return left?.text === right?.text
    && left?.left === right?.left
    && left?.top === right?.top
    && left?.width === right?.width;
}

function normalizeMousePosition(position: {x: number; y: number}) {
  return {
    x: position.x - 1,
    y: position.y - 1,
  };
}

function isWorktreeLabelTarget(bounds: Bounds | null, x: number, y: number, branch: string) {
  const worktreeStart = branch.indexOf('worktree');
  if (!bounds || worktreeStart < 0) return false;
  if (y !== bounds.top + 1) return false;

  const labelStart = bounds.left + 2 + visibleWidth('branch-review ') + visibleWidth(branch.slice(0, worktreeStart));
  const labelEnd = labelStart + visibleWidth('worktree');
  return x >= labelStart && x < labelEnd;
}

function isBaseLabelTarget(bounds: Bounds | null, x: number, y: number, branch: string, base: string) {
  if (!bounds) return false;
  if (y !== bounds.top + 1) return false;

  const labelStart = bounds.left + 2 + visibleWidth('branch-review ') + visibleWidth(branch) + visibleWidth(' against ');
  const labelEnd = labelStart + visibleWidth(base);
  return x >= labelStart && x < labelEnd;
}

function statusColor(status: FileStatus | undefined) {
  if (status === 'added' || status === 'untracked') return palette.ink('green');
  if (status === 'deleted') return palette.ink('red');
  if (status === 'renamed') return palette.ink('magenta');
  return palette.ink('yellow');
}

function statusLabel(status: FileStatus | undefined) {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'renamed') return 'R';
  if (status === 'untracked') return 'U';
  return status ? 'M' : '';
}

function statusHint(status: FileStatus | undefined) {
  if (status === 'added') return 'file status added';
  if (status === 'deleted') return 'file status deleted';
  if (status === 'renamed') return 'file status renamed';
  if (status === 'untracked') return 'file status untracked';
  if (status === 'modified') return 'file status modified';
  return null;
}

function copyActionHint(actionId: string) {
  if (actionId === 'copy.path') return 'copies relative file path';
  if (actionId === 'copy.absolutePath') return 'copies absolute file path';
  if (actionId === 'copy.fileDiff') return 'copies file diff';
  if (actionId === 'copy.fileContents') return 'copies full file contents';
  if (actionId === 'copy.blockCode') return 'copies added code only';
  if (actionId === 'copy.blockDiff') return 'copies block diff';
  if (actionId === 'copy.blockPrompt') return 'copies block with file and line context';
  if (actionId === 'copy.tree') return 'copies changed-file tree';
  return null;
}

function isTreeStatusTarget(relativeX: number, width: number, copied = false) {
  return relativeX === Math.max(0, width - getTreeIndicatorWidth(copied));
}

function treeRowGlyph(row: Pick<TreeRow, 'kind' | 'expanded'>) {
  return row.kind === 'dir' ? row.expanded === false ? '▸' : '▾' : '•';
}

function treeRowLabelText(row: Pick<TreeRow, 'depth' | 'expanded' | 'kind' | 'label'>) {
  return `${' '.repeat(row.depth * 2)}${treeRowGlyph(row)} ${toDisplayText(row.label)}`;
}

function treeRowLabelWidth(row: Pick<TreeRow, 'kind'>, width: number, copied = false) {
  return row.kind === 'file'
    ? Math.max(1, width - getTreeIndicatorWidth(copied) - 1)
    : width;
}

function isTreeRowLabelTruncated(row: Pick<TreeRow, 'depth' | 'expanded' | 'kind' | 'label'>, width: number, copied = false) {
  return visibleWidth(treeRowLabelText(row)) > treeRowLabelWidth(row, width, copied);
}

const TreeFileRow = memo(function TreeFileRow({
  row,
  selected,
  hovered,
  copyHovered,
  copySucceeded,
  arrivalEntry,
  arrivalNow,
  width,
}: {
  row: TreeRow;
  selected: boolean;
  hovered: boolean;
  copyHovered: boolean;
  copySucceeded: boolean;
  arrivalEntry?: ArrivalEntry;
  arrivalNow: number;
  width: number;
}) {
  const arrivalColor = treeArrivalColor(arrivalEntry, arrivalNow);
  // File names use the terminal's default foreground, which reads on light
  // and dark themes alike; directory rows are not dimmed.
  const accent = selected
    ? palette.ink('cyan')
    : arrivalColor ?? (row.kind === 'dir' ? palette.ink('yellow') : hovered ? palette.ink('cyan') : undefined);
  const copyVisible = shouldShowTreeCopy(row.kind, hovered, selected, copySucceeded);
  const copyLabel = copySucceeded ? successLabel('Copy') : 'Copy';
  const copySlotWidth = getTreeCopySlotWidth(copySucceeded);
  const indicatorWidth = row.kind === 'file' ? getTreeIndicatorWidth(copySucceeded) : 0;
  const labelWidth = treeRowLabelWidth(row, width, copySucceeded);

  return (
    <Box width={width}>
      <Box width={labelWidth}>
        <Text color={accent} bold={selected || Boolean(arrivalColor)} wrap="truncate-end">
          {treeRowLabelText(row)}
        </Text>
      </Box>
      {row.kind === 'file' && (
        <>
        <Box width={1} />
        <Box width={indicatorWidth} justifyContent="flex-end">
          <Text color={statusColor(row.status)} bold={Boolean(row.status)}>
            {statusLabel(row.status)}
          </Text>
          <Text color={palette.ink(copySucceeded ? 'greenBright' : copyHovered ? 'cyan' : 'gray')} bold={copySucceeded || copyHovered}>
            {copyVisible ? ` ${copyLabel}` : ' '.repeat(copySlotWidth)}
          </Text>
        </Box>
        </>
      )}
    </Box>
  );
});

export function shouldShowTreeCopy(rowKind: TreeRow['kind'], hovered: boolean, _selected: boolean, copied = false) {
  return rowKind === 'file' && (hovered || copied);
}

export function getTreeCopySlotWidth(copied = false) {
  return copied ? visibleWidth(` ${successLabel('Copy')}`) : visibleWidth(' Copy');
}

export function getTreeIndicatorWidth(copied = false) {
  return 1 + getTreeCopySlotWidth(copied);
}

function TreePane({
  panelRef,
  width,
  height,
  hovered,
  resizeActive,
  setHovered,
  children,
}: {
  panelRef: React.RefObject<DOMElement>;
  width: number;
  height: number;
  hovered: boolean;
  resizeActive: boolean;
  setHovered: (hovered: boolean) => void;
  children: React.ReactNode;
}) {
  useOnMouseHover(panelRef, setHovered);

  return (
    <Box
      ref={panelRef}
      width={width}
      height={height}
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={palette.ink(resizeActive ? 'gray' : hovered ? 'cyan' : 'gray')}
      borderRightColor={palette.ink(resizeActive ? 'cyanBright' : hovered ? 'cyan' : 'gray')}
      paddingX={1}
    >
      {children}
    </Box>
  );
}

function TreeTooltipOverlay({tooltip}: {tooltip: TreeTooltip}) {
  const inner = Math.max(1, tooltip.width - 4);
  const horizontal = '─'.repeat(inner + 2);
  const text = padToWidth(truncateStart(tooltip.text, inner), inner);

  return (
    <Box
      position="absolute"
      marginLeft={tooltip.left}
      marginTop={tooltip.top}
      width={tooltip.width}
      flexDirection="column"
    >
      <Text color={palette.ink('gray')}>{`╭${horizontal}╮`}</Text>
      <Box width={tooltip.width}>
        <Text color={palette.ink('gray')}>│ </Text>
        <Text>{text}</Text>
        <Text color={palette.ink('gray')}> │</Text>
      </Box>
      <Text color={palette.ink('gray')}>{`╰${horizontal}╯`}</Text>
    </Box>
  );
}

function DiffPane({
  panelRef,
  width,
  height,
  hovered,
  setHovered,
  children,
}: {
  panelRef: React.RefObject<DOMElement>;
  width: number;
  height: number;
  hovered: boolean;
  setHovered: (hovered: boolean) => void;
  children: React.ReactNode;
}) {
  useOnMouseHover(panelRef, setHovered);

  return (
    <Box
      ref={panelRef}
      width={width}
      height={height}
      flexDirection="column"
      flexShrink={0}
    >
      {children}
    </Box>
  );
}

const ANSI_CYAN_BOLD = palette.sgr.cyanBold;
const ANSI_CYAN = palette.sgr.cyan;
const ANSI_GRAY = palette.sgr.gray;
const ANSI_GREEN_BOLD = palette.sgr.greenBold;
const ANSI_GREEN = palette.sgr.green;
const ANSI_RED = palette.sgr.red;
const ANSI_YELLOW = palette.sgr.yellow;
const ANSI_MAGENTA = palette.sgr.magenta;
const ANSI_MAGENTA_BRIGHT = palette.sgr.magentaBright;
const ANSI_RESET = palette.sgr.reset;
const ANSI_SELECTION = palette.sgr.selection;

type HoveredAction =
  | {kind: 'file-header'; id: string}
  | {kind: 'tree-header'; id: 'copy.tree'}
  | {kind: 'tree-copy'; rowIndex: number}
  | {kind: 'block'; id: string; lineIndex: number}
  | null;
type CopiedAction = Exclude<HoveredAction, null>;
type CodeSelectionPoint = {lineIndex: number; column: number};
type CodeSelection = {
  anchor: CodeSelectionPoint;
  focus: CodeSelectionPoint;
  active: boolean;
  // The rendered lines the points index into. A selection is only drawn or
  // copied against these exact lines; after a refresh it is remapped or dropped.
  lines: string[];
};

function hoveredActionsEqual(current: HoveredAction, next: HoveredAction) {
  if (current === next) return true;
  if (!current || !next || current.kind !== next.kind) return false;

  if (current.kind === 'file-header' && next.kind === 'file-header') {
    return current.id === next.id;
  }

  if (current.kind === 'tree-header' && next.kind === 'tree-header') {
    return current.id === next.id;
  }

  if (current.kind === 'tree-copy' && next.kind === 'tree-copy') {
    return current.rowIndex === next.rowIndex;
  }

  if (current.kind === 'block' && next.kind === 'block') {
    return current.id === next.id && current.lineIndex === next.lineIndex;
  }

  return false;
}

function ansiStatus(status: FileStatus | undefined) {
  const label = statusLabel(status);
  if (!label) return '';
  const color = status === 'added' || status === 'untracked'
    ? ANSI_GREEN
    : status === 'deleted'
      ? ANSI_RED
      : status === 'renamed'
        ? ANSI_MAGENTA
        : ANSI_YELLOW;
  return `${color}${label}${ANSI_RESET}`;
}

function successLabel(label: string) {
  const gap = Math.max(0, visibleWidth(label) - visibleWidth(COPY_SUCCESS_LABEL));
  return `${COPY_SUCCESS_LABEL}${' '.repeat(gap)}`;
}

function actionButton(label: string, primary = false, copied = false) {
  const text = copied ? successLabel(label) : label;
  const color = copied ? ANSI_GREEN_BOLD : primary ? ANSI_CYAN_BOLD : ANSI_GRAY;
  return `${ANSI_GRAY}╭─${ANSI_RESET}${color}${text}${ANSI_RESET}${ANSI_GRAY}─╮${ANSI_RESET}`;
}

function composeLeftRight(left: string, right: string, width: number) {
  if (!right) return truncateAnsi(left, width);

  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(1, width - rightWidth - 1);
  const safeLeft = visibleWidth(left) > availableLeft ? truncateAnsi(left, availableLeft) : left;
  const gap = Math.max(1, width - visibleWidth(safeLeft) - rightWidth);
  return `${safeLeft}${' '.repeat(gap)}${right}`;
}

function isFileActionCopied(actionId: string, copiedAction?: string) {
  return actionId === copiedAction || (actionId === 'copy.path' && copiedAction === ABSOLUTE_PATH_ACTION.id);
}

function fileActions(actions: ReadonlyArray<(typeof FILE_ACTIONS)[number]>, hoveredAction?: string, copiedAction?: string) {
  return actions
    .map((action) => actionButton(action.label, action.id === hoveredAction, isFileActionCopied(action.id, copiedAction)))
    .join(' ');
}

// The leading actions, in order, whose widths plus `gap` cells between each
// fit in `available` cells. An action that doesn't fit is dropped whole, and
// so are the ones after it.
function fittingActions<T>(actions: ReadonlyArray<T>, widthOf: (action: T) => number, gap: number, available: number) {
  const fitted: T[] = [];
  let used = 0;
  for (const action of actions) {
    const next = used + (fitted.length > 0 ? gap : 0) + widthOf(action);
    if (next > available) break;
    fitted.push(action);
    used = next;
  }

  return fitted;
}

// Cells a path keeps before any action is drawn beside it: the whole path
// when it is short, otherwise `…` and its last component, up to a cap so one
// huge name can't push every action off the row.
const MAX_RESERVED_NAME_WIDTH = 40;
function reservedNameWidth(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const nameWidth = name === path ? visibleWidth(name) : visibleWidth(name) + 1;
  return Math.min(visibleWidth(path), nameWidth, MAX_RESERVED_NAME_WIDTH);
}

function shouldRevealAbsolutePathAction(hoveredAction?: string, copiedAction?: string) {
  return hoveredAction === 'copy.path'
    || hoveredAction === 'copy.absolutePath'
    || copiedAction === 'copy.path'
    || copiedAction === ABSOLUTE_PATH_ACTION.id;
}

type StyledCell = {
  char: string;
  width: number;
  style: string;
};

// Splits an ANSI line into one cell per grapheme, each carrying its terminal
// width and the SGR style active at that point.
function toStyledCells(line: string) {
  const parts = line.split(/(\x1B\[[0-9;:]*[A-Za-z])/);
  const cells: StyledCell[] = [];
  let style = '';

  for (const part of parts) {
    if (!part) continue;
    if (/^\x1B\[[0-9;:]*[A-Za-z]$/.test(part)) {
      style = part === ANSI_RESET ? '' : style + part;
      continue;
    }

    for (const grapheme of graphemes(part)) {
      cells.push({char: grapheme.text, width: grapheme.width, style});
    }
  }

  return cells;
}

function renderStyledCells(cells: StyledCell[]) {
  let output = '';
  let style = '';

  for (const cell of cells) {
    if (cell.style !== style) {
      output += cell.style || ANSI_RESET;
      style = cell.style;
    }

    output += cell.char;
  }

  return output + ANSI_RESET;
}

function compareSelectionPoints(a: CodeSelectionPoint, b: CodeSelectionPoint) {
  if (a.lineIndex !== b.lineIndex) {
    return a.lineIndex - b.lineIndex;
  }

  return a.column - b.column;
}

function selectionPointsEqual(a: CodeSelectionPoint, b: CodeSelectionPoint) {
  return a.lineIndex === b.lineIndex && a.column === b.column;
}

function codeSelectionsEqual(a: CodeSelection | null, b: CodeSelection | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.active === b.active
    && a.lines === b.lines
    && selectionPointsEqual(a.anchor, b.anchor)
    && selectionPointsEqual(a.focus, b.focus);
}

function normalizeCodeSelection(selection: Pick<CodeSelection, 'anchor' | 'focus'>) {
  return compareSelectionPoints(selection.anchor, selection.focus) <= 0
    ? {start: selection.anchor, end: selection.focus}
    : {start: selection.focus, end: selection.anchor};
}

type CodeContent = {
  // Cell column where the code starts on the rendered row.
  start: number;
  parts: Grapheme[];
  width: number;
};

// The selectable code on a body row: everything right of delta's gutter.
// Selection columns are terminal cells counted from `start`.
function getCodeContent(line: string, row: SectionRow | undefined): CodeContent | null {
  if (!row || row.kind !== 'body' || row.codeColumn === undefined) return null;

  const parts = graphemes(stripAnsi(line));
  let column = 0;
  let index = 0;
  while (index < parts.length && column < row.codeColumn) {
    column += parts[index]!.width;
    index += 1;
  }

  const code = parts.slice(index);
  return {start: column, parts: code, width: code.reduce((sum, part) => sum + part.width, 0)};
}

function selectedCodeColumns(lineIndex: number, content: CodeContent, selection: Pick<CodeSelection, 'anchor' | 'focus'>) {
  const {start, end} = normalizeCodeSelection(selection);
  if (lineIndex < start.lineIndex || lineIndex > end.lineIndex) {
    return null;
  }

  const from = lineIndex === start.lineIndex ? clamp(start.column, 0, content.width) : 0;
  const to = lineIndex === end.lineIndex ? clamp(end.column + 1, 0, content.width) : content.width;
  return to > from ? {from, to} : null;
}

// Whether a grapheme at `column` overlaps the cell range [from, to); a wide
// character that is partly selected counts whole, and a zero-width one counts
// when its column is selected.
function overlapsColumns(column: number, width: number, from: number, to: number) {
  return column < to && column + Math.max(width, 1) > from;
}

function highlightSelectedCode(line: string, row: SectionRow | undefined, lineIndex: number, selection: CodeSelection | null) {
  if (!selection) return line;

  const content = getCodeContent(line, row);
  if (!content) return line;
  const range = selectedCodeColumns(lineIndex, content, selection);
  if (!range) return line;

  const from = content.start + range.from;
  const to = content.start + range.to;
  const cells = toStyledCells(line);
  let column = 0;
  for (const cell of cells) {
    if (column < to && column + cell.width > from) {
      cell.style = `${cell.style}${ANSI_SELECTION}`;
    }
    column += cell.width;
  }

  return renderStyledCells(cells);
}

type SelectableRow = SectionRow & {source?: string};

export function getSelectedCodeText(
  lines: string[],
  rows: ReadonlyArray<SelectableRow | undefined>,
  selection: Pick<CodeSelection, 'anchor' | 'focus'>,
) {
  const {start, end} = normalizeCodeSelection(selection);
  const selectedLines: string[] = [];
  // Walk whole source lines: a wrapped line's continuation rows belong to the
  // line on the row above them.
  let first = start.lineIndex;
  while (first > 0 && rows[first]?.continuation) first -= 1;

  while (first <= end.lineIndex) {
    let last = first;
    while (last + 1 < lines.length && rows[last + 1]?.continuation) last += 1;
    const text = selectedSourceLineText(lines, rows, first, last, selection);
    if (text !== null) selectedLines.push(text);
    first = last + 1;
  }

  return selectedLines.join('\n');
}

// Why a selection can't be copied: the diff error of the first selected file
// whose diff text failed to load or is not valid UTF-8.
function selectionCopyError(
  rows: ReadonlyArray<DiffRow | undefined>,
  sections: ReadonlyArray<Pick<KeyedSection, 'file'>>,
  selection: Pick<CodeSelection, 'anchor' | 'focus'>,
) {
  const {start, end} = normalizeCodeSelection(selection);
  let previousSection = -1;
  for (let lineIndex = start.lineIndex; lineIndex <= end.lineIndex; lineIndex += 1) {
    const sectionIndex = rows[lineIndex]?.sectionIndex;
    if (sectionIndex === undefined || sectionIndex === previousSection) continue;
    previousSection = sectionIndex;
    const reason = sections[sectionIndex]?.file?.rawDiffError;
    if (reason !== undefined) return reason;
  }

  return undefined;
}

// The selected part of one source line drawn on rows [first, last], or null
// when none of those rows holds code. With the line's raw text known, the
// selected cells map back to raw characters and a fully selected line copies
// the raw line; without it, the drawn text is copied.
function selectedSourceLineText(
  lines: string[],
  rows: ReadonlyArray<SelectableRow | undefined>,
  first: number,
  last: number,
  selection: Pick<CodeSelection, 'anchor' | 'focus'>,
) {
  const {start, end} = normalizeCodeSelection(selection);
  let drawn = '';
  let drawnSelected = '';
  // UTF-16 ranges of `drawn` that are selected.
  const selectedUnits: Array<[number, number]> = [];
  let hasCode = false;
  let whole = true;

  for (let lineIndex = first; lineIndex <= last; lineIndex += 1) {
    const content = getCodeContent(lines[lineIndex] ?? '', rows[lineIndex]);
    if (!content) continue;
    hasCode = true;

    const inSelection = lineIndex >= start.lineIndex && lineIndex <= end.lineIndex;
    const range = inSelection ? selectedCodeColumns(lineIndex, content, selection) : null;
    if (!range || range.from > 0 || range.to < content.width) whole = false;

    let column = 0;
    for (const part of content.parts) {
      if (range && overlapsColumns(column, part.width, range.from, range.to)) {
        selectedUnits.push([drawn.length, drawn.length + part.text.length]);
        drawnSelected += part.text;
      }
      drawn += part.text;
      column += part.width;
    }
  }

  if (!hasCode) return null;

  const raw = rows[first]?.source;
  const map = raw === undefined ? null : mapDrawnToRaw(raw, drawn);
  if (raw === undefined || !map) return drawnSelected;
  if (whole) return raw;

  let from = raw.length;
  let to = 0;
  for (const [unitStart, unitEnd] of selectedUnits) {
    for (let unit = unitStart; unit < unitEnd; unit += 1) {
      from = Math.min(from, map[unit]![0]);
      to = Math.max(to, map[unit]![1]);
    }
  }

  return to > from ? raw.slice(from, to) : '';
}

function blankCell(style: string): StyledCell {
  return {char: ' ', width: 1, style};
}

// Draws `overlay` over `baseLine` starting at cell column `start`. A wide
// character cut by either edge of the overlay is replaced with spaces.
function overlayAnsiAt(baseLine: string, overlay: string, start: number, width: number) {
  const baseCells = toStyledCells(padToWidth(truncateAnsi(baseLine, width), width));
  const overlayCells = toStyledCells(overlay);
  const overlayWidth = visibleWidth(overlay);
  if (overlayWidth <= 0 || overlayWidth > width) return baseLine;

  const safeStart = clamp(start, 0, Math.max(0, width - overlayWidth));
  const safeEnd = safeStart + overlayWidth;
  const output: StyledCell[] = [];
  let column = 0;
  let placed = false;

  for (const cell of baseCells) {
    const cellEnd = column + cell.width;
    if (cellEnd <= safeStart || column >= safeEnd) {
      if (column >= safeEnd && !placed) {
        output.push(...overlayCells);
        placed = true;
      }
      output.push(cell);
    } else {
      for (let pad = column; pad < safeStart; pad += 1) output.push(blankCell(cell.style));
      if (!placed) {
        output.push(...overlayCells);
        placed = true;
      }
      for (let pad = Math.max(column, safeEnd); pad < cellEnd; pad += 1) output.push(blankCell(cell.style));
    }
    column = cellEnd;
  }

  if (!placed) output.push(...overlayCells);
  return renderStyledCells(output);
}

function secondaryPathActionLabel(hoveredAction?: string, copiedAction?: string) {
  const hovered = hoveredAction === ABSOLUTE_PATH_ACTION.id && copiedAction !== ABSOLUTE_PATH_ACTION.id;
  const color = hovered ? ANSI_CYAN_BOLD : ANSI_GRAY;
  return `${color}${ABSOLUTE_PATH_ACTION.label}${ANSI_RESET}`;
}

type DiffHeader = {
  fileRow: string;
  metricsRow: string;
  // Clickable labels, in columns inside the pane border.
  fileSpans: ActionSpan[];
  metricsSpans: ActionSpan[];
};

// Builds the two diff header rows and the spans of every action drawn on
// them. Render, hover and click all use this one result, so a hit can only
// land on an action that is on screen.
function buildDiffHeader({
  path,
  status,
  showActions,
  hoveredAction,
  copiedAction,
  metricsCore,
  width,
}: {
  path: string;
  status: FileStatus | undefined;
  showActions: boolean;
  hoveredAction?: string;
  copiedAction?: string;
  metricsCore: string;
  width: number;
}): DiffHeader {
  const statusText = ansiStatus(status);
  const statusWidth = statusText ? visibleWidth(statusText) + 1 : 0;
  const displayPath = toDisplayText(path || ' ');
  const buttonWidth = (action: (typeof FILE_ACTIONS)[number]) => visibleWidth(isFileActionCopied(action.id, copiedAction) ? successLabel(action.label) : action.label) + 4;
  // The file name keeps its room first; buttons that don't fit beside it are
  // left out, and with them their click targets.
  const drawnActions = showActions
    ? fittingActions(FILE_ACTIONS, buttonWidth, 1, width - statusWidth - reservedNameWidth(displayPath) - 1)
    : [];
  const right = drawnActions.length > 0 ? fileActions(drawnActions, hoveredAction, copiedAction) : '';
  const rightWidth = visibleWidth(right);
  const pathWidth = Math.max(1, width - statusWidth - (right ? rightWidth + 1 : 0));
  const fileLabel = `${statusText}${statusText ? ' ' : ''}${ANSI_CYAN_BOLD}${truncateStart(displayPath, pathWidth)}${ANSI_RESET}`;
  const fileRow = composeLeftRight(fileLabel, right, width);

  const fileSpans: ActionSpan[] = [];
  let pathButton: {start: number; width: number} | null = null;
  if (right) {
    let column = visibleWidth(fileRow) - rightWidth;
    for (const action of drawnActions) {
      const width = buttonWidth(action);
      const labelWidth = width - 4;
      fileSpans.push({id: action.id, start: column + 2, end: column + 2 + labelWidth});
      if (action.id === 'copy.path') pathButton = {start: column, width};
      column += width + 1;
    }
  }

  let metricsRow = metricsCore;
  const metricsSpans: ActionSpan[] = [];
  if (pathButton && shouldRevealAbsolutePathAction(hoveredAction, copiedAction)) {
    const label = secondaryPathActionLabel(hoveredAction, copiedAction);
    const labelWidth = visibleWidth(label);
    if (labelWidth <= width) {
      const start = clamp(pathButton.start + Math.floor((pathButton.width - labelWidth) / 2), 0, width - labelWidth);
      metricsRow = overlayAnsiAt(metricsCore, label, start, width);
      if (copiedAction !== ABSOLUTE_PATH_ACTION.id) {
        metricsSpans.push({id: ABSOLUTE_PATH_ACTION.id, start, end: start + labelWidth});
      }
    }
  }

  return {fileRow, metricsRow, fileSpans, metricsSpans};
}

function spanAt(spans: ReadonlyArray<ActionSpan>, column: number) {
  return spans.find((span) => column >= span.start && column < span.end)?.id ?? null;
}

const BLOCK_ACTION_SEPARATOR = '  ';
const FOCUS_BAR = '┃';

function blockActionLabel(action: (typeof BLOCK_ACTIONS)[number], copiedAction?: string) {
  return action.id === copiedAction ? successLabel(action.label) : action.label;
}

function blockActionsLine(actions: ReadonlyArray<(typeof BLOCK_ACTIONS)[number]>, hoveredAction?: string, copiedAction?: string) {
  return actions
    .map((action) => {
      const copied = action.id === copiedAction;
      const color = copied
        ? ANSI_GREEN_BOLD
        : action.id === hoveredAction
        ? ANSI_CYAN_BOLD
        : ANSI_GRAY;
      return `${color}${blockActionLabel(action, copiedAction)}${ANSI_RESET}`;
    })
    .join(BLOCK_ACTION_SEPARATOR);
}

export function findFocusedBlockLineIndex(
  rows: ReadonlyArray<Pick<SectionRow, 'kind'> | undefined>,
  section: Pick<DiffSection, 'startLine' | 'endLineExclusive'> | null,
  visibleTopLine: number,
) {
  if (!section || section.endLineExclusive <= section.startLine) {
    return null;
  }

  const clampedTop = clamp(visibleTopLine, section.startLine, section.endLineExclusive - 1);
  // A block whose frame opens the viewport is the one at the top, even
  // before its header row.
  for (let candidate = clampedTop; candidate < section.endLineExclusive; candidate += 1) {
    const kind = rows[candidate]?.kind;
    if (kind === 'header') return candidate;
    if (kind !== 'frame') break;
  }

  for (let candidate = clampedTop; candidate >= section.startLine; candidate -= 1) {
    if (rows[candidate]?.kind === 'header') {
      return candidate;
    }
  }

  for (let candidate = section.startLine; candidate < section.endLineExclusive; candidate += 1) {
    if (rows[candidate]?.kind === 'header') {
      return candidate;
    }
  }

  return null;
}

// Cells a block header label keeps before its actions: the glyph, then
// `<name>:<line>:` with the path's start dropped.
function blockLabelReservedWidth(label: string) {
  const tail = label.match(/:\d+:$/)?.[0] ?? '';
  return 2 + reservedNameWidth(label.slice(2, label.length - tail.length)) + visibleWidth(tail);
}

// Draws a block header row from its structured label: the collapse glyph, the
// path truncated from the start, and, when shown, the block actions with
// their spans in section-line columns. The label keeps `<name>:<line>:`, and
// actions that don't fit beside it are never drawn. The label leaves room for
// the actions that do fit even while they are hidden, so it does not move
// under the pointer when they appear on hover.
function renderBlockHeaderRow(
  row: DiffRow,
  collapsed: boolean,
  width: number,
  actions: {hovered?: string; copied?: string} | null,
  focused = false,
): {line: string; spans: ActionSpan[]} {
  const baseLabel = row.label ?? '•';
  const label = row.target ? `${collapsed ? '▸' : '▾'}${baseLabel.slice(1)}` : baseLabel;
  if (width < 4) {
    return {line: truncateAnsi(label, Math.max(width, 0)), spans: []};
  }

  const inner = width - 4;
  const drawnActions = fittingActions(
    BLOCK_ACTIONS,
    (action) => visibleWidth(blockActionLabel(action, actions?.copied)),
    BLOCK_ACTION_SEPARATOR.length,
    inner - blockLabelReservedWidth(label) - 1,
  );
  const right = blockActionsLine(drawnActions, actions?.hovered, actions?.copied);
  const rightWidth = visibleWidth(right);
  const fittedLabel = fitBlockHeaderLabel(label, drawnActions.length > 0 ? inner - rightWidth - 1 : inner);
  if (!actions || drawnActions.length === 0) {
    return {line: markFocusedHeader(frameLine(fittedLabel, inner, ANSI_CYAN), focused), spans: []};
  }

  const left = `${ANSI_CYAN}${fittedLabel}${ANSI_RESET}`;
  const content = composeLeftRight(left, right, inner);
  const spans: ActionSpan[] = [];
  // The section line is `│ content │`, so content starts at column 2.
  let column = 2 + visibleWidth(content) - rightWidth;
  for (const action of drawnActions) {
    const labelWidth = visibleWidth(blockActionLabel(action, actions.copied));
    spans.push({id: action.id, start: column, end: column + labelWidth});
    column += labelWidth + BLOCK_ACTION_SEPARATOR.length;
  }

  return {line: markFocusedHeader(frameLine(content, inner, ANSI_CYAN), focused), spans};
}

// The focused block's header row swaps its side bars for heavy ones, a mark
// that needs no colour and keeps every column in place.
function markFocusedHeader(line: string, focused: boolean) {
  if (!focused) return line;
  const left = line.indexOf('│');
  const right = line.lastIndexOf('│');
  if (left < 0 || right <= left) return line;
  return `${line.slice(0, left)}${FOCUS_BAR}${line.slice(left + 1, right)}${FOCUS_BAR}${line.slice(right + 1)}`;
}

function stripAnsi(line: string) {
  return line.replace(/\x1B\[[0-9;:]*[A-Za-z]/g, '');
}

// The first row of a block header's frame: the blank and border rows drawn
// above the header row belong to the same block.
function blockFrameStart(rows: ReadonlyArray<DiffRow>, headerLine: number) {
  const header = rows[headerLine]!;
  let start = headerLine;
  while (start > 0) {
    const previous = rows[start - 1];
    if (previous?.kind !== 'frame' || previous.block !== header.block || previous.sectionIndex !== header.sectionIndex) break;
    start -= 1;
  }

  return start;
}

// Names a block header for keyboard focus: its collapse key, or its row when
// the header has no parsed block behind it.
function blockFocusKey(rows: ReadonlyArray<DiffRow>, lineIndex: number) {
  return rows[lineIndex]?.target?.key ?? `row:${lineIndex}`;
}

function makeToast(message: string, hint?: string) {
  return hint ? `${message} · ${hint}` : message;
}

export function getTreeRowHitFromPanel(
  panelBounds: Bounds | null,
  x: number,
  y: number,
  {
    treeOffset,
    visibleTreeRows,
    rowsLength,
    contentWidth,
  }: {
    treeOffset: number;
    visibleTreeRows: number;
    rowsLength: number;
    contentWidth: number;
  },
) {
  if (!isInside(panelBounds, x, y) || !panelBounds) return null;

  // TreePane uses a one-cell border and one-cell horizontal padding.
  // Row 0 inside the panel is the top border, row 1 is "Changed files",
  // and changed-file rows start at row 2.
  const visibleIndex = y - panelBounds.top - 2;
  if (visibleIndex < 0 || visibleIndex >= visibleTreeRows) return null;

  const rowIndex = treeOffset + visibleIndex;
  if (rowIndex < 0 || rowIndex >= rowsLength) return null;

  const rowLeft = panelBounds.left + 2;
  if (x < rowLeft || x >= rowLeft + contentWidth) return null;

  return {
    rowIndex,
    relativeX: x - rowLeft,
    bounds: {
      left: rowLeft,
      top: y,
      width: contentWidth,
      height: 1,
    },
  };
}

function isTreeCopyTarget(relativeX: number, width: number) {
  return relativeX >= Math.max(0, width - 5);
}

function isTreeHeaderCopyTarget(panelBounds: Bounds | null, x: number, y: number, contentWidth: number, copied = false) {
  if (!isInside(panelBounds, x, y) || !panelBounds) return false;

  const headerY = panelBounds.top + 1;
  if (y !== headerY) return false;

  const rowLeft = panelBounds.left + 2;
  const actionLabel = treeHeaderActionLabel(false, copied);
  const actionStart = rowLeft + Math.max(0, contentWidth - visibleWidth(actionLabel));
  const copyStart = actionStart + visibleWidth(`${TREE_COLLAPSE_LABEL}  `);
  return x >= copyStart && x < rowLeft + contentWidth;
}

type SelectionSource = {
  lines: string[];
  rows: ReadonlyArray<Pick<SectionRow, 'kind'>>;
  sections: ReadonlyArray<Pick<KeyedSection, 'key' | 'startLine' | 'endLineExclusive'>>;
};

// A place in a section that media rows appearing, growing or going away do
// not move: `text` counts the section's non-media rows before it, and
// `mediaInto`, set only when the place is on a media row, is how far into
// that run of media rows it is. `atTop` marks the section's first row, which
// stays the first row whatever appears there. Without media rows, `text` is
// the offset into the section.
type TextAnchor = {text: number; mediaInto?: number; atTop?: true};

function textAnchor(
  rows: ReadonlyArray<Pick<SectionRow, 'kind'> | undefined>,
  section: Pick<DiffSection, 'startLine' | 'endLineExclusive'>,
  line: number,
): TextAnchor {
  let text = 0;
  let runStart = -1;
  const end = Math.min(line, section.endLineExclusive);
  for (let index = section.startLine; index < end; index += 1) {
    if (rows[index]?.kind === 'media') {
      if (runStart < 0) runStart = index;
    } else {
      text += 1;
      runStart = -1;
    }
  }

  // A line above the section, such as the previous file's trailing blank
  // row, is its top as well.
  const atTop = line <= section.startLine ? {atTop: true as const} : {};
  if (line < section.endLineExclusive && rows[line]?.kind === 'media') {
    return {text, mediaInto: line - (runStart < 0 ? line : runStart), ...atTop};
  }
  return {text, ...atTop};
}

// The line an anchor names in a section, or the section's last line when the
// section got shorter. A place inside a run of media rows that shrank lands
// on the run's last row; one whose run went away lands on the text after it.
// The top of a file stays the top of the file, so a file jumped to shows its
// picture when one appears there. Any other place follows its text, so the
// first text row under a picture stays put when the picture grows.
function lineForAnchor(
  rows: ReadonlyArray<Pick<SectionRow, 'kind'> | undefined>,
  section: Pick<DiffSection, 'startLine' | 'endLineExclusive'>,
  anchor: TextAnchor,
) {
  if (anchor.atTop) return section.startLine;
  const last = Math.max(section.startLine, section.endLineExclusive - 1);
  let text = 0;
  let index = section.startLine;
  // Past `anchor.text` text rows, to the first row after them.
  while (index < section.endLineExclusive && text < anchor.text) {
    if (rows[index]?.kind !== 'media') text += 1;
    index += 1;
  }
  if (text < anchor.text) return last;

  let runEnd = index;
  while (runEnd < section.endLineExclusive && rows[runEnd]?.kind === 'media') runEnd += 1;
  if (anchor.mediaInto === undefined || runEnd === index) return Math.min(runEnd, last);
  return Math.min(index + anchor.mediaInto, runEnd - 1);
}

function remapLineIndex(lineIndex: number, previous: SelectionSource, next: SelectionSource) {
  const section = previous.sections[getSectionIndexForLine(previous.sections, lineIndex)];
  if (!section || lineIndex < section.startLine || lineIndex >= section.endLineExclusive) return null;

  const target = next.sections.find((entry) => entry.key === section.key);
  if (!target) return null;

  const anchor = textAnchor(previous.rows, section, lineIndex);
  const mapped = lineForAnchor(next.rows, target, anchor);
  return mapped >= target.startLine && mapped < target.endLineExclusive && textAnchorsEqual(textAnchor(next.rows, target, mapped), anchor)
    ? mapped
    : null;
}

function textAnchorsEqual(left: TextAnchor, right: TextAnchor) {
  return left.text === right.text && left.mediaInto === right.mediaInto;
}

// Moves a selection to where its lines went after the rendered lines were
// rebuilt, or returns null when any selected line changed or moved apart.
function remapCodeSelection(selection: CodeSelection, previous: SelectionSource, next: SelectionSource): CodeSelection | null {
  const {start, end} = normalizeCodeSelection(selection);
  const mappedStart = remapLineIndex(start.lineIndex, previous, next);
  const mappedEnd = remapLineIndex(end.lineIndex, previous, next);
  if (mappedStart === null || mappedEnd === null) return null;

  const shift = mappedStart - start.lineIndex;
  if (mappedEnd - end.lineIndex !== shift) return null;
  for (let lineIndex = start.lineIndex; lineIndex <= end.lineIndex; lineIndex += 1) {
    if (previous.lines[lineIndex] !== next.lines[lineIndex + shift]) return null;
  }

  return {
    ...selection,
    anchor: {...selection.anchor, lineIndex: selection.anchor.lineIndex + shift},
    focus: {...selection.focus, lineIndex: selection.focus.lineIndex + shift},
    lines: next.lines,
  };
}

// Collapse keys for a file's blocks: the hunk's content without its line
// numbers, plus how many earlier blocks in the file have the same content, so
// a block keeps its key when an edit above it shifts its start line.
function blockCollapseKeys(file: ReviewFile) {
  const seen = new Map<string, number>();
  return file.blocks.map((block) => {
    const [header = '', ...body] = block.rawDiff.split('\n');
    const content = hashText(`${header.replace(/^@@ [^@]* @@/, '')}\n${body.join('\n')}`);
    const occurrence = seen.get(content) ?? 0;
    seen.set(content, occurrence + 1);
    return `${reviewFileKey(file)}\0${content}\0${occurrence}`;
  });
}

function resolveBlockTargets(rows: ReadonlyArray<SectionRow>, file: ReviewFile | undefined) {
  const targets: Array<BlockTarget | undefined> = [];
  const keys = file ? blockCollapseKeys(file) : [];
  for (const row of rows) {
    if (row.kind !== 'header') continue;
    // Delta's hunk headers and the parsed blocks come from the same diff in
    // the same order; the line-number check guards against a mismatch.
    const block = file?.blocks[row.block];
    targets[row.block] = file && block && block.lineStart === row.lineNumber
      ? {file, block, key: keys[row.block]!}
      : undefined;
  }

  return targets;
}

// Names a review file in every set and map the view keeps. It equals the
// path except for a name that failed to decode, so that file and a real file
// whose name is its escaped stand-in stay two files.
function reviewFileKey(file: Pick<ReviewFile, 'path' | 'pathError'>) {
  return fileKey({path: file.path, nameError: file.pathError});
}

// A section with the review file it shows and that file's key; a section
// with no file in the review is keyed by its path.
type KeyedSection = DiffSection & {key: string; file?: ReviewFile};

// Sections are built from the review's files in order, so the n-th section
// with a path shows the n-th file with that path. Two files share a path
// only when one name failed to decode.
function keySections(sections: DiffSection[], review: ReviewModel | undefined): KeyedSection[] {
  const filesByPath = new Map<string, ReviewFile[]>();
  for (const file of review?.files ?? []) {
    const files = filesByPath.get(file.path);
    if (files) files.push(file);
    else filesByPath.set(file.path, [file]);
  }

  const seen = new Map<string, number>();
  return sections.map((section) => {
    const occurrence = seen.get(section.path) ?? 0;
    seen.set(section.path, occurrence + 1);
    const file = filesByPath.get(section.path)?.[occurrence];
    return file ? {...section, key: reviewFileKey(file), file} : {...section, key: section.path};
  });
}

type ViewSection = KeyedSection & {
  rows: SectionRow[];
  blockTargets: Array<BlockTarget | undefined>;
  // Parallel to `rows`: the raw text of the code line a row starts.
  sources: Array<string | undefined>;
};

// The raw text of each code line, on the row that starts it. delta draws one
// row per hunk body line, in order; a block whose row count does not match its
// hunk gets no sources, and its selections copy the drawn text.
function resolveRowSources(rows: ReadonlyArray<SectionRow>, blockTargets: ReadonlyArray<BlockTarget | undefined>) {
  const sources: Array<string | undefined> = new Array(rows.length);
  const codeRows = new Map<number, number[]>();
  for (const [index, row] of rows.entries()) {
    if (row.kind !== 'body' || row.continuation || row.codeColumn === undefined || row.block < 0) continue;
    const blockRows = codeRows.get(row.block) ?? [];
    blockRows.push(index);
    codeRows.set(row.block, blockRows);
  }

  for (const [block, indexes] of codeRows) {
    const target = blockTargets[block];
    if (!target) continue;
    const sourceLines = blockSourceLines(target.block);
    if (sourceLines.length !== indexes.length) continue;
    for (const [ordinal, index] of indexes.entries()) {
      sources[index] = sourceLines[ordinal];
    }
  }

  return sources;
}

function applyCollapsedBlocks(
  sections: KeyedSection[],
  collapsedBlockIds: ReadonlySet<string>,
): ViewSection[] {
  let cursor = 0;

  return sections.map((section) => {
    const allRows = section.rows ?? section.lines.map((): SectionRow => ({block: -1, kind: 'body', continuation: false}));
    const blockTargets = resolveBlockTargets(allRows, section.file);
    const allSources = resolveRowSources(allRows, blockTargets);
    const isHidden = (row: SectionRow) => row.kind === 'body'
      && row.block >= 0
      && collapsedBlockIds.has(blockTargets[row.block]?.key ?? '');
    const collapsing = collapsedBlockIds.size > 0 && allRows.some(isHidden);
    const lines = collapsing ? section.lines.filter((_, index) => !isHidden(allRows[index]!)) : section.lines;
    const rows = collapsing ? allRows.filter((row) => !isHidden(row)) : allRows;
    const sources = collapsing ? allSources.filter((_, index) => !isHidden(allRows[index]!)) : allSources;
    const startLine = cursor;
    const endLineExclusive = cursor + lines.length;
    cursor = endLineExclusive;

    return {
      ...section,
      lines,
      rows,
      blockTargets,
      sources,
      startLine,
      endLineExclusive,
    };
  });
}

function buildDiffRows(sections: ViewSection[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const headerLines = new Map<number, number>();
    for (const [index, row] of section.rows.entries()) {
      if (row.kind === 'header') headerLines.set(row.block, section.startLine + index);
    }

    for (const [index, row] of section.rows.entries()) {
      const source = section.sources[index];
      rows.push({
        ...row,
        sectionIndex,
        headerLine: row.block >= 0 ? headerLines.get(row.block) ?? null : null,
        target: row.block >= 0 ? section.blockTargets[row.block] : undefined,
        ...(source === undefined ? {} : {source}),
      });
    }
  }

  return rows;
}

type TerminalSize = {columns: number; rows: number};

function readTerminalSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return {columns: stdout?.columns ?? 120, rows: stdout?.rows ?? 40};
}

// The terminal size, updated on every 'resize' so the layout follows it. Ink
// only re-lays out the last output on resize; it does not re-render.
function useTerminalSize(stdout: NodeJS.WriteStream | undefined) {
  const [size, setSize] = useState(() => readTerminalSize(stdout));
  useEffect(() => {
    if (!stdout) return undefined;
    const update = () => setSize((current) => {
      const next = readTerminalSize(stdout);
      return next.columns === current.columns && next.rows === current.rows ? current : next;
    });
    update();
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  return size;
}

// A file whose diff could not be built carries an `error` message. Read it
// without relying on the field being declared on ReviewFile.
function fileError(file: ReviewFile) {
  const error = (file as ReviewFile & {error?: unknown}).error;
  return typeof error === 'string' && error ? error : undefined;
}

// Puts an error row at the top of each section whose file failed to build,
// directly under the file header when the file is in view.
function addFileErrorRows(sections: KeyedSection[]) {
  if (!sections.some((section) => section.file && fileError(section.file))) return sections;

  return sections.map((section) => {
    const error = section.file && fileError(section.file);
    if (!error) return section;
    return {
      ...section,
      signature: `${section.signature ?? ''}\0${hashText(error)}`,
      lines: [`${ANSI_RED}✗ Could not load diff: ${toDisplayText(error)}${ANSI_RESET}`, ...section.lines],
    };
  });
}

// The footer's left text for a row of `width` cells: the status, then as many
// whole key hints as fit, always starting with `q quit`. A status too long to
// leave room for `q quit` is cut to fit before it.
export function footerHintText(status: string | undefined, width: number, items: ReadonlyArray<string> = KEY_HINT_ITEMS) {
  const prefix = status ? `${status}${KEY_HINT_SEPARATOR}` : '';
  for (let count = items.length; count > 0; count -= 1) {
    const text = `${prefix}${items.slice(0, count).join(KEY_HINT_SEPARATOR)}`;
    if (visibleWidth(text) <= width) return text;
  }

  const quit = `${status ? KEY_HINT_SEPARATOR : ''}${items[0] ?? KEY_HINT_ITEMS[0]!}`;
  return `${truncateEnd(status ?? '', Math.max(0, width - visibleWidth(quit)))}${quit}`;
}

type BarPart = {text: string; style: string};

function renderBarParts(parts: ReadonlyArray<BarPart>) {
  return parts.map((part) => (part.style && part.text ? `${part.style}${part.text}${ANSI_RESET}` : part.text)).join('');
}

function fitBarParts(parts: ReadonlyArray<BarPart>, width: number): BarPart[] {
  if (cellWidthOf(parts) <= width) return [...parts];

  // Cut the joined text once, then hand each part its slice of the result,
  // so the ellipsis lands where the text stops whichever part that is in.
  const cut = truncateEnd(parts.map((part) => part.text).join(''), width);
  const fitted: BarPart[] = [];
  let offset = 0;
  for (const part of parts) {
    if (offset >= cut.length) break;
    fitted.push({...part, text: cut.slice(offset, offset + part.text.length)});
    offset += part.text.length;
  }

  return fitted;
}

function cellWidthOf(parts: ReadonlyArray<BarPart>) {
  return parts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}

// Lays out one bar row (top bar or footer) in exactly `width` cells: the left
// parts first, the right label flush right when there is room for it, and
// everything truncated so the row can never wrap.
function composeBar(
  left: ReadonlyArray<BarPart>,
  right: BarPart | null,
  width: number,
  truncateRight: (text: string, width: number) => string,
) {
  const leftWidth = cellWidthOf(left);
  if (right?.text) {
    const rightWidth = visibleWidth(right.text);
    if (leftWidth + 1 + rightWidth <= width) {
      return `${renderBarParts(left)}${' '.repeat(width - leftWidth - rightWidth)}${renderBarParts([right])}`;
    }

    const budget = width - leftWidth - 1;
    if (budget >= MIN_BAR_RIGHT_WIDTH) {
      const fittedRight = truncateRight(right.text, budget);
      return `${renderBarParts(left)}${' '.repeat(width - leftWidth - visibleWidth(fittedRight))}${renderBarParts([{...right, text: fittedRight}])}`;
    }
  }

  return renderBarParts(fitBarParts(left, width));
}

type DiffPaneBodyProps = {
  paneWidth: number;
  paneHeight: number;
  contentWidth: number;
  borderAnsi: string;
  fileRow: string;
  metricsRow: string;
  hasChanges: boolean;
  emptyStateHint?: string;
  visibleDiffLines: string[];
  diffOffset: number;
  allDiffRows: DiffRow[];
  collapsedBlockIds: ReadonlySet<string>;
  arrivalAnimations: ArrivalAnimations;
  arrivalNow: number;
  fileArrival?: ArrivalEntry;
  actionBlockLineIndex: number | null;
  focusedBlockLineIndex: number | null;
  hoveredAction: HoveredAction;
  copiedAction: CopiedAction | null;
  selection: CodeSelection | null;
};

// The diff pane's rows. It renders inside DiffErrorBoundary, so a throw while
// drawing one file's diff stays in the pane.
function DiffPaneBody({
  paneWidth,
  paneHeight,
  contentWidth,
  borderAnsi,
  fileRow,
  metricsRow,
  hasChanges,
  emptyStateHint,
  visibleDiffLines,
  diffOffset,
  allDiffRows,
  collapsedBlockIds,
  arrivalAnimations,
  arrivalNow,
  fileArrival,
  actionBlockLineIndex,
  focusedBlockLineIndex,
  hoveredAction,
  copiedAction,
  selection,
}: DiffPaneBodyProps) {
  const inner = Math.max(1, paneWidth - 4);
  const rows: string[] = [
    frameTopBorder(paneWidth, borderAnsi),
    frameLine(applyArrivalWash(fileRow, fileArrival, arrivalNow), inner, borderAnsi),
    frameLine(metricsRow, inner, borderAnsi),
  ];
  if (!hasChanges) {
    rows.push(frameLine(`${ANSI_CYAN_BOLD}No changes to review${ANSI_RESET}`, inner, borderAnsi));
    rows.push(frameLine(`${ANSI_GRAY}${toDisplayText(emptyStateHint ?? 'Run again after making changes.')}${ANSI_RESET}`, inner, borderAnsi));
  }

  for (const [index, line] of visibleDiffLines.entries()) {
    const absoluteLineIndex = diffOffset + index;
    const row = allDiffRows[absoluteLineIndex];
    const blockTarget = row?.target;
    const blockArrival = blockTarget
      ? arrivalAnimations.blocks.get(blockAnimationKey(reviewFileKey(blockTarget.file), blockTarget.block))
      : undefined;
    let visibleLine = line || ' ';
    if (row?.kind === 'header') {
      const showActions = actionBlockLineIndex === absoluteLineIndex;
      visibleLine = renderBlockHeaderRow(
        row,
        Boolean(blockTarget && collapsedBlockIds.has(blockTarget.key)),
        contentWidth,
        showActions
          ? {
            hovered: hoveredAction?.kind === 'block' && hoveredAction.lineIndex === absoluteLineIndex ? hoveredAction.id : undefined,
            copied: copiedAction?.kind === 'block' && copiedAction.lineIndex === absoluteLineIndex ? copiedAction.id : undefined,
          }
          : null,
        focusedBlockLineIndex === absoluteLineIndex,
      ).line;
    }

    const selectedLine = highlightSelectedCode(visibleLine, row, absoluteLineIndex, selection);
    const arrivalLine = applyArrivalWash(selectedLine, blockArrival, arrivalNow);
    const paneRow = frameLine(arrivalLine, inner, borderAnsi);
    // With the focused block's header scrolled off the top, the top row's
    // pane border turns heavy, so the block that block keys act on stays marked.
    const marksFocus = index === 0 && focusedBlockLineIndex !== null && focusedBlockLineIndex < diffOffset;
    rows.push(marksFocus ? paneRow.replace('│', FOCUS_BAR) : paneRow);
  }
  // A diff shorter than the pane still draws the pane's full height, so the
  // bottom border lines up with the tree pane's.
  while (rows.length < paneHeight - 1) {
    rows.push(frameLine('', inner, borderAnsi));
  }
  rows.push(frameBottomBorder(paneWidth, borderAnsi));

  // Every row is padded to the pane width in terminal cells; truncate so a
  // row can never soft-wrap and push later rows out of the pane.
  return <>{rows.map((row, i) => <Text key={`diff-${i}`} wrap="truncate">{row}</Text>)}</>;
}

function AppContent({
  base,
  branch,
  sections: rawSections,
  branchMetrics,
  review,
  copyWriter,
  readFileContent,
  resolveAbsolutePath,
  repoRoot = process.cwd(),
  worktreeBranchName,
  dimensions,
  watchStatus,
  emptyStateHint,
  animations = false,
  graphics,
  addMediaRows,
}: AppProps) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const mouse = useMouse();
  const topBarRef = useRef<DOMElement>(null);
  const terminalSize = useTerminalSize(stdout);
  const columns = dimensions?.columns ?? terminalSize.columns;
  const terminalRows = dimensions?.rows ?? terminalSize.rows;
  const tooSmall = columns < MIN_TERMINAL_COLUMNS || terminalRows < MIN_TERMINAL_ROWS;
  // Below the width both panes need, the tree stays collapsed.
  const treeAutoCollapsed = columns < MIN_TREE_WIDTH + MIN_DIFF_WIDTH;

  const [treeWidthOverride, setTreeWidthOverride] = useState<number | null>(null);
  const [treeCollapsedByUser, setTreeCollapsed] = useState(false);
  const treeCollapsed = treeCollapsedByUser || treeAutoCollapsed;
  const treeWidthLimits = useMemo(() => getTreeWidthLimits(columns), [columns]);
  const leftWidth = treeCollapsed
    ? COLLAPSED_TREE_WIDTH
    : clamp(treeWidthOverride ?? defaultTreeWidth(columns), treeWidthLimits.min, treeWidthLimits.max);
  const rightWidth = Math.max(MIN_DIFF_WIDTH, columns - leftWidth);
  const diffContentWidth = Math.max(1, rightWidth - 4);
  const treeContentWidth = Math.max(1, leftWidth - 4);
  const contentHeight = Math.max(terminalRows - CHROME_ROWS, DIFF_PANE_OVERHEAD + MIN_DIFF_ROWS);
  // Tree has 2 borders + 1 header row; diff has 2 borders + 2 (filename + metrics).
  const visibleTreeRows = contentHeight - 3;
  const visibleDiffRows = contentHeight - DIFF_PANE_OVERHEAD;

  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(() => new Set());
  const wrappedSectionCacheRef = useRef<Map<string, WrappedSectionCacheEntry>>(new Map());
  const keyedSections = useMemo(() => keySections(rawSections, review), [rawSections, review]);
  const displaySections = useMemo(() => addFileErrorRows(keyedSections), [keyedSections]);
  const wrapWidth = useSettledValue(diffContentWidth, WRAP_SETTLE_MS);
  const wrappedSections = useMemo(
    () => wrapSectionsWithCache(displaySections, wrapWidth, wrappedSectionCacheRef.current),
    [displaySections, wrapWidth],
  );
  const mediaSections = useMemo(
    () => addMediaRows ? addMediaRows(wrappedSections, {innerWidth: wrapWidth, viewportRows: visibleDiffRows}) : wrappedSections,
    [addMediaRows, visibleDiffRows, wrapWidth, wrappedSections],
  );
  const sections = useMemo(
    () => applyCollapsedBlocks(mediaSections, collapsedBlockIds),
    [collapsedBlockIds, mediaSections],
  );

  const files = useMemo(() => sections.map((section) => ({path: section.path, key: section.key})), [sections]);
  const statusByKey = useMemo(() => new Map(review?.files.map((file) => [reviewFileKey(file), file.status]) ?? []), [review]);
  const [collapsedTreePaths, setCollapsedTreePaths] = useState<Set<string>>(() => new Set());
  const allTreeRows = useMemo(() => buildTreeRows(files, statusByKey), [files, statusByKey]);
  const rows = useMemo(() => applyTreeCollapse(allTreeRows, collapsedTreePaths), [allTreeRows, collapsedTreePaths]);
  const allDiffLines = useMemo(() => flattenSectionLines(sections), [sections]);
  const allDiffRows = useMemo(() => buildDiffRows(sections), [sections]);
  // Counts rebuilds of the rendered sections, so a render failure in the diff
  // pane is retried after every refresh.
  const sectionsRevisionRef = useRef(0);
  const sectionsRevision = useMemo(() => {
    sectionsRevisionRef.current += 1;
    return sectionsRevisionRef.current;
  }, [sections]);

  const maxDiffOffset = Math.max(allDiffLines.length - visibleDiffRows, 0);
  // A jump puts a file's first line at the top even when the rest of the diff
  // is shorter than the viewport. Every scroll uses this one ceiling, so the
  // next scroll after such a jump doesn't snap the view back up.
  const scrollCeiling = Math.max(maxDiffOffset, sections.at(-1)?.startLine ?? 0);
  const maxTreeOffset = Math.max(rows.length - visibleTreeRows, 0);

  const treePanelRef = useRef<DOMElement>(null);
  const diffPanelRef = useRef<DOMElement>(null);
  const [diffOffset, setDiffOffset] = useState(0);
  // Set by [ and ]: the block they moved to stays focused while the view
  // stays where they put it, even when the ceiling kept its header off the top,
  // and while its header row is still at `line`. A refresh that moves the
  // header hands focus back to the block at the top of the viewport.
  const [blockFocus, setBlockFocus] = useState<{key: string; offset: number; line: number} | null>(null);
  const [treeOffset, setTreeOffset] = useState(0);
  const [treeHovered, setTreeHovered] = useState(false);
  const [diffHovered, setDiffHovered] = useState(false);
  const [treeResizeHovered, setTreeResizeHovered] = useState(false);
  const [treeResizing, setTreeResizing] = useState(false);
  const treeResizingRef = useRef(false);
  const treeResizeMovedRef = useRef(false);
  const treeResizeStartRef = useRef<{mouseX: number; width: number} | null>(null);
  const [treeToggleHovered, setTreeToggleHovered] = useState(false);
  const [hoveredTreeRow, setHoveredTreeRow] = useState<number | null>(null);
  const [hoveredBlockLineIndex, setHoveredBlockLineIndex] = useState<number | null>(null);
  const [hoveredAction, setHoveredAction] = useState<HoveredAction>(null);
  const [infoTip, setInfoTip] = useState<string | null>(null);
  const [treeTooltip, setTreeTooltip] = useState<TreeTooltip | null>(null);
  const treeTooltipRef = useRef<TreeTooltip | null>(null);
  const pendingTreeTooltipRef = useRef<TreeTooltip | null>(null);
  const treeTooltipTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [copiedAction, setCopiedAction] = useState<CopiedAction | null>(null);
  const [codeSelection, setCodeSelectionState] = useState<CodeSelection | null>(null);
  const codeSelectionRef = useRef<CodeSelection | null>(null);
  const renderedCodeSelectionRef = useRef<CodeSelection | null>(null);
  const pendingCodeSelectionRef = useRef<CodeSelection | null>(null);
  const codeSelectionRenderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastCodeSelectionRenderAtRef = useRef(0);
  const [toast, setToast] = useState<Toast | null>(null);
  // Armed from mount: replies the detection gave up on wait in stdin until
  // Ink first reads it.
  const [escapeGuard] = useState(() => createLoneEscapeGuard({
    armedUntil: graphics?.detectionTimedOut ? Date.now() + LATE_REPLY_WINDOW_MS : 0,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    replyHead: graphics?.replyHead,
    keysBeforeReply: graphics?.keysBeforeReply,
  }));
  useEffect(() => () => escapeGuard.dispose(), [escapeGuard]);
  // Where the view was, as a file and a place in it that media rows do not
  // move, so rebuilt sections can put the same text back at the top.
  const viewSnapshotRef = useRef<{key: string; sectionIndex: number; anchor: TextAnchor}>({
    key: '',
    sectionIndex: 0,
    anchor: {text: 0, atTop: true},
  });
  const arrivalSnapshotRef = useRef<ArrivalSnapshot | null>(null);
  const [arrivalAnimations, setArrivalAnimations] = useState<ArrivalAnimations>(() => ({
    files: new Map(),
    blocks: new Map(),
  }));
  const [arrivalNow, setArrivalNow] = useState(0);
  const arrivalActive = hasArrivalAnimations(arrivalAnimations);

  const topSectionIndex = getPrimaryVisibleSectionIndex(
    sections,
    allDiffLines,
    allDiffRows,
    diffOffset,
    diffOffset + visibleDiffRows,
  );
  const activeSectionIndex = topSectionIndex;
  const activeSection = activeSectionIndex >= 0 ? sections[activeSectionIndex] : null;
  const activeFilePath = activeSection?.path ?? '';
  const activeFileKey = activeSection?.key ?? '';
  const activeTreeId = useMemo(() => findTreeSelectionId(rows, activeFileKey), [activeFileKey, rows]);
  const activeRowIndex = rows.findIndex((row) => row.id === activeTreeId);
  const activeFile = activeSection?.file;
  const headerLineIndexes = useMemo(
    () => allDiffRows.flatMap((row, index) => (row.kind === 'header' ? [index] : [])),
    [allDiffRows],
  );
  const focusedBlockLineIndex = useMemo(() => {
    if (
      blockFocus
      && blockFocus.offset === diffOffset
      && allDiffRows[blockFocus.line]?.kind === 'header'
      && blockFocusKey(allDiffRows, blockFocus.line) === blockFocus.key
    ) {
      return blockFocus.line;
    }

    return findFocusedBlockLineIndex(allDiffRows, activeSection, diffOffset);
  }, [activeSection, allDiffRows, blockFocus, diffOffset]);
  const focusedBlock = focusedBlockLineIndex === null
    ? activeFile?.blocks[0]
    : allDiffRows[focusedBlockLineIndex]?.target?.block;
  const displayBranch = toDisplayText(branch);
  const displayBase = toDisplayText(base);

  const fileHover = hoveredAction?.kind === 'file-header' ? hoveredAction.id : undefined;
  const fileCopied = copiedAction?.kind === 'file-header' ? copiedAction.id : undefined;
  const diffHeader = buildDiffHeader({
    path: activeFilePath,
    status: activeFile?.status,
    showActions: Boolean(review) && sections.length > 0,
    hoveredAction: fileHover,
    copiedAction: fileCopied,
    metricsCore: activeSection
      ? `${formatMetrics(activeSection.metrics)}  ${ANSI_GRAY}file ${activeSectionIndex + 1}/${sections.length}${ANSI_RESET}`
      : `${ANSI_GRAY}No changes to review${ANSI_RESET}`,
    width: diffContentWidth,
  });
  const diffHeaderRef = useRef(diffHeader);
  diffHeaderRef.current = diffHeader;

  const stateRef = useRef({
    treeOffset,
    maxTreeOffset,
    scrollCeiling,
    visibleTreeRows,
    rows,
    treeContentWidth,
  });
  stateRef.current = {treeOffset, maxTreeOffset, scrollCeiling, visibleTreeRows, rows, treeContentWidth};

  useEffect(() => {
    treeTooltipRef.current = treeTooltip;
  }, [treeTooltip]);

  useLayoutEffect(() => {
    if (!animations) {
      arrivalSnapshotRef.current = null;
      setArrivalAnimations((current) => hasArrivalAnimations(current) ? {files: new Map(), blocks: new Map()} : current);
      return;
    }

    const nextSnapshot = buildArrivalSnapshot(review, keyedSections);
    const previousSnapshot = arrivalSnapshotRef.current;
    arrivalSnapshotRef.current = nextSnapshot;

    if (!previousSnapshot) {
      return;
    }

    const now = Date.now();
    const nextAnimations = diffArrivalSnapshots(previousSnapshot, nextSnapshot, now);
    if (!hasArrivalAnimations(nextAnimations)) {
      return;
    }

    setArrivalNow(now);
    setArrivalAnimations(nextAnimations);
  }, [animations, rawSections, review]);

  useEffect(() => {
    if (!arrivalActive) return undefined;

    const interval = setInterval(() => {
      const now = Date.now();
      setArrivalNow(now);
      setArrivalAnimations((current) => pruneArrivalAnimations(current, now));
    }, ARRIVAL_ANIMATION_TICK_MS);

    return () => clearInterval(interval);
  }, [arrivalActive]);

  useEffect(() => () => {
    if (treeTooltipTimerRef.current) {
      clearTimeout(treeTooltipTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const availableDirectories = new Set(
      allTreeRows.filter((row) => row.kind === 'dir').map((row) => row.path),
    );

    setCollapsedTreePaths((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const treePath of current) {
        if (availableDirectories.has(treePath)) {
          next.add(treePath);
        } else {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [allTreeRows]);

  useEffect(() => {
    const availableBlockIds = new Set(review?.files.flatMap(blockCollapseKeys) ?? []);
    setCollapsedBlockIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const blockId of current) {
        if (availableBlockIds.has(blockId)) {
          next.add(blockId);
        } else {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [review]);

  const visibleRows = rows.slice(treeOffset, treeOffset + visibleTreeRows);
  const visibleDiffLines = allDiffLines.slice(diffOffset, diffOffset + visibleDiffRows);

  useEffect(() => {
    const snapshot = viewSnapshotRef.current;
    if (!snapshot.key || sections.length === 0) {
      setDiffOffset((current) => clamp(current, 0, scrollCeiling));
      return;
    }

    const preservedSection = sections.find((section) => section.key === snapshot.key);
    const fallbackSection = sections[clamp(snapshot.sectionIndex, 0, sections.length - 1)];
    const nextSection = preservedSection ?? fallbackSection;
    if (!nextSection) {
      setDiffOffset(0);
      return;
    }

    // The place in the old file means nothing in another file, so a file
    // that replaces a removed one opens at its top. Never past the ceiling
    // every scroll uses: lines that moved into an earlier file can leave the
    // old spot past it.
    const nextOffset = Math.min(
      preservedSection ? lineForAnchor(allDiffRows, nextSection, snapshot.anchor) : nextSection.startLine,
      scrollCeiling,
    );

    setDiffOffset((current) => current === nextOffset ? current : nextOffset);
  }, [allDiffRows, sections, scrollCeiling]);

  useEffect(() => {
    viewSnapshotRef.current = {
      key: activeFileKey,
      sectionIndex: activeSectionIndex,
      anchor: activeSection ? textAnchor(allDiffRows, activeSection, diffOffset) : {text: 0, atTop: true},
    };
  }, [activeFileKey, activeSection, activeSectionIndex, allDiffRows, diffOffset]);

  useEffect(() => {
    setDiffOffset((current) => clamp(current, 0, scrollCeiling));
  }, [scrollCeiling]);

  useEffect(() => {
    setTreeOffset((current) => {
      const clamped = clamp(current, 0, maxTreeOffset);
      return ensureVisible(activeRowIndex, clamped, visibleTreeRows);
    });
  }, [activeRowIndex, maxTreeOffset, visibleTreeRows]);

  // Every scroll except [ and ] hands focus back to the block at the top.
  const scrollDiffTo = useCallback((offset: number | ((current: number) => number)) => {
    setBlockFocus(null);
    setDiffOffset(offset);
  }, []);

  // `key` names the file as its tree row does.
  const jumpToFile = useCallback((key: string) => {
    const section = sections.find((entry) => entry.key === key);
    if (section) {
      scrollDiffTo(section.startLine);
    }
  }, [scrollDiffTo, sections]);

  const jumpToSection = useCallback((sectionIndex: number) => {
    const section = sections[clamp(sectionIndex, 0, sections.length - 1)];
    if (section) {
      scrollDiffTo(section.startLine);
    }
  }, [scrollDiffTo, sections]);

  // Moves to the next or previous block header and puts its frame at the top
  // of the viewport, as far as the scroll ceiling allows.
  const moveBlockFocus = useCallback((direction: 1 | -1) => {
    const current = focusedBlockLineIndex ?? (direction > 0 ? diffOffset - 1 : diffOffset);
    const target = direction > 0
      ? headerLineIndexes.find((line) => line > current)
      : [...headerLineIndexes].reverse().find((line) => line < current);
    if (target === undefined) return;

    const offset = clamp(blockFrameStart(allDiffRows, target), 0, scrollCeiling);
    setDiffOffset(offset);
    setBlockFocus({key: blockFocusKey(allDiffRows, target), offset, line: target});
  }, [allDiffRows, diffOffset, focusedBlockLineIndex, headerLineIndexes, scrollCeiling]);

  const toggleTreeDirectory = useCallback((directoryPath: string) => {
    setCollapsedTreePaths((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }

      return next;
    });
  }, []);

  const toggleBlock = useCallback((blockId: string) => {
    setCollapsedBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }

      return next;
    });
  }, []);

  // Enter and Space: collapses or expands the focused block. A header that has
  // scrolled off the top is brought back first, and the block stays focused
  // where the view lands, so the next Enter acts on the same block.
  const toggleFocusedBlock = useCallback(() => {
    if (focusedBlockLineIndex === null) return;
    const header = allDiffRows[focusedBlockLineIndex];
    const target = header?.target;
    const section = header ? sections[header.sectionIndex] : undefined;
    if (!header || !target || !section) return;

    let offset = focusedBlockLineIndex < diffOffset ? blockFrameStart(allDiffRows, focusedBlockLineIndex) : diffOffset;
    if (!collapsedBlockIds.has(target.key)) {
      // Collapsing removes the block's body rows, which can lower the scroll
      // ceiling; land where the ceiling will hold the view.
      const hidden = allDiffRows.filter((row) => row.sectionIndex === header.sectionIndex && row.block === header.block && row.kind === 'body').length;
      const lastStart = (sections.at(-1)?.startLine ?? 0) - (header.sectionIndex < sections.length - 1 ? hidden : 0);
      offset = clamp(offset, 0, Math.max(allDiffLines.length - hidden - visibleDiffRows, 0, lastStart));
    }

    // The rebuilt sections restore the view from this snapshot.
    viewSnapshotRef.current = {
      key: section.key,
      sectionIndex: header.sectionIndex,
      anchor: textAnchor(allDiffRows, section, offset),
    };
    setDiffOffset(offset);
    setBlockFocus({key: blockFocusKey(allDiffRows, focusedBlockLineIndex), offset, line: focusedBlockLineIndex});
    toggleBlock(target.key);
  }, [allDiffLines.length, allDiffRows, collapsedBlockIds, diffOffset, focusedBlockLineIndex, sections, toggleBlock, visibleDiffRows]);

  const getTreeRowHit = useCallback((x: number, y: number) => getTreeRowHitFromPanel(
    getBounds(treePanelRef),
    x,
    y,
    {
      treeOffset: stateRef.current.treeOffset,
      visibleTreeRows: stateRef.current.visibleTreeRows,
      rowsLength: stateRef.current.rows.length,
      contentWidth: stateRef.current.treeContentWidth,
    },
  ), []);

  const showToast = useCallback((message: string, hint?: string, kind: ToastKind = 'success') => {
    setToast({text: toDisplayText(makeToast(message, hint)), kind});
  }, []);

  const toggleTree = useCallback(() => {
    if (treeAutoCollapsed) {
      showToast('The file tree needs a wider terminal', `at least ${MIN_TREE_WIDTH + MIN_DIFF_WIDTH} columns`, 'info');
      return;
    }

    setTreeCollapsed((current) => !current);
  }, [showToast, treeAutoCollapsed]);

  const resizeTreeToMouse = useCallback((mouseX: number) => {
    const start = treeResizeStartRef.current;
    if (!start) return;

    const nextWidth = start.width + mouseX - start.mouseX;
    if (nextWidth <= treeWidthLimits.min) {
      setTreeCollapsed(true);
      setTreeWidthOverride(treeWidthLimits.min);
      return;
    }

    setTreeCollapsed(false);
    setTreeWidthOverride(clamp(nextWidth, treeWidthLimits.min, treeWidthLimits.max));
  }, [treeWidthLimits.max, treeWidthLimits.min]);

  const clearTreeTooltip = useCallback(() => {
    if (treeTooltipTimerRef.current) {
      clearTimeout(treeTooltipTimerRef.current);
      treeTooltipTimerRef.current = null;
    }

    pendingTreeTooltipRef.current = null;
    treeTooltipRef.current = null;
    setTreeTooltip((current) => current ? null : current);
  }, []);

  useEffect(() => {
    if (!treeHovered) {
      clearTreeTooltip();
    }
  }, [clearTreeTooltip, treeHovered]);

  const scheduleTreeTooltip = useCallback((nextTooltip: TreeTooltip | null) => {
    if (!nextTooltip) {
      clearTreeTooltip();
      return;
    }

    if (treeTooltipsEqual(treeTooltipRef.current, nextTooltip)) {
      return;
    }

    if (treeTooltipsEqual(pendingTreeTooltipRef.current, nextTooltip)) {
      return;
    }

    if (treeTooltipTimerRef.current) {
      clearTimeout(treeTooltipTimerRef.current);
    }

    pendingTreeTooltipRef.current = nextTooltip;
    treeTooltipRef.current = null;
    setTreeTooltip((current) => current ? null : current);
    treeTooltipTimerRef.current = setTimeout(() => {
      const pending = pendingTreeTooltipRef.current;
      treeTooltipTimerRef.current = null;
      pendingTreeTooltipRef.current = null;

      if (!pending) {
        return;
      }

      treeTooltipRef.current = pending;
      setTreeTooltip(pending);
    }, TREE_TOOLTIP_DELAY_MS);
  }, [clearTreeTooltip]);

  const renderCodeSelection = useCallback((selection: CodeSelection | null) => {
    if (codeSelectionsEqual(renderedCodeSelectionRef.current, selection)) {
      return;
    }

    renderedCodeSelectionRef.current = selection;
    setCodeSelectionState(selection);
  }, []);

  const setCodeSelection = useCallback((selection: CodeSelection | null) => {
    if (codeSelectionsEqual(codeSelectionRef.current, selection)) {
      return;
    }

    codeSelectionRef.current = selection;
    pendingCodeSelectionRef.current = null;
    if (codeSelectionRenderTimerRef.current) {
      clearTimeout(codeSelectionRenderTimerRef.current);
      codeSelectionRenderTimerRef.current = null;
    }

    lastCodeSelectionRenderAtRef.current = Date.now();
    renderCodeSelection(selection);
  }, [renderCodeSelection]);

  const scheduleCodeSelection = useCallback((selection: CodeSelection | null) => {
    if (codeSelectionsEqual(codeSelectionRef.current, selection)) {
      return;
    }

    codeSelectionRef.current = selection;
    pendingCodeSelectionRef.current = selection;

    const now = Date.now();
    const elapsed = now - lastCodeSelectionRenderAtRef.current;
    const delay = Math.max(0, CODE_SELECTION_RENDER_INTERVAL_MS - elapsed);
    if (delay === 0) {
      pendingCodeSelectionRef.current = null;
      lastCodeSelectionRenderAtRef.current = now;
      renderCodeSelection(selection);
      return;
    }

    if (!codeSelectionRenderTimerRef.current) {
      codeSelectionRenderTimerRef.current = setTimeout(() => {
        codeSelectionRenderTimerRef.current = null;
        const nextSelection = pendingCodeSelectionRef.current;
        pendingCodeSelectionRef.current = null;
        lastCodeSelectionRenderAtRef.current = Date.now();
        renderCodeSelection(nextSelection);
      }, delay);
    }
  }, [renderCodeSelection]);

  useEffect(() => () => {
    if (codeSelectionRenderTimerRef.current) {
      clearTimeout(codeSelectionRenderTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(null), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!copiedAction) return undefined;
    const timeout = setTimeout(() => setCopiedAction(null), COPY_SUCCESS_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [copiedAction]);

  const runCopyCommand = useCallback(async (
    commandId: string,
    commandFile = activeFile,
    commandBlock = focusedBlock,
    successAction?: CopiedAction,
  ) => {
    if (!review || !commandFile) {
      showToast('Copy action unavailable.', undefined, 'error');
      return;
    }

    // Every block copy passes the block's own file as `commandFile`; a file
    // copy may pass a focused block from another file, which then gets none.
    const blockOwner = !commandBlock || commandFile.blocks.includes(commandBlock) ? commandFile : undefined;
    const result = await executeCopyCommand(commandId, {
      model: review,
      activeFile: commandFile,
      focusedBlock: commandBlock,
      ...(blockOwner ? {focusedBlockFile: blockOwner} : {}),
      readFileContent,
      resolveAbsolutePath,
    }, copyWriter ? {write: copyWriter} : {});

    if (result.ok && successAction) {
      setCopiedAction(successAction);
    }

    showToast(result.toast, result.hint, result.ok ? 'success' : 'error');
  }, [activeFile, copyWriter, focusedBlock, readFileContent, resolveAbsolutePath, review, showToast]);

  const copyFileTree = useCallback(async () => {
    // A name that is not UTF-8 is shown as an escaped stand-in that names no
    // real file, so the whole tree is refused with that file's reason.
    const unnamed = review?.files.find((file) => file.pathError !== undefined);
    if (unnamed) {
      showToast('Copy action unavailable.', `${unnamed.pathError}: ${unnamed.path}`, 'error');
      return;
    }

    const text = formatTreePayload(allTreeRows, repoRoot);

    try {
      const result = await (copyWriter ?? writeClipboard)(text);
      if (result.ok) {
        setCopiedAction({kind: 'tree-header', id: 'copy.tree'});
        showToast('Copied file tree', `${files.length} files`);
      } else {
        showToast(result.message, result.hint, 'error');
      }
    } catch (error) {
      showToast('Clipboard write failed.', error instanceof Error ? error.message : undefined, 'error');
    }
  }, [allTreeRows, copyWriter, files.length, repoRoot, review, showToast]);

  // The rendered lines that mouse selection reads, set on every render. React
  // re-subscribes the mouse handlers in an effect after each commit; reading
  // through this ref, a handler that runs before that still sees the lines on
  // screen, so a selection always indexes the current lines and the layout
  // effect below is the one place that moves or drops it when they change.
  const selectionViewRef = useRef({lines: allDiffLines, rows: allDiffRows, offset: diffOffset, sections, review});
  selectionViewRef.current = {lines: allDiffLines, rows: allDiffRows, offset: diffOffset, sections, review};

  const getCodeSelectionPoint = useCallback((mousePosition: {x: number; y: number}) => {
    const {lines, rows, offset} = selectionViewRef.current;
    const diffBounds = getBounds(diffPanelRef);
    if (!isInside(diffBounds, mousePosition.x, mousePosition.y) || !diffBounds) return null;

    const relativeY = mousePosition.y - diffBounds.top;
    if (relativeY < 3) return null;

    const lineIndex = offset + relativeY - 3;
    if (lineIndex < 0 || lineIndex >= lines.length) return null;

    const innerColumn = mousePosition.x - diffBounds.left - 2;
    const row = rows[lineIndex];
    const code = getCodeContent(lines[lineIndex] ?? '', row);
    // A press on a +/- marker starts the selection at the code after it.
    if (!code || innerColumn < code.start - (row?.markerWidth ?? 0)) return null;

    return {
      lineIndex,
      column: clamp(innerColumn - code.start, 0, code.width),
    };
  }, []);

  const cancelCodeSelection = useCallback((notify: boolean) => {
    setCodeSelection(null);
    if (notify) {
      showToast('Selection cancelled', 'the diff changed while selecting', 'info');
    }
  }, [setCodeSelection, showToast]);

  // A refresh, collapse or resize rebuilds the rendered lines. Keep the
  // selection on the same lines when they moved unchanged, otherwise drop it,
  // so a highlight or copy never lands on lines that were not selected.
  const selectionSourceRef = useRef<SelectionSource>({lines: allDiffLines, rows: allDiffRows, sections});
  useLayoutEffect(() => {
    const previous = selectionSourceRef.current;
    const next = {lines: allDiffLines, rows: allDiffRows, sections};
    selectionSourceRef.current = next;

    const selection = codeSelectionRef.current;
    if (!selection || selection.lines === allDiffLines) return;

    const remapped = selection.lines === previous.lines ? remapCodeSelection(selection, previous, next) : null;
    if (remapped) {
      setCodeSelection(remapped);
    } else {
      cancelCodeSelection(selection.active);
    }
  }, [allDiffLines, allDiffRows, cancelCodeSelection, sections, setCodeSelection]);

  const copyCodeSelection = useCallback(async (selection: CodeSelection) => {
    if (compareSelectionPoints(selection.anchor, selection.focus) === 0) {
      setCodeSelection(null);
      return;
    }

    const {lines, rows, sections: viewSections} = selectionViewRef.current;
    const text = getSelectedCodeText(lines, rows, selection);
    if (!text) {
      setCodeSelection(null);
      return;
    }

    // The drawn text of a file whose diff is not exact (not UTF-8, or failed
    // to load) is not its bytes; copy nothing, as the keyboard copies do.
    const reason = selectionCopyError(rows, viewSections, selection);
    if (reason !== undefined) {
      showToast('Copy action unavailable.', reason, 'error');
      return;
    }

    try {
      const result = await (copyWriter ?? writeClipboard)(text);
      if (result.ok) {
        const lineCount = text.split('\n').length;
        showToast('Copied selection', lineCount === 1 ? `${text.length} chars` : `${lineCount} lines`);
      } else {
        showToast(result.message, result.hint, 'error');
      }
    } catch (error) {
      showToast('Clipboard write failed.', error instanceof Error ? error.message : undefined, 'error');
    }
  }, [copyWriter, setCodeSelection, showToast]);

  // Spans of a header row laid out with its actions shown; hovering a header
  // shows them, so hover hit-tests against this layout.
  const blockHeaderSpans = useCallback((lineIndex: number) => {
    const row = allDiffRows[lineIndex];
    if (row?.kind !== 'header') return [];
    return renderBlockHeaderRow(row, false, diffContentWidth, {}).spans;
  }, [allDiffRows, diffContentWidth]);

  useEffect(() => {
    const handleScroll = (position: {x: number; y: number}, direction: 'scrollup' | 'scrolldown' | null) => {
      if (direction !== 'scrollup' && direction !== 'scrolldown') return;
      const mousePosition = normalizeMousePosition(position);
      const delta = direction === 'scrollup' ? -SCROLL_STEP : SCROLL_STEP;

      const treeBounds = getBounds(treePanelRef);
      if (isInside(treeBounds, mousePosition.x, mousePosition.y)) {
        setTreeOffset((current) => applyScrollDelta(current, stateRef.current.maxTreeOffset, delta));
        return;
      }

      const diffBounds = getBounds(diffPanelRef);
      if (isInside(diffBounds, mousePosition.x, mousePosition.y)) {
        scrollDiffTo((current) => applyScrollDelta(current, stateRef.current.scrollCeiling, delta));
      }
    };

    mouse.events.on('scroll', handleScroll);
    return () => mouse.events.off('scroll', handleScroll);
  }, [mouse, scrollDiffTo]);

  useEffect(() => {
    const handlePosition = (position: {x: number; y: number}) => {
      if (codeSelectionRef.current?.active) {
        if (hoveredAction !== null) {
          setHoveredAction(null);
        }

        if (hoveredBlockLineIndex !== null) {
          setHoveredBlockLineIndex(null);
        }

        setInfoTip((current) => (current ? null : current));
        clearTreeTooltip();
        return;
      }

      const mousePosition = normalizeMousePosition(position);
      const topBarBounds = getBounds(topBarRef);
      let nextInfoTip: string | null = null;
      if (
        worktreeBranchName
        && isWorktreeLabelTarget(topBarBounds, mousePosition.x, mousePosition.y, displayBranch)
      ) {
        nextInfoTip = `current branch ${toDisplayText(worktreeBranchName)}`;
      } else if (isBaseLabelTarget(topBarBounds, mousePosition.x, mousePosition.y, displayBranch, displayBase)) {
        nextInfoTip = `comparison base ${displayBase}`;
      }

      let nextHoveredAction: HoveredAction = null;
      let nextHoveredBlockLineIndex: number | null = null;
      let nextTreeTooltip: TreeTooltip | null = null;
      const treeBounds = getBounds(treePanelRef);
      const nextTreeResizeHovered = isTreeResizeTarget(treeBounds, mousePosition.x, mousePosition.y);
      const treeHeaderCopied = copiedAction?.kind === 'tree-header';
      const nextTreeToggleHovered = isTreeToggleTarget(
        treeBounds,
        mousePosition.x,
        mousePosition.y,
        stateRef.current.treeContentWidth,
        treeCollapsed,
        treeHeaderCopied,
      );
      if (nextTreeResizeHovered) {
        setHoveredTreeRow((current) => (current === null ? current : null));
      } else if (nextTreeToggleHovered) {
        setHoveredTreeRow((current) => (current === null ? current : null));
        nextInfoTip = treeCollapsed ? 'expand file tree' : 'collapse file tree';
      } else if (!isInside(treeBounds, mousePosition.x, mousePosition.y) || !treeBounds || treeCollapsed) {
        // The collapsed rail draws no rows, so nothing on it has a row hint.
        setHoveredTreeRow((current) => (current === null ? current : null));
      } else if (isTreeHeaderCopyTarget(
        treeBounds,
        mousePosition.x,
        mousePosition.y,
        stateRef.current.treeContentWidth,
        treeHeaderCopied,
      )) {
        setHoveredTreeRow((current) => (current === null ? current : null));
        nextHoveredAction = {kind: 'tree-header', id: 'copy.tree'};
        nextInfoTip = copyActionHint('copy.tree');
      } else {
        const treeRowHit = getTreeRowHit(mousePosition.x, mousePosition.y);
        if (!treeRowHit) {
          setHoveredTreeRow((current) => (current === null ? current : null));
        } else {
          const {rowIndex, relativeX, bounds} = treeRowHit;
          if (rowIndex < 0 || rowIndex >= stateRef.current.rows.length) {
            setHoveredTreeRow((current) => (current === null ? current : null));
          } else {
            setHoveredTreeRow((current) => (current === rowIndex ? current : rowIndex));
            const row = stateRef.current.rows[rowIndex];
            const treeCopySucceeded = copiedAction?.kind === 'tree-copy' && copiedAction.rowIndex === rowIndex;
            if (row?.kind === 'file' && isTreeCopyTarget(relativeX, bounds.width)) {
              nextHoveredAction = {kind: 'tree-copy', rowIndex};
              nextInfoTip = copyActionHint('copy.path');
            } else if (
              row?.kind === 'file'
              && isTreeStatusTarget(
                relativeX,
                bounds.width,
                treeCopySucceeded,
              )
            ) {
              const hint = statusHint(row.status);
              nextTreeTooltip = hint ? buildTreeTooltip(hint, bounds, columns, terminalRows) : null;
            } else if (
              row?.kind === 'file'
              && relativeX < treeRowLabelWidth(row, bounds.width, treeCopySucceeded)
              && isTreeRowLabelTruncated(row, bounds.width, treeCopySucceeded)
            ) {
              nextTreeTooltip = buildTreeTooltip(toDisplayText(row.label), bounds, columns, terminalRows);
            }
          }
        }
      }

      const diffBounds = getBounds(diffPanelRef);
      if (isInside(diffBounds, mousePosition.x, mousePosition.y) && diffBounds) {
        const relativeY = mousePosition.y - diffBounds.top;
        const relativeX = mousePosition.x - diffBounds.left;
        if (relativeY === 1 || relativeY === 2) {
          const header = diffHeaderRef.current;
          const actionId = spanAt(relativeY === 1 ? header.fileSpans : header.metricsSpans, relativeX - 2);
          if (actionId) {
            nextHoveredAction = {kind: 'file-header', id: actionId};
            nextInfoTip = copyActionHint(actionId);
          }
        } else {
          const diffLineIndex = diffOffset + relativeY - 3;
          const blockLineIndex = allDiffRows[diffLineIndex]?.headerLine ?? null;
          nextHoveredBlockLineIndex = blockLineIndex;
          if (blockLineIndex !== null && diffLineIndex === blockLineIndex) {
            const actionId = spanAt(blockHeaderSpans(blockLineIndex), relativeX - 2);
            if (actionId) {
              nextHoveredAction = {kind: 'block', id: actionId, lineIndex: blockLineIndex};
              nextInfoTip = copyActionHint(actionId);
            }
          }
        }
      }

      setHoveredBlockLineIndex((current) => (current === nextHoveredBlockLineIndex ? current : nextHoveredBlockLineIndex));
      setInfoTip((current) => (current === nextInfoTip ? current : nextInfoTip));
      scheduleTreeTooltip(nextTreeTooltip);
      setTreeResizeHovered((current) => current === nextTreeResizeHovered ? current : nextTreeResizeHovered);
      setTreeToggleHovered((current) => current === nextTreeToggleHovered ? current : nextTreeToggleHovered);

      setHoveredAction((current) => {
        if (hoveredActionsEqual(current, nextHoveredAction)) {
          return current;
        }

        return nextHoveredAction;
      });
    };

    mouse.events.on('position', handlePosition);
    return () => mouse.events.off('position', handlePosition);
  }, [
    allDiffRows,
    blockHeaderSpans,
    clearTreeTooltip,
    columns,
    copiedAction,
    diffOffset,
    displayBase,
    displayBranch,
    getTreeRowHit,
    hoveredAction,
    hoveredBlockLineIndex,
    mouse,
    scheduleTreeTooltip,
    terminalRows,
    treeCollapsed,
    worktreeBranchName,
  ]);

  useEffect(() => {
    const handleDrag = (position: {x: number; y: number}, action: 'dragging' | null) => {
      if (treeResizingRef.current) {
        const mousePosition = normalizeMousePosition(position);
        if (action === 'dragging') {
          treeResizeMovedRef.current = true;
          resizeTreeToMouse(mousePosition.x);
          return;
        }

        if (treeResizeMovedRef.current) {
          resizeTreeToMouse(mousePosition.x);
        }

        treeResizingRef.current = false;
        treeResizeMovedRef.current = false;
        treeResizeStartRef.current = null;
        setTreeResizing(false);
        return;
      }

      const currentSelection = codeSelectionRef.current;
      if (!currentSelection) return;

      const mousePosition = normalizeMousePosition(position);
      const point = getCodeSelectionPoint(mousePosition);
      const nextSelection = point ? {...currentSelection, focus: point, active: action === 'dragging'} : {
        ...currentSelection,
        active: action === 'dragging',
      };

      if (action === 'dragging') {
        scheduleCodeSelection(nextSelection);
      } else {
        setCodeSelection(nextSelection);
      }

      if (action === null) {
        void copyCodeSelection(nextSelection);
      }
    };

    mouse.events.on('drag', handleDrag);
    return () => mouse.events.off('drag', handleDrag);
  }, [
    copyCodeSelection,
    getCodeSelectionPoint,
    mouse,
    resizeTreeToMouse,
    scheduleCodeSelection,
    setCodeSelection,
  ]);

  useEffect(() => {
    const handleClick = (position: {x: number; y: number}, action: 'press' | 'release' | null) => {
      const mousePosition = normalizeMousePosition(position);
      if (action === 'release') {
        if (treeResizingRef.current) {
          treeResizingRef.current = false;
          treeResizeMovedRef.current = false;
          treeResizeStartRef.current = null;
          setTreeResizing(false);
          return;
        }

        const currentSelection = codeSelectionRef.current;
        if (!currentSelection?.active) return;
        const point = getCodeSelectionPoint(mousePosition);
        const nextSelection = {
          ...currentSelection,
          ...(point ? {focus: point} : {}),
          active: false,
        };
        setCodeSelection(nextSelection);
        void copyCodeSelection(nextSelection);
        return;
      }

      if (action !== 'press') return;

      const treeBounds = getBounds(treePanelRef);
      const treeHeaderCopied = copiedAction?.kind === 'tree-header';
      if (isTreeToggleTarget(
        treeBounds,
        mousePosition.x,
        mousePosition.y,
        stateRef.current.treeContentWidth,
        treeCollapsed,
        treeHeaderCopied,
      )) {
        toggleTree();
        setHoveredAction(null);
        clearTreeTooltip();
        return;
      }

      if (isTreeResizeTarget(treeBounds, mousePosition.x, mousePosition.y)) {
        treeResizingRef.current = true;
        treeResizeMovedRef.current = false;
        treeResizeStartRef.current = {mouseX: mousePosition.x, width: leftWidth};
        setTreeResizing(true);
        setHoveredAction(null);
        setHoveredTreeRow(null);
        clearTreeTooltip();
        return;
      }

      const selectionPoint = getCodeSelectionPoint(mousePosition);
      if (selectionPoint) {
        setHoveredAction(null);
        setCodeSelection({anchor: selectionPoint, focus: selectionPoint, active: true, lines: selectionViewRef.current.lines});
        return;
      }

      if (codeSelectionRef.current) {
        setCodeSelection(null);
      }

      if (isInside(treeBounds, mousePosition.x, mousePosition.y) && treeBounds) {
        if (!treeCollapsed && isTreeHeaderCopyTarget(
          treeBounds,
          mousePosition.x,
          mousePosition.y,
          stateRef.current.treeContentWidth,
          treeHeaderCopied,
        )) {
          void copyFileTree();
          return;
        }

        if (treeCollapsed) return;

        const treeRowHit = getTreeRowHit(mousePosition.x, mousePosition.y);
        if (!treeRowHit) return;

        const {rowIndex, relativeX, bounds} = treeRowHit;
        const row = stateRef.current.rows[rowIndex];
        if (row?.kind === 'dir') {
          toggleTreeDirectory(row.path);
          return;
        }

        if (row && row.kind === 'file') {
          const rowFile = sections.find((section) => section.key === row.key)?.file;
          if (isTreeCopyTarget(relativeX, bounds.width) && rowFile) {
            void runCopyCommand('copy.path', rowFile, rowFile.blocks[0], {kind: 'tree-copy', rowIndex});
            return;
          }

          jumpToFile(row.key);
        }
        return;
      }

      const diffBounds = getBounds(diffPanelRef);
      if (!isInside(diffBounds, mousePosition.x, mousePosition.y) || !diffBounds || !review) return;

      const relativeY = mousePosition.y - diffBounds.top;
      const relativeX = mousePosition.x - diffBounds.left;

      if (relativeY === 1 || relativeY === 2) {
        const header = diffHeaderRef.current;
        const actionId = spanAt(relativeY === 1 ? header.fileSpans : header.metricsSpans, relativeX - 2);
        if (actionId) {
          void runCopyCommand(actionId, activeFile, focusedBlock, {kind: 'file-header', id: actionId});
        }
        return;
      }

      const diffLineIndex = diffOffset + relativeY - 3;
      const row = allDiffRows[diffLineIndex];
      if (row?.kind !== 'header' || !row.target) return;

      const blockTarget = row.target;
      // Only the header that currently shows its actions has clickable ones;
      // anywhere else on a header row toggles the block.
      const actionsShown = (hoveredBlockLineIndex ?? focusedBlockLineIndex) === diffLineIndex;
      const actionId = actionsShown ? spanAt(blockHeaderSpans(diffLineIndex), relativeX - 2) : null;
      if (actionId) {
        void runCopyCommand(actionId, blockTarget.file, blockTarget.block, {kind: 'block', id: actionId, lineIndex: diffLineIndex});
        return;
      }

      toggleBlock(blockTarget.key);
    };

    mouse.events.on('click', handleClick);
    return () => mouse.events.off('click', handleClick);
  }, [
    activeFile,
    allDiffRows,
    blockHeaderSpans,
    clearTreeTooltip,
    copiedAction,
    diffOffset,
    focusedBlock,
    focusedBlockLineIndex,
    getCodeSelectionPoint,
    hoveredBlockLineIndex,
    getTreeRowHit,
    leftWidth,
    mouse,
    copyCodeSelection,
    copyFileTree,
    jumpToFile,
    review,
    resizeTreeToMouse,
    runCopyCommand,
    sections,
    setCodeSelection,
    toggleBlock,
    toggleTree,
    toggleTreeDirectory,
    treeCollapsed,
  ]);

  useInput((input, key) => {
    // A late reply to the startup queries, whole or in parts, does nothing.
    if (escapeGuard.onInput(input, key, exit) === 'handled') return;

    // Ink reports Esc with `meta` set, so quitting is checked before the
    // modifier guard below. Alt-q and Ctrl-q are not quit keys.
    if (key.escape || (input === 'q' && !key.ctrl && !key.meta)) {
      exit();
      return;
    }

    // The too-small view shows no panes, so no other key acts on them.
    if (tooSmall) return;

    if (key.downArrow) {
      jumpToSection(topSectionIndex + 1);
      return;
    }

    if (key.upArrow) {
      jumpToSection(topSectionIndex - 1);
      return;
    }

    if ((key.ctrl || key.meta) && input.toLowerCase() === 'k') {
      showToast('Palette is not available yet.', undefined, 'info');
      return;
    }

    if (key.ctrl || key.meta) return;

    if (input === 'j') {
      scrollDiffTo(applyScrollDelta(diffOffset, scrollCeiling, 1));
      return;
    }

    if (input === 'k') {
      scrollDiffTo(applyScrollDelta(diffOffset, scrollCeiling, -1));
      return;
    }

    if (input === 'g') {
      scrollDiffTo(0);
      return;
    }

    if (input === 'G') {
      scrollDiffTo(scrollCeiling);
      return;
    }

    if (input === ']' || input === '[') {
      moveBlockFocus(input === ']' ? 1 : -1);
      return;
    }

    const focusedTarget = focusedBlockLineIndex === null ? undefined : allDiffRows[focusedBlockLineIndex]?.target;
    if (key.return || input === ' ') {
      toggleFocusedBlock();
      return;
    }

    const fileCommand = FILE_KEY_COMMANDS[input];
    if (fileCommand) {
      void runCopyCommand(fileCommand, activeFile, focusedBlock, {kind: 'file-header', id: fileCommand});
      return;
    }

    const blockCommand = BLOCK_KEY_COMMANDS[input];
    if (blockCommand) {
      const successAction: CopiedAction | undefined = focusedBlockLineIndex === null
        ? undefined
        : {kind: 'block', id: blockCommand, lineIndex: focusedBlockLineIndex};
      void runCopyCommand(blockCommand, focusedTarget?.file ?? activeFile, focusedTarget?.block ?? focusedBlock, successAction);
      return;
    }

    if (input === 'T') {
      void copyFileTree();
      return;
    }

    if (input === 't') {
      toggleTree();
    }
  });

  const topBarLine = composeBar(
    [
      {text: 'branch-review', style: ANSI_CYAN_BOLD},
      {text: ' ', style: ''},
      {text: displayBranch, style: ''},
      {text: ' against ', style: ANSI_GRAY},
      {text: displayBase, style: ANSI_YELLOW},
    ],
    infoTip
      ? {text: infoTip, style: ANSI_CYAN_BOLD}
      : {
        text: `${branchMetrics.filesChanged} files • +${branchMetrics.additions} • -${branchMetrics.deletions} • ${branchMetrics.changedLines} changed`,
        style: ANSI_MAGENTA_BRIGHT,
      },
    Math.max(1, columns - 4),
    infoTip ? truncateStart : truncateEnd,
  );
  const footerStatus: BarPart = toast
    ? toast.kind === 'error'
      ? {text: `✗ ${toast.text}`, style: ANSI_RED}
      : {text: `${toast.kind === 'success' ? '✓ ' : ''}${toast.text}`, style: ANSI_CYAN}
    : {text: footerHintText(watchStatus ? toDisplayText(watchStatus) : undefined, Math.max(1, columns - 4)), style: ANSI_GRAY};
  const footerLine = composeBar(
    [footerStatus],
    {text: `${displayBase}...${displayBranch}`, style: ANSI_GRAY},
    Math.max(1, columns - 4),
    truncateStart,
  );

  if (tooSmall) {
    return (
      <Box width={columns}>
        <Text wrap="truncate">
          {truncateEnd(`Terminal too small: ${columns}×${terminalRows}, needs ${MIN_TERMINAL_COLUMNS}×${MIN_TERMINAL_ROWS} · q quit`, Math.max(1, columns))}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <Box ref={topBarRef} width={columns} borderStyle="round" borderColor={palette.ink('cyan')} paddingX={1}>
        <Text wrap="truncate">{topBarLine}</Text>
      </Box>

      <Box>
        <TreePane
          panelRef={treePanelRef}
          width={leftWidth}
          height={contentHeight}
          hovered={treeHovered || treeResizeHovered || treeResizing}
          resizeActive={treeResizeHovered || treeResizing}
          setHovered={setTreeHovered}
        >
          <Box width={treeContentWidth} justifyContent="space-between">
            <Text color={palette.ink('cyan')}>{treeCollapsed ? 'Files' : 'Changed files'}</Text>
            <Text
              color={palette.ink(
                treeToggleHovered
                  ? 'cyan'
                  : copiedAction?.kind === 'tree-header'
                    ? 'greenBright'
                    : hoveredAction?.kind === 'tree-header'
                      ? 'cyan'
                      : 'gray',
              )}
              bold={treeToggleHovered || copiedAction?.kind === 'tree-header' || hoveredAction?.kind === 'tree-header'}
            >
              {treeHeaderActionLabel(treeCollapsed, copiedAction?.kind === 'tree-header')}
            </Text>
          </Box>
          {treeCollapsed
            ? (
              <>
                <Box width={treeContentWidth}>
                  <Text color={palette.ink('magentaBright')} bold>{files.length}</Text>
                  <Text color={palette.ink('gray')}> files</Text>
                </Box>
              </>
            )
            : visibleRows.map((row, index) => (
              <TreeFileRow
                key={row.id}
                row={row}
                selected={row.id === activeTreeId}
                hovered={hoveredTreeRow !== null && hoveredTreeRow === treeOffset + index}
                copyHovered={
                  hoveredAction?.kind === 'tree-copy'
                  && hoveredAction.rowIndex === treeOffset + index
                }
                copySucceeded={
                  copiedAction?.kind === 'tree-copy'
                  && copiedAction.rowIndex === treeOffset + index
                }
                arrivalEntry={row.kind === 'file' ? arrivalAnimations.files.get(row.key) : undefined}
                arrivalNow={arrivalNow}
                width={treeContentWidth}
              />
            ))}
        </TreePane>

        <DiffPane
          panelRef={diffPanelRef}
          width={rightWidth}
          height={contentHeight}
          hovered={diffHovered}
          setHovered={setDiffHovered}
        >
          <DiffErrorBoundary
            filePath={activeFilePath}
            resetKey={`${sectionsRevision}\0${activeFileKey}\0${diffOffset}\0${rightWidth}`}
            width={rightWidth}
          >
            <DiffPaneBody
              paneWidth={rightWidth}
              paneHeight={contentHeight}
              contentWidth={diffContentWidth}
              borderAnsi={diffHovered ? ANSI_CYAN : ANSI_GRAY}
              fileRow={diffHeader.fileRow}
              metricsRow={diffHeader.metricsRow}
              hasChanges={sections.length > 0}
              emptyStateHint={emptyStateHint}
              visibleDiffLines={visibleDiffLines}
              diffOffset={diffOffset}
              allDiffRows={allDiffRows}
              collapsedBlockIds={collapsedBlockIds}
              arrivalAnimations={arrivalAnimations}
              arrivalNow={arrivalNow}
              fileArrival={arrivalAnimations.files.get(activeFileKey)}
              actionBlockLineIndex={hoveredBlockLineIndex ?? focusedBlockLineIndex}
              focusedBlockLineIndex={focusedBlockLineIndex}
              hoveredAction={hoveredAction}
              copiedAction={copiedAction}
              selection={codeSelection?.lines === allDiffLines ? codeSelection : null}
            />
          </DiffErrorBoundary>
        </DiffPane>
      </Box>

      <Box width={columns} borderStyle="round" borderColor={palette.ink('gray')} paddingX={1}>
        <Text wrap="truncate">{footerLine}</Text>
      </Box>
      {treeTooltip ? <TreeTooltipOverlay tooltip={treeTooltip} /> : null}
    </Box>
  );
}

export function App(props: AppProps) {
  return (
    <MouseProvider>
      <AppContent {...props} />
    </MouseProvider>
  );
}
