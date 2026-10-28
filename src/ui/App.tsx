import React, {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Box, DOMElement, Text, useApp, useInput, useStdout} from 'ink';
import {
  MouseProvider,
  useMouse,
  useOnMouseHover,
} from '@zenobius/ink-mouse';
import {applyTreeCollapse, buildTreeRows, findTreeSelectionPath, formatTreePayload, type TreeRow} from '../tree.js';
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
} from '../sections.js';
import {graphemes, toDisplayText, truncateStart, type Grapheme} from './text.js';
import type {FileStatus} from '../git.js';
import {executeCopyCommand} from '../commands/execute.js';
import type {ClipboardWriter} from '../commands/execute.js';
import type {ReviewFile, ReviewBlock, ReviewModel} from '../review/model.js';

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
};

const SCROLL_STEP = 3;
const DEFAULT_TREE_WIDTH_RATIO = 0.27;
const MAX_TREE_WIDTH_RATIO = 0.75;
const MIN_TREE_WIDTH = 34;
const COLLAPSED_TREE_WIDTH = 18;
const MIN_DIFF_WIDTH = 40;
const TOAST_TIMEOUT_MS = 2200;
const COPY_SUCCESS_TIMEOUT_MS = 1200;
const CODE_SELECTION_RENDER_INTERVAL_MS = 33;
const TREE_TOOLTIP_DELAY_MS = 300;
const ARRIVAL_ANIMATION_DURATION_MS = 2600;
const ARRIVAL_ANIMATION_TICK_MS = 130;
const MAX_ANIMATED_ENTRIES = 120;
const COPY_SUCCESS_LABEL = '✓ Copied';
const TREE_HEADER_COPY_LABEL = 'Copy tree';
const TREE_COLLAPSE_LABEL = '‹';
const TREE_EXPAND_LABEL = '›';
const FILE_ACTIONS = [
  {id: 'copy.path', label: 'Copy path'},
  {id: 'copy.fileDiff', label: 'Copy diff'},
  {id: 'copy.fileContents', label: 'Copy file'},
] as const;
const ABSOLUTE_PATH_ACTION = {id: 'copy.absolutePath', label: 'Copy absolute path'} as const;
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

type BlockTarget = {file: ReviewFile; block: ReviewBlock};
// One rendered diff row with its place in the review: the section it belongs
// to, the absolute index of its block's header row, and the block it maps to.
type DiffRow = SectionRow & {
  sectionIndex: number;
  headerLine: number | null;
  target?: BlockTarget;
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

export function applyMouseScroll(currentOffset: number, maxOffset: number, action: string | undefined) {
  if (action === 'scrolldown') {
    return applyScrollDelta(currentOffset, maxOffset, SCROLL_STEP);
  }

  if (action === 'scrollup') {
    return applyScrollDelta(currentOffset, maxOffset, -SCROLL_STEP);
  }

  return currentOffset;
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
  startLine: number,
  endLineExclusive: number,
) {
  if (sections.length === 0) {
    return -1;
  }

  const start = clamp(startLine, 0, Math.max(lines.length - 1, 0));
  const end = clamp(endLineExclusive, start + 1, lines.length);
  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    if (stripAnsi(lines[lineIndex] ?? '').trim()) {
      return getSectionIndexForLine(sections, lineIndex);
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

function sectionWrapCacheKey(section: DiffSection, maxWidth: number) {
  const signature = section.signature
    ?? hashText(`${section.metrics.additions}:${section.metrics.deletions}:${section.metrics.changedLines}:${section.lines.join('\n')}`);
  return `${maxWidth}\0${section.path}\0${signature}`;
}

function wrapSectionsWithCache(
  sections: DiffSection[],
  maxWidth: number,
  cache: Map<string, WrappedSectionCacheEntry>,
) {
  const nextCache = new Map<string, WrappedSectionCacheEntry>();
  let cursor = 0;

  const wrapped = sections.map((section) => {
    const key = sectionWrapCacheKey(section, maxWidth);
    let entry = cache.get(key);
    if (!entry) {
      const wrappedSection = wrapSections([section], maxWidth)[0];
      entry = {lines: wrappedSection?.lines ?? [], rows: wrappedSection?.rows ?? []};
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

function buildArrivalSnapshot(review: ReviewModel | undefined, sections: DiffSection[]): ArrivalSnapshot {
  if (review) {
    return {
      files: new Map(review.files.map((file) => {
        const blocks = new Map(file.blocks.map((block) => [
          blockAnimationKey(file.path, block),
          block.signature ?? hashText(`${block.lineStart}:${block.lineEnd}:${block.rawDiff}:${block.addedCode}`),
        ]));
        return [
          file.path,
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
      section.path,
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
  const progress = arrivalProgress(entry, now);
  if (progress >= 1) return null;

  const ramp = entry.kind === 'new'
    ? [
      '[48;2;18;72;38m',
      '[48;2;17;68;37m',
      '[48;2;15;60;34m',
      '[48;2;13;52;31m',
      '[48;2;11;44;28m',
      '[48;2;9;36;25m',
      '[48;2;7;28;22m',
      '[48;2;5;20;18m',
    ]
    : [
      '[48;2;17;64;72m',
      '[48;2;16;60;69m',
      '[48;2;14;54;63m',
      '[48;2;12;47;57m',
      '[48;2;10;39;49m',
      '[48;2;8;32;41m',
      '[48;2;6;25;33m',
      '[48;2;4;19;27m',
    ];

  if (progress < 0.08) return ramp[0]!;
  if (progress < 0.18) return ramp[1]!;
  if (progress < 0.31) return ramp[2]!;
  if (progress < 0.46) return ramp[3]!;
  if (progress < 0.62) return ramp[4]!;
  if (progress < 0.78) return ramp[5]!;
  if (progress < 0.92) return ramp[6]!;
  return ramp[7]!;
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
    return progress < 0.4 ? 'greenBright' : 'green';
  }

  return progress < 0.4 ? 'cyanBright' : 'cyan';
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
  if (status === 'added' || status === 'untracked') return 'green';
  if (status === 'deleted') return 'red';
  if (status === 'renamed') return 'magenta';
  return 'yellow';
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
  const accent = selected ? 'cyanBright' : arrivalColor ?? (row.kind === 'dir' ? 'yellow' : hovered ? 'cyan' : 'white');
  const copyVisible = shouldShowTreeCopy(row.kind, hovered, selected, copySucceeded);
  const copyLabel = copySucceeded ? successLabel('Copy') : 'Copy';
  const copySlotWidth = getTreeCopySlotWidth(copySucceeded);
  const indicatorWidth = row.kind === 'file' ? getTreeIndicatorWidth(copySucceeded) : 0;
  const labelWidth = treeRowLabelWidth(row, width, copySucceeded);

  return (
    <Box width={width}>
      <Box width={labelWidth}>
        <Text color={accent} bold={selected || Boolean(arrivalColor)} dimColor={row.kind === 'dir' && !selected && !arrivalColor} wrap="truncate-end">
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
          <Text color={copySucceeded ? 'greenBright' : copyHovered ? 'cyanBright' : 'gray'} bold={copySucceeded || copyHovered}>
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
      borderColor={resizeActive ? 'gray' : hovered ? 'cyan' : 'gray'}
      borderRightColor={resizeActive ? 'cyanBright' : hovered ? 'cyan' : 'gray'}
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
      <Text color="gray">{`╭${horizontal}╮`}</Text>
      <Box width={tooltip.width}>
        <Text color="gray">│ </Text>
        <Text color="white">{text}</Text>
        <Text color="gray"> │</Text>
      </Box>
      <Text color="gray">{`╰${horizontal}╯`}</Text>
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

const ANSI_CYAN_BRIGHT_BOLD = '[96;1m';
const ANSI_CYAN_BRIGHT = '[96m';
const ANSI_CYAN = '[36m';
const ANSI_GRAY = '[90m';
const ANSI_GREEN_BOLD = '[32;1m';
const ANSI_GREEN = '[32m';
const ANSI_RED = '[31m';
const ANSI_YELLOW = '[33m';
const ANSI_MAGENTA = '[35m';
const ANSI_RESET = '[0m';
const ANSI_SELECTION = '[48;2;28;68;76m[97;1m';

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
  const color = copied ? ANSI_GREEN_BOLD : primary ? ANSI_CYAN_BRIGHT : ANSI_GRAY;
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

function fileActions(hoveredAction?: string, copiedAction?: string) {
  return FILE_ACTIONS
    .map((action) => actionButton(
      action.label,
      action.id === hoveredAction,
      action.id === copiedAction || (action.id === 'copy.path' && copiedAction === ABSOLUTE_PATH_ACTION.id),
    ))
    .join(' ');
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

// Graphemes that overlap the cell range [from, to), so a wide character that
// is partly selected is copied whole.
function sliceColumns(parts: Grapheme[], from: number, to: number) {
  let column = 0;
  let text = '';
  for (const part of parts) {
    if (column < to && column + part.width > from) {
      text += part.text;
    }
    column += part.width;
  }

  return text;
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

export function getSelectedCodeText(
  lines: string[],
  rows: ReadonlyArray<SectionRow | undefined>,
  selection: Pick<CodeSelection, 'anchor' | 'focus'>,
) {
  const {start, end} = normalizeCodeSelection(selection);
  const selectedLines: string[] = [];
  let previousLineIndex = -1;

  for (let lineIndex = start.lineIndex; lineIndex <= end.lineIndex; lineIndex += 1) {
    const row = rows[lineIndex];
    const content = getCodeContent(lines[lineIndex] ?? '', row);
    if (!content) continue;

    const range = selectedCodeColumns(lineIndex, content, selection);
    const text = range ? sliceColumns(content.parts, range.from, range.to) : '';
    // A wrapped continuation row is the same source line, so it joins the
    // previous row without a newline.
    if (row?.continuation && previousLineIndex === lineIndex - 1 && selectedLines.length > 0) {
      selectedLines[selectedLines.length - 1] += text;
    } else {
      selectedLines.push(text);
    }
    previousLineIndex = lineIndex;
  }

  return selectedLines.join('\n');
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
  const color = hovered ? ANSI_CYAN_BRIGHT_BOLD : ANSI_GRAY;
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
  const right = showActions ? fileActions(hoveredAction, copiedAction) : '';
  const rightWidth = visibleWidth(right);
  const pathWidth = Math.max(1, width - statusWidth - (right ? rightWidth + 1 : 0));
  const fileLabel = `${statusText}${statusText ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(toDisplayText(path || ' '), pathWidth)}${ANSI_RESET}`;
  const fileRow = composeLeftRight(fileLabel, right, width);

  const fileSpans: ActionSpan[] = [];
  let pathButton: {start: number; width: number} | null = null;
  if (right) {
    let column = visibleWidth(fileRow) - rightWidth;
    for (const action of FILE_ACTIONS) {
      const copied = action.id === copiedAction || (action.id === 'copy.path' && copiedAction === ABSOLUTE_PATH_ACTION.id);
      const labelWidth = visibleWidth(copied ? successLabel(action.label) : action.label);
      const buttonWidth = labelWidth + 4;
      fileSpans.push({id: action.id, start: column + 2, end: column + 2 + labelWidth});
      if (action.id === 'copy.path') pathButton = {start: column, width: buttonWidth};
      column += buttonWidth + 1;
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

function blockActionsLine(hoveredAction?: string, copiedAction?: string) {
  return BLOCK_ACTIONS
    .map((action) => {
      const copied = action.id === copiedAction;
      const color = copied
        ? ANSI_GREEN_BOLD
        : action.id === hoveredAction
        ? ANSI_CYAN_BRIGHT_BOLD
        : ANSI_GRAY;
      return `${color}${copied ? successLabel(action.label) : action.label}${ANSI_RESET}`;
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

// Draws a block header row from its structured label: the collapse glyph, the
// path truncated from the start, and, when shown, the block actions with
// their spans in section-line columns. The label always leaves room for the
// actions so it does not move under the pointer when they appear on hover.
function renderBlockHeaderRow(
  row: DiffRow,
  collapsed: boolean,
  width: number,
  actions: {hovered?: string; copied?: string} | null,
): {line: string; spans: ActionSpan[]} {
  const baseLabel = row.label ?? '•';
  const label = row.target ? `${collapsed ? '▸' : '▾'}${baseLabel.slice(1)}` : baseLabel;
  if (width < 4) {
    return {line: truncateAnsi(label, Math.max(width, 0)), spans: []};
  }

  const inner = width - 4;
  const right = blockActionsLine(actions?.hovered, actions?.copied);
  const rightWidth = visibleWidth(right);
  const fittedLabel = fitBlockHeaderLabel(label, Math.max(1, inner - rightWidth - 1));
  if (!actions) {
    return {line: frameLine(fittedLabel, inner, ANSI_CYAN), spans: []};
  }

  const left = `${ANSI_CYAN}${fittedLabel}${ANSI_RESET}`;
  const content = composeLeftRight(left, right, inner);
  const spans: ActionSpan[] = [];
  // The section line is `│ content │`, so content starts at column 2.
  let column = 2 + visibleWidth(content) - rightWidth;
  for (const action of BLOCK_ACTIONS) {
    const labelWidth = visibleWidth(action.id === actions.copied ? successLabel(action.label) : action.label);
    if (column + labelWidth <= 2 + inner) {
      spans.push({id: action.id, start: column, end: column + labelWidth});
    }
    column += labelWidth + BLOCK_ACTION_SEPARATOR.length;
  }

  return {line: frameLine(content, inner, ANSI_CYAN), spans};
}

function stripAnsi(line: string) {
  return line.replace(/\x1B\[[0-9;:]*[A-Za-z]/g, '');
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

export function getActionFromRenderedLine<T extends ReadonlyArray<{id: string; label: string}>>(
  relativeX: number,
  renderedLine: string,
  actions: T,
): T[number]['id'] | null {
  const plain = stripAnsi(renderedLine);

  for (const action of actions) {
    const start = plain.indexOf(action.label);
    if (start < 0) continue;

    const end = start + action.label.length - 1;
    if (relativeX >= start && relativeX <= end) {
      return action.id;
    }
  }

  return null;
}

type SelectionSource = {
  lines: string[];
  sections: ReadonlyArray<Pick<DiffSection, 'path' | 'startLine' | 'endLineExclusive'>>;
};

function remapLineIndex(lineIndex: number, previous: SelectionSource, next: SelectionSource) {
  const section = previous.sections[getSectionIndexForLine(previous.sections, lineIndex)];
  if (!section || lineIndex < section.startLine || lineIndex >= section.endLineExclusive) return null;

  const target = next.sections.find((entry) => entry.path === section.path);
  if (!target) return null;

  const mapped = target.startLine + lineIndex - section.startLine;
  return mapped < target.endLineExclusive ? mapped : null;
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

function resolveBlockTargets(rows: ReadonlyArray<SectionRow>, file: ReviewFile | undefined) {
  const targets: Array<BlockTarget | undefined> = [];
  for (const row of rows) {
    if (row.kind !== 'header') continue;
    // Delta's hunk headers and the parsed blocks come from the same diff in
    // the same order; the line-number check guards against a mismatch.
    const block = file?.blocks[row.block];
    targets[row.block] = file && block && block.lineStart === row.lineNumber ? {file, block} : undefined;
  }

  return targets;
}

type ViewSection = DiffSection & {
  rows: SectionRow[];
  blockTargets: Array<BlockTarget | undefined>;
};

function applyCollapsedBlocks(
  sections: DiffSection[],
  review: ReviewModel | undefined,
  collapsedBlockIds: ReadonlySet<string>,
): ViewSection[] {
  const fileByPath = new Map(review?.files.map((file) => [file.path, file]) ?? []);
  let cursor = 0;

  return sections.map((section) => {
    const allRows = section.rows ?? section.lines.map((): SectionRow => ({block: -1, kind: 'body', continuation: false}));
    const blockTargets = resolveBlockTargets(allRows, fileByPath.get(section.path));
    const isHidden = (row: SectionRow) => row.kind === 'body'
      && row.block >= 0
      && collapsedBlockIds.has(blockTargets[row.block]?.block.id ?? '');
    const collapsing = collapsedBlockIds.size > 0 && allRows.some(isHidden);
    const lines = collapsing ? section.lines.filter((_, index) => !isHidden(allRows[index]!)) : section.lines;
    const rows = collapsing ? allRows.filter((row) => !isHidden(row)) : allRows;
    const startLine = cursor;
    const endLineExclusive = cursor + lines.length;
    cursor = endLineExclusive;

    return {
      ...section,
      lines,
      rows,
      blockTargets,
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

    for (const row of section.rows) {
      rows.push({
        ...row,
        sectionIndex,
        headerLine: row.block >= 0 ? headerLines.get(row.block) ?? null : null,
        target: row.block >= 0 ? section.blockTargets[row.block] : undefined,
      });
    }
  }

  return rows;
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
}: AppProps) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const mouse = useMouse();
  const topBarRef = useRef<DOMElement>(null);
  const columns = dimensions?.columns ?? stdout?.columns ?? 120;
  const terminalRows = dimensions?.rows ?? stdout?.rows ?? 40;

  const [treeWidthOverride, setTreeWidthOverride] = useState<number | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const treeWidthLimits = useMemo(() => getTreeWidthLimits(columns), [columns]);
  const leftWidth = treeCollapsed
    ? COLLAPSED_TREE_WIDTH
    : clamp(treeWidthOverride ?? defaultTreeWidth(columns), treeWidthLimits.min, treeWidthLimits.max);
  const rightWidth = Math.max(MIN_DIFF_WIDTH, columns - leftWidth);
  const diffContentWidth = Math.max(1, rightWidth - 4);
  const treeContentWidth = Math.max(1, leftWidth - 4);
  const contentHeight = Math.max(terminalRows - 9, 10);
  // Pane overhead: 2 borders + header rows.
  // Tree has 1 header row; diff has 2 (filename + metrics).
  const visibleTreeRows = Math.max(contentHeight - 3, 4);
  const visibleDiffRows = Math.max(contentHeight - 4, 6);

  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(() => new Set());
  const wrappedSectionCacheRef = useRef<Map<string, WrappedSectionCacheEntry>>(new Map());
  const wrappedSections = useMemo(
    () => wrapSectionsWithCache(rawSections, diffContentWidth, wrappedSectionCacheRef.current),
    [rawSections, diffContentWidth],
  );
  const sections = useMemo(
    () => applyCollapsedBlocks(wrappedSections, review, collapsedBlockIds),
    [collapsedBlockIds, review, wrappedSections],
  );

  const files = useMemo(() => sections.map((section) => section.path), [sections]);
  const statusByPath = useMemo(() => new Map(review?.files.map((file) => [file.path, file.status]) ?? []), [review]);
  const [collapsedTreePaths, setCollapsedTreePaths] = useState<Set<string>>(() => new Set());
  const allTreeRows = useMemo(() => buildTreeRows(files, statusByPath), [files, statusByPath]);
  const rows = useMemo(() => applyTreeCollapse(allTreeRows, collapsedTreePaths), [allTreeRows, collapsedTreePaths]);
  const allDiffLines = useMemo(() => flattenSectionLines(sections), [sections]);
  const allDiffRows = useMemo(() => buildDiffRows(sections), [sections]);

  const maxDiffOffset = Math.max(allDiffLines.length - visibleDiffRows, 0);
  const maxTreeOffset = Math.max(rows.length - visibleTreeRows, 0);

  const treePanelRef = useRef<DOMElement>(null);
  const diffPanelRef = useRef<DOMElement>(null);
  const [diffOffset, setDiffOffset] = useState(0);
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
  const viewSnapshotRef = useRef({
    path: '',
    sectionIndex: 0,
    relativeOffset: 0,
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
    diffOffset,
    diffOffset + visibleDiffRows,
  );
  const activeSectionIndex = topSectionIndex;
  const activeSection = activeSectionIndex >= 0 ? sections[activeSectionIndex] : null;
  const activeFilePath = activeSection?.path ?? '';
  const activeTreePath = useMemo(() => findTreeSelectionPath(rows, activeFilePath), [activeFilePath, rows]);
  const activeRowIndex = rows.findIndex((row) => row.path === activeTreePath);
  const activeFile = useMemo(
    () => review?.files.find((file) => file.path === activeFilePath),
    [activeFilePath, review],
  );
  const focusedBlockLineIndex = useMemo(
    () => findFocusedBlockLineIndex(allDiffRows, activeSection, diffOffset),
    [activeSection, allDiffRows, diffOffset],
  );
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
    maxDiffOffset,
    visibleTreeRows,
    rows,
    treeContentWidth,
  });
  stateRef.current = {treeOffset, maxTreeOffset, maxDiffOffset, visibleTreeRows, rows, treeContentWidth};

  useEffect(() => {
    treeTooltipRef.current = treeTooltip;
  }, [treeTooltip]);

  useLayoutEffect(() => {
    if (!animations) {
      arrivalSnapshotRef.current = null;
      setArrivalAnimations((current) => hasArrivalAnimations(current) ? {files: new Map(), blocks: new Map()} : current);
      return;
    }

    const nextSnapshot = buildArrivalSnapshot(review, rawSections);
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
    const availableBlockIds = new Set(review?.files.flatMap((file) => file.blocks.map((block) => block.id)) ?? []);
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
  const footerHints = watchStatus
    ? `${toDisplayText(watchStatus)} • ↑/↓ jump file • j/k scroll • g/G top-bottom • q quit`
    : '↑/↓ jump file • j/k scroll • g/G top-bottom • q quit';

  useEffect(() => {
    const snapshot = viewSnapshotRef.current;
    if (!snapshot.path || sections.length === 0) {
      setDiffOffset((current) => clamp(current, 0, maxDiffOffset));
      return;
    }

    const preservedSection = sections.find((section) => section.path === snapshot.path);
    const fallbackSection = sections[clamp(snapshot.sectionIndex, 0, sections.length - 1)];
    const nextSection = preservedSection ?? fallbackSection;
    if (!nextSection) {
      setDiffOffset(0);
      return;
    }

    const nextOffset = clamp(
      nextSection.startLine + snapshot.relativeOffset,
      nextSection.startLine,
      Math.max(nextSection.startLine, nextSection.endLineExclusive - 1),
    );

    setDiffOffset((current) => current === nextOffset ? current : nextOffset);
  }, [sections, maxDiffOffset]);

  useEffect(() => {
    viewSnapshotRef.current = {
      path: activeFilePath,
      sectionIndex: activeSectionIndex,
      relativeOffset: activeSection ? Math.max(0, diffOffset - activeSection.startLine) : 0,
    };
  }, [activeFilePath, activeSection, activeSectionIndex, diffOffset]);

  useEffect(() => {
    setDiffOffset((current) => clamp(current, 0, maxDiffOffset));
  }, [maxDiffOffset]);

  useEffect(() => {
    setTreeOffset((current) => {
      const clamped = clamp(current, 0, maxTreeOffset);
      return ensureVisible(activeRowIndex, clamped, visibleTreeRows);
    });
  }, [activeRowIndex, maxTreeOffset, visibleTreeRows]);

  const jumpToFile = useCallback((filePath: string) => {
    const section = sections.find((entry) => entry.path === filePath);
    if (section) {
      setDiffOffset(section.startLine);
    }
  }, [sections]);

  const jumpToSection = useCallback((sectionIndex: number) => {
    const section = sections[clamp(sectionIndex, 0, sections.length - 1)];
    if (section) {
      setDiffOffset(section.startLine);
    }
  }, [sections]);

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

    const result = await executeCopyCommand(commandId, {
      model: review,
      activeFile: commandFile,
      focusedBlock: commandBlock,
      readFileContent,
      resolveAbsolutePath,
    }, copyWriter ? {write: copyWriter} : {});

    if (result.ok && successAction) {
      setCopiedAction(successAction);
    }

    showToast(result.toast, result.hint, result.ok ? 'success' : 'error');
  }, [activeFile, copyWriter, focusedBlock, readFileContent, resolveAbsolutePath, review, showToast]);

  const copyFileTree = useCallback(async () => {
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
  }, [allTreeRows, copyWriter, files.length, repoRoot, showToast]);

  const getCodeSelectionPoint = useCallback((mousePosition: {x: number; y: number}) => {
    const diffBounds = getBounds(diffPanelRef);
    if (!isInside(diffBounds, mousePosition.x, mousePosition.y) || !diffBounds) return null;

    const relativeY = mousePosition.y - diffBounds.top;
    if (relativeY < 3) return null;

    const lineIndex = diffOffset + relativeY - 3;
    if (lineIndex < 0 || lineIndex >= allDiffLines.length) return null;

    const innerColumn = mousePosition.x - diffBounds.left - 2;
    const code = getCodeContent(allDiffLines[lineIndex] ?? '', allDiffRows[lineIndex]);
    if (!code || innerColumn < code.start) return null;

    return {
      lineIndex,
      column: clamp(innerColumn - code.start, 0, code.width),
    };
  }, [allDiffLines, allDiffRows, diffOffset]);

  const cancelCodeSelection = useCallback((notify: boolean) => {
    setCodeSelection(null);
    if (notify) {
      showToast('Selection cancelled', 'the diff changed while selecting', 'info');
    }
  }, [setCodeSelection, showToast]);

  // A refresh, collapse or resize rebuilds the rendered lines. Keep the
  // selection on the same lines when they moved unchanged, otherwise drop it,
  // so a highlight or copy never lands on lines that were not selected.
  const selectionSourceRef = useRef({lines: allDiffLines, sections});
  useLayoutEffect(() => {
    const previous = selectionSourceRef.current;
    const next = {lines: allDiffLines, sections};
    selectionSourceRef.current = next;

    const selection = codeSelectionRef.current;
    if (!selection || selection.lines === allDiffLines) return;

    const remapped = selection.lines === previous.lines ? remapCodeSelection(selection, previous, next) : null;
    if (remapped) {
      setCodeSelection(remapped);
    } else {
      cancelCodeSelection(selection.active);
    }
  }, [allDiffLines, cancelCodeSelection, sections, setCodeSelection]);

  const copyCodeSelection = useCallback(async (selection: CodeSelection) => {
    if (selection.lines !== allDiffLines) {
      cancelCodeSelection(true);
      return;
    }

    if (compareSelectionPoints(selection.anchor, selection.focus) === 0) {
      setCodeSelection(null);
      return;
    }

    const text = getSelectedCodeText(allDiffLines, allDiffRows, selection);
    if (!text) {
      setCodeSelection(null);
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
  }, [allDiffLines, allDiffRows, cancelCodeSelection, copyWriter, setCodeSelection, showToast]);

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
        setDiffOffset((current) => applyScrollDelta(current, stateRef.current.maxDiffOffset, delta));
      }
    };

    mouse.events.on('scroll', handleScroll);
    return () => mouse.events.off('scroll', handleScroll);
  }, [mouse]);

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
      } else if (!isInside(treeBounds, mousePosition.x, mousePosition.y) || !treeBounds) {
        setHoveredTreeRow((current) => (current === null ? current : null));
      } else if (!treeCollapsed && isTreeHeaderCopyTarget(
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
      if (currentSelection.lines !== allDiffLines) {
        cancelCodeSelection(true);
        return;
      }

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
    allDiffLines,
    cancelCodeSelection,
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
        setTreeCollapsed((current) => !current);
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
        setCodeSelection({anchor: selectionPoint, focus: selectionPoint, active: true, lines: allDiffLines});
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
          const rowFile = review?.files.find((file) => file.path === row.path);
          if (isTreeCopyTarget(relativeX, bounds.width) && rowFile) {
            void runCopyCommand('copy.path', rowFile, rowFile.blocks[0], {kind: 'tree-copy', rowIndex});
            return;
          }

          jumpToFile(row.path);
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

      toggleBlock(blockTarget.block.id);
    };

    mouse.events.on('click', handleClick);
    return () => mouse.events.off('click', handleClick);
  }, [
    activeFile,
    allDiffLines,
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
    setCodeSelection,
    toggleBlock,
    toggleTreeDirectory,
    treeCollapsed,
  ]);

  useInput((input, key) => {
    if (key.downArrow) {
      jumpToSection(topSectionIndex + 1);
      return;
    }

    if (key.upArrow) {
      jumpToSection(topSectionIndex - 1);
      return;
    }

    if (input === 'j') {
      setDiffOffset(applyScrollDelta(diffOffset, maxDiffOffset, 1));
      return;
    }

    if ((key.ctrl || key.meta) && input.toLowerCase() === 'k') {
      showToast('Palette is not available yet.');
      return;
    }

    if (input === 'k') {
      setDiffOffset(applyScrollDelta(diffOffset, maxDiffOffset, -1));
      return;
    }

    if (input === 'g') {
      setDiffOffset(0);
      return;
    }

    if (input === 'G') {
      setDiffOffset(maxDiffOffset);
      return;
    }

    if (input === 'q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Box ref={topBarRef} borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Box>
          <Text color="cyanBright" bold>branch-review</Text>
          <Text color="gray"> </Text>
          <Text color="white">{displayBranch}</Text>
          <Text color="gray"> against </Text>
          <Text color="yellow">{displayBase}</Text>
        </Box>
        {infoTip
          ? (
            <Text color="cyanBright" bold wrap="truncate-end">
              {truncateStart(infoTip, Math.max(18, columns - visibleWidth('branch-review ') - visibleWidth(displayBranch) - visibleWidth(' against ') - visibleWidth(displayBase) - 8))}
            </Text>
          )
          : (
            <Text color="magentaBright">
              {branchMetrics.filesChanged} files • +{branchMetrics.additions} • -{branchMetrics.deletions} • {branchMetrics.changedLines} changed
            </Text>
          )}
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
            <Text color="cyan">{treeCollapsed ? 'Files' : 'Changed files'}</Text>
            <Text
              color={
                treeToggleHovered
                  ? 'cyanBright'
                  : copiedAction?.kind === 'tree-header'
                    ? 'greenBright'
                    : hoveredAction?.kind === 'tree-header'
                      ? 'cyanBright'
                      : 'gray'
              }
              bold={treeToggleHovered || copiedAction?.kind === 'tree-header' || hoveredAction?.kind === 'tree-header'}
            >
              {treeHeaderActionLabel(treeCollapsed, copiedAction?.kind === 'tree-header')}
            </Text>
          </Box>
          {treeCollapsed
            ? (
              <>
                <Box width={treeContentWidth}>
                  <Text color="magentaBright" bold>{files.length}</Text>
                  <Text color="gray"> files</Text>
                </Box>
              </>
            )
            : visibleRows.map((row, index) => (
              <TreeFileRow
                key={row.path}
                row={row}
                selected={row.path === activeTreePath}
                hovered={hoveredTreeRow !== null && hoveredTreeRow === treeOffset + index}
                copyHovered={
                  hoveredAction?.kind === 'tree-copy'
                  && hoveredAction.rowIndex === treeOffset + index
                }
                copySucceeded={
                  copiedAction?.kind === 'tree-copy'
                  && copiedAction.rowIndex === treeOffset + index
                }
                arrivalEntry={row.kind === 'file' ? arrivalAnimations.files.get(row.path) : undefined}
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
          {(() => {
            const borderAnsi = diffHovered ? ANSI_CYAN : ANSI_GRAY;
            const inner = Math.max(1, rightWidth - 4);
            const hasChanges = sections.length > 0;
            const fileLabelWithActions = applyArrivalWash(
              diffHeader.fileRow,
              arrivalAnimations.files.get(activeFilePath),
              arrivalNow,
            );

            const rows: string[] = [
              frameTopBorder(rightWidth, borderAnsi),
              frameLine(fileLabelWithActions, inner, borderAnsi),
              frameLine(diffHeader.metricsRow, inner, borderAnsi),
            ];
            if (!hasChanges) {
              rows.push(frameLine(`${ANSI_CYAN_BRIGHT_BOLD}No changes to review${ANSI_RESET}`, inner, borderAnsi));
              rows.push(frameLine(`${ANSI_GRAY}${toDisplayText(emptyStateHint ?? 'Run again after making changes.')}${ANSI_RESET}`, inner, borderAnsi));
            }

            const visibleSelection = codeSelection?.lines === allDiffLines ? codeSelection : null;
            const visibleActionBlockLineIndex = hoveredBlockLineIndex ?? focusedBlockLineIndex;
            for (const [index, line] of visibleDiffLines.entries()) {
              const absoluteLineIndex = diffOffset + index;
              const row = allDiffRows[absoluteLineIndex];
              const blockTarget = row?.target;
              const blockArrival = blockTarget
                ? arrivalAnimations.blocks.get(blockAnimationKey(blockTarget.file.path, blockTarget.block))
                : undefined;
              let visibleLine = line || ' ';
              if (row?.kind === 'header') {
                const showActions = visibleActionBlockLineIndex === absoluteLineIndex;
                visibleLine = renderBlockHeaderRow(
                  row,
                  Boolean(blockTarget && collapsedBlockIds.has(blockTarget.block.id)),
                  diffContentWidth,
                  showActions
                    ? {
                      hovered: hoveredAction?.kind === 'block' && hoveredAction.lineIndex === absoluteLineIndex ? hoveredAction.id : undefined,
                      copied: copiedAction?.kind === 'block' && copiedAction.lineIndex === absoluteLineIndex ? copiedAction.id : undefined,
                    }
                    : null,
                ).line;
              }

              const selectedLine = highlightSelectedCode(visibleLine, row, absoluteLineIndex, visibleSelection);
              const arrivalLine = applyArrivalWash(selectedLine, blockArrival, arrivalNow);
              rows.push(frameLine(arrivalLine, inner, borderAnsi));
            }
            rows.push(frameBottomBorder(rightWidth, borderAnsi));

            // Every row is padded to the pane width in terminal cells; truncate
            // so a row can never soft-wrap and push later rows out of the pane.
            return rows.map((row, i) => <Text key={`diff-${i}`} wrap="truncate">{row}</Text>);
          })()}
        </DiffPane>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
        {toast
          ? toast.kind === 'error'
            ? <Text color="red">✗ {toast.text}</Text>
            : <Text color="cyan">{toast.kind === 'success' ? '✓ ' : ''}{toast.text}</Text>
          : <Text color="gray">{footerHints}</Text>}
        <Text color="gray">{displayBase}...{displayBranch}</Text>
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
