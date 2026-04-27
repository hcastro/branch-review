import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, DOMElement, Text, useApp, useInput, useStdout} from 'ink';
import {
  MouseProvider,
  useMouse,
  useOnMouseHover,
} from '@zenobius/ink-mouse';
import {applyTreeCollapse, buildTreeRows, findTreeSelectionPath, formatTreePayload, type TreeRow} from '../tree.js';
import {writeClipboard} from '../clipboard/write.js';
import {
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
} from '../sections.js';
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
  dimensions?: {columns: number; rows: number};
  watchStatus?: string;
  emptyStateHint?: string;
};

const SCROLL_STEP = 3;
const TOAST_TIMEOUT_MS = 2200;
const COPY_SUCCESS_TIMEOUT_MS = 1200;
const CODE_SELECTION_RENDER_INTERVAL_MS = 33;
const COPY_SUCCESS_LABEL = '✓ Copied';
const TREE_HEADER_COPY_LABEL = 'Copy tree';
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

function isInside(bounds: Bounds | null, x: number, y: number) {
  if (!bounds) return false;
  return x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
}

function normalizeMousePosition(position: {x: number; y: number}) {
  return {
    x: position.x - 1,
    y: position.y - 1,
  };
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

const TreeFileRow = memo(function TreeFileRow({
  row,
  selected,
  hovered,
  copyHovered,
  copySucceeded,
  width,
}: {
  row: TreeRow;
  selected: boolean;
  hovered: boolean;
  copyHovered: boolean;
  copySucceeded: boolean;
  width: number;
}) {
  const accent = selected ? 'cyanBright' : row.kind === 'dir' ? 'yellow' : hovered ? 'cyan' : 'white';
  const glyph = row.kind === 'dir' ? row.expanded === false ? '▸' : '▾' : '•';
  const copyVisible = shouldShowTreeCopy(row.kind, hovered, selected, copySucceeded);
  const copyLabel = copySucceeded ? successLabel('Copy') : 'Copy';
  const copySlotWidth = getTreeCopySlotWidth(copySucceeded);
  const indicatorWidth = row.kind === 'file' ? getTreeIndicatorWidth(copySucceeded) : 0;
  const labelWidth = row.kind === 'file'
    ? Math.max(1, width - indicatorWidth - 1)
    : width;

  return (
    <Box width={width}>
      <Box width={labelWidth}>
        <Text color={accent} bold={selected} dimColor={row.kind === 'dir' && !selected} wrap="truncate-end">
          {' '.repeat(row.depth * 2)}{glyph} {row.label}
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
      borderStyle="round"
      borderColor={hovered ? 'cyan' : 'gray'}
      paddingX={1}
      marginRight={1}
    >
      {children}
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

function truncateStart(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return '…'.slice(0, maxWidth);
  return '…' + text.slice(text.length - maxWidth + 1);
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
    .map((action) => actionButton(action.label, action.id === hoveredAction, action.id === copiedAction))
    .join(' ');
}

function shouldRevealAbsolutePathAction(hoveredAction?: string, copiedAction?: string) {
  return hoveredAction === 'copy.path'
    || hoveredAction === 'copy.absolutePath'
    || copiedAction === 'copy.path'
    || copiedAction === 'copy.absolutePath';
}

function highlightActionLabel(line: string, actionId: string | undefined) {
  if (!actionId) return line;

  const action = [...FILE_ACTIONS, ABSOLUTE_PATH_ACTION, ...BLOCK_ACTIONS].find((entry) => entry.id === actionId);
  if (!action) return line;

  return line.replace(
    action.label,
    `${ANSI_CYAN_BRIGHT_BOLD}${action.label}${ANSI_RESET}`,
  );
}

type StyledCell = {
  char: string;
  style: string;
};

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

    for (const char of part) {
      cells.push({char, style});
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
    && selectionPointsEqual(a.anchor, b.anchor)
    && selectionPointsEqual(a.focus, b.focus);
}

function normalizeCodeSelection(selection: CodeSelection) {
  return compareSelectionPoints(selection.anchor, selection.focus) <= 0
    ? {start: selection.anchor, end: selection.focus}
    : {start: selection.focus, end: selection.anchor};
}

function getCodeContentRange(line: string) {
  const plain = stripAnsi(line);
  const separatorIndex = plain.indexOf('│');
  if (separatorIndex <= 0 || plain.startsWith('│')) {
    return null;
  }

  let start = separatorIndex + 1;
  if (plain[start] === ' ') {
    start += 1;
  }

  return {
    start,
    text: plain.slice(start),
  };
}

function selectedColumnRangeForLine(lineIndex: number, lineText: string, selection: CodeSelection) {
  const code = getCodeContentRange(lineText);
  if (!code) return null;

  const {start, end} = normalizeCodeSelection(selection);
  if (lineIndex < start.lineIndex || lineIndex > end.lineIndex) {
    return null;
  }

  const textLength = code.text.length;
  const selectionStart = lineIndex === start.lineIndex ? clamp(start.column, 0, textLength) : 0;
  const selectionEnd = lineIndex === end.lineIndex ? clamp(end.column + 1, 0, textLength) : textLength;
  if (selectionEnd <= selectionStart) {
    return null;
  }

  return {
    start: code.start + selectionStart,
    end: code.start + selectionEnd,
  };
}

function highlightSelectedCode(line: string, lineIndex: number, selection: CodeSelection | null) {
  if (!selection) return line;

  const range = selectedColumnRangeForLine(lineIndex, line, selection);
  if (!range) return line;

  const cells = toStyledCells(line);
  for (let index = range.start; index < range.end && index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell) {
      cell.style = `${cell.style}${ANSI_SELECTION}`;
    }
  }

  return renderStyledCells(cells);
}

export function getSelectedCodeText(lines: string[], selection: CodeSelection) {
  const {start, end} = normalizeCodeSelection(selection);
  const selectedLines: string[] = [];

  for (let lineIndex = start.lineIndex; lineIndex <= end.lineIndex; lineIndex += 1) {
    const code = getCodeContentRange(lines[lineIndex] ?? '');
    if (!code) continue;

    const textLength = code.text.length;
    const selectionStart = lineIndex === start.lineIndex ? clamp(start.column, 0, textLength) : 0;
    const selectionEnd = lineIndex === end.lineIndex ? clamp(end.column + 1, 0, textLength) : textLength;
    selectedLines.push(code.text.slice(selectionStart, Math.max(selectionStart, selectionEnd)));
  }

  return selectedLines.join('\n');
}

function overlayAnsiAt(baseLine: string, overlay: string, start: number, width: number) {
  const baseCells = toStyledCells(padToWidth(truncateAnsi(baseLine, width), width)).slice(0, width);
  const overlayCells = toStyledCells(overlay);
  const overlayWidth = visibleWidth(overlay);
  if (overlayWidth <= 0 || overlayWidth > width) return baseLine;

  const safeStart = clamp(start, 0, Math.max(0, width - overlayWidth));
  for (let index = 0; index < overlayCells.length && safeStart + index < baseCells.length; index += 1) {
    baseCells[safeStart + index] = overlayCells[index]!;
  }

  return renderStyledCells(baseCells);
}

function filePathActionTextStart(fileHeaderLine: string) {
  const plain = stripAnsi(fileHeaderLine);
  const pathStart = plain.indexOf(FILE_ACTIONS[0].label);
  if (pathStart >= 0) return pathStart;

  const copiedStart = plain.indexOf(COPY_SUCCESS_LABEL);
  return copiedStart >= 0 ? copiedStart : null;
}

function filePathActionCenterStart(fileHeaderLine: string, labelWidth: number) {
  const plain = stripAnsi(fileHeaderLine);
  const textStart = filePathActionTextStart(fileHeaderLine);
  if (textStart === null) return null;

  const frameStart = plain.lastIndexOf('╭', textStart);
  const frameEnd = plain.indexOf('╮', textStart);
  if (frameStart < 0 || frameEnd < 0 || frameEnd <= frameStart) {
    return textStart;
  }

  const frameWidth = frameEnd - frameStart + 1;
  return frameStart + Math.floor((frameWidth - labelWidth) / 2);
}

function secondaryPathActionLabel(hoveredAction?: string, copiedAction?: string) {
  const copied = copiedAction === ABSOLUTE_PATH_ACTION.id;
  const hovered = hoveredAction === ABSOLUTE_PATH_ACTION.id;
  const label = copied ? successLabel(ABSOLUTE_PATH_ACTION.label) : ABSOLUTE_PATH_ACTION.label;
  const color = copied ? ANSI_GREEN_BOLD : hovered ? ANSI_CYAN_BRIGHT_BOLD : ANSI_GRAY;
  return `${color}${label}${ANSI_RESET}`;
}

function addAbsolutePathActionToMetricsRow(
  metricsRow: string,
  fileHeaderLine: string,
  hoveredAction: string | undefined,
  copiedAction: string | undefined,
  width: number,
) {
  if (!shouldRevealAbsolutePathAction(hoveredAction, copiedAction)) return metricsRow;

  const label = secondaryPathActionLabel(hoveredAction, copiedAction);
  const start = filePathActionCenterStart(fileHeaderLine, visibleWidth(label));
  if (start === null) return metricsRow;

  return overlayAnsiAt(metricsRow, label, start, width);
}

function blockActionsLine(hoveredAction?: string, copiedAction?: string) {
  return BLOCK_ACTIONS
    .map((action) => {
      const copied = action.id === copiedAction;
      const color = copied
        ? ANSI_GREEN_BOLD
        : action.id === hoveredAction
        ? ANSI_CYAN_BRIGHT
        : ANSI_GRAY;
      return `${color}${copied ? successLabel(action.label) : action.label}${ANSI_RESET}`;
    })
    .join('  ');
}

function isBlockContentLine(line: string) {
  return /^│\s+• .+:\d+:/.test(stripAnsi(line));
}

function findBlockContentLineIndex(lines: string[], index: number) {
  for (const candidate of [index, index - 1, index + 1, index - 2, index + 2]) {
    if (candidate >= 0 && candidate < lines.length && isBlockContentLine(lines[candidate] ?? '')) {
      return candidate;
    }
  }

  return null;
}

function findHoveredBlockLineIndex(lines: string[], index: number) {
  const scanFloor = Math.max(0, index - 500);
  for (let candidate = index; candidate >= scanFloor; candidate -= 1) {
    const line = lines[candidate] ?? '';
    if (isBlockContentLine(line)) {
      return candidate;
    }
  }

  return findBlockContentLineIndex(lines, index);
}

export function findFocusedBlockLineIndex(
  lines: string[],
  section: Pick<DiffSection, 'startLine' | 'endLineExclusive'> | null,
  visibleTopLine: number,
) {
  if (!section || section.endLineExclusive <= section.startLine) {
    return null;
  }

  const clampedTop = clamp(visibleTopLine, section.startLine, section.endLineExclusive - 1);
  for (let candidate = clampedTop; candidate >= section.startLine; candidate -= 1) {
    if (isBlockContentLine(lines[candidate] ?? '')) {
      return candidate;
    }
  }

  for (let candidate = section.startLine; candidate < section.endLineExclusive; candidate += 1) {
    if (isBlockContentLine(lines[candidate] ?? '')) {
      return candidate;
    }
  }

  return null;
}

function addBlockActionsToLine(line: string, hoveredAction?: string, copiedAction?: string) {
  const plain = stripAnsi(line);
  if (!isBlockContentLine(line)) return line;

  const contentStart = plain.indexOf('│ ') + 2;
  const contentEnd = plain.lastIndexOf(' │');
  if (contentStart < 2 || contentEnd <= contentStart) return line;

  const contentWidth = contentEnd - contentStart;
  const leftText = plain.slice(contentStart, contentEnd).trimEnd();
  const content = composeLeftRight(`${ANSI_CYAN}${leftText}${ANSI_RESET}`, blockActionsLine(hoveredAction, copiedAction), contentWidth);

  return `${ANSI_CYAN}│${ANSI_RESET} ${content} ${ANSI_CYAN}│${ANSI_RESET}`;
}

function stripAnsi(line: string) {
  return line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
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

function isTreeHeaderCopyTarget(panelBounds: Bounds | null, x: number, y: number, contentWidth: number) {
  if (!isInside(panelBounds, x, y) || !panelBounds) return false;

  const headerY = panelBounds.top + 1;
  if (y !== headerY) return false;

  const rowLeft = panelBounds.left + 2;
  const labelWidth = visibleWidth(TREE_HEADER_COPY_LABEL);
  return x >= rowLeft + Math.max(0, contentWidth - labelWidth) && x < rowLeft + contentWidth;
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

function parseBlockLineTarget(line: string) {
  const plain = stripAnsi(line);
  const match = plain.match(/•\s+(.+):(\d+):/);
  if (!match) return null;

  return {
    path: match[1]!,
    lineStart: Number(match[2]),
  };
}

function findBlockTargetFromLine(
  line: string,
  review: ReviewModel | undefined,
): {file: ReviewFile; block: ReviewBlock} | undefined {
  const target = parseBlockLineTarget(line);
  if (!target || !review) return undefined;

  const file = review.files.find((entry) => entry.path === target.path);
  const block = file?.blocks.find((entry) => entry.lineStart === target.lineStart);
  return file && block ? {file, block} : undefined;
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
  dimensions,
  watchStatus,
  emptyStateHint,
}: AppProps) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const mouse = useMouse();
  const columns = dimensions?.columns ?? stdout?.columns ?? 120;
  const terminalRows = dimensions?.rows ?? stdout?.rows ?? 40;

  const leftWidth = Math.max(34, Math.floor(columns * 0.27));
  const rightWidth = Math.max(78, columns - leftWidth - 4);
  const diffContentWidth = Math.max(1, rightWidth - 4);
  const treeContentWidth = Math.max(1, leftWidth - 4);
  const contentHeight = Math.max(terminalRows - 9, 10);
  // Pane overhead: 2 borders + header rows.
  // Tree has 1 header row; diff has 2 (filename + metrics).
  const visibleTreeRows = Math.max(contentHeight - 3, 4);
  const visibleDiffRows = Math.max(contentHeight - 4, 6);

  const sections = useMemo(
    () => wrapSections(rawSections, diffContentWidth),
    [rawSections, diffContentWidth],
  );

  const files = useMemo(() => sections.map((section) => section.path), [sections]);
  const statusByPath = useMemo(() => new Map(review?.files.map((file) => [file.path, file.status]) ?? []), [review]);
  const [collapsedTreePaths, setCollapsedTreePaths] = useState<Set<string>>(() => new Set());
  const allTreeRows = useMemo(() => buildTreeRows(files, statusByPath), [files, statusByPath]);
  const rows = useMemo(() => applyTreeCollapse(allTreeRows, collapsedTreePaths), [allTreeRows, collapsedTreePaths]);
  const allDiffLines = useMemo(() => flattenSectionLines(sections), [sections]);

  const maxDiffOffset = Math.max(allDiffLines.length - visibleDiffRows, 0);
  const maxTreeOffset = Math.max(rows.length - visibleTreeRows, 0);

  const treePanelRef = useRef<DOMElement>(null);
  const diffPanelRef = useRef<DOMElement>(null);
  const [diffOffset, setDiffOffset] = useState(0);
  const [treeOffset, setTreeOffset] = useState(0);
  const [treeHovered, setTreeHovered] = useState(false);
  const [diffHovered, setDiffHovered] = useState(false);
  const [hoveredTreeRow, setHoveredTreeRow] = useState<number | null>(null);
  const [hoveredBlockLineIndex, setHoveredBlockLineIndex] = useState<number | null>(null);
  const [hoveredAction, setHoveredAction] = useState<HoveredAction>(null);
  const [copiedAction, setCopiedAction] = useState<CopiedAction | null>(null);
  const [codeSelection, setCodeSelectionState] = useState<CodeSelection | null>(null);
  const codeSelectionRef = useRef<CodeSelection | null>(null);
  const renderedCodeSelectionRef = useRef<CodeSelection | null>(null);
  const pendingCodeSelectionRef = useRef<CodeSelection | null>(null);
  const codeSelectionRenderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastCodeSelectionRenderAtRef = useRef(0);
  const [toast, setToast] = useState<string | null>(null);
  const viewSnapshotRef = useRef({
    path: '',
    sectionIndex: 0,
    relativeOffset: 0,
  });

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
    () => findFocusedBlockLineIndex(allDiffLines, activeSection, diffOffset),
    [activeSection, allDiffLines, diffOffset],
  );
  const focusedBlock = useMemo(() => {
    const focusedLine = focusedBlockLineIndex === null ? undefined : allDiffLines[focusedBlockLineIndex];
    return focusedLine ? findBlockTargetFromLine(focusedLine, review)?.block : activeFile?.blocks[0];
  }, [activeFile, allDiffLines, focusedBlockLineIndex, review]);

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

  const visibleRows = rows.slice(treeOffset, treeOffset + visibleTreeRows);
  const visibleDiffLines = allDiffLines.slice(diffOffset, diffOffset + visibleDiffRows);
  const visibleLineStart = diffOffset + 1;
  const visibleLineEnd = Math.min(diffOffset + visibleDiffRows, allDiffLines.length);
  const footerHints = watchStatus
    ? `${watchStatus} • ↑/↓ jump file • j/k scroll • g/G top-bottom • q quit`
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

  const showToast = useCallback((message: string, hint?: string) => {
    setToast(makeToast(message, hint));
  }, []);

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
      showToast('Copy action unavailable.');
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

    showToast(result.toast, result.hint);
  }, [activeFile, copyWriter, focusedBlock, readFileContent, resolveAbsolutePath, review, showToast]);

  const copyFileTree = useCallback(async () => {
    const text = formatTreePayload(allTreeRows);

    try {
      const result = await (copyWriter ?? writeClipboard)(text);
      if (result.ok) {
        setCopiedAction({kind: 'tree-header', id: 'copy.tree'});
        showToast('Copied file tree', `${files.length} files`);
      } else {
        showToast(result.message, result.hint);
      }
    } catch (error) {
      showToast('Clipboard write failed.', error instanceof Error ? error.message : undefined);
    }
  }, [allTreeRows, copyWriter, files.length, showToast]);

  const getCodeSelectionPoint = useCallback((mousePosition: {x: number; y: number}) => {
    const diffBounds = getBounds(diffPanelRef);
    if (!isInside(diffBounds, mousePosition.x, mousePosition.y) || !diffBounds) return null;

    const relativeY = mousePosition.y - diffBounds.top;
    if (relativeY < 3) return null;

    const lineIndex = diffOffset + relativeY - 3;
    if (lineIndex < 0 || lineIndex >= allDiffLines.length) return null;

    const innerColumn = mousePosition.x - diffBounds.left - 2;
    const code = getCodeContentRange(allDiffLines[lineIndex] ?? '');
    if (!code || innerColumn < code.start) return null;

    return {
      lineIndex,
      column: clamp(innerColumn - code.start, 0, code.text.length),
    };
  }, [allDiffLines, diffOffset]);

  const copyCodeSelection = useCallback(async (selection: CodeSelection) => {
    if (compareSelectionPoints(selection.anchor, selection.focus) === 0) {
      setCodeSelection(null);
      return;
    }

    const text = getSelectedCodeText(allDiffLines, selection);
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
        showToast(result.message, result.hint);
      }
    } catch (error) {
      showToast('Clipboard write failed.', error instanceof Error ? error.message : undefined);
    }
  }, [allDiffLines, copyWriter, setCodeSelection, showToast]);

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

        return;
      }

      const mousePosition = normalizeMousePosition(position);
      let nextHoveredAction: HoveredAction = null;
      let nextHoveredBlockLineIndex: number | null = null;
      const treeBounds = getBounds(treePanelRef);
      if (!isInside(treeBounds, mousePosition.x, mousePosition.y) || !treeBounds) {
        setHoveredTreeRow((current) => (current === null ? current : null));
      } else if (isTreeHeaderCopyTarget(treeBounds, mousePosition.x, mousePosition.y, stateRef.current.treeContentWidth)) {
        setHoveredTreeRow((current) => (current === null ? current : null));
        nextHoveredAction = {kind: 'tree-header', id: 'copy.tree'};
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
            if (row?.kind === 'file' && isTreeCopyTarget(relativeX, bounds.width)) {
              nextHoveredAction = {kind: 'tree-copy', rowIndex};
            }
          }
        }
      }

      const diffBounds = getBounds(diffPanelRef);
      if (isInside(diffBounds, mousePosition.x, mousePosition.y) && diffBounds) {
        const relativeY = mousePosition.y - diffBounds.top;
        const relativeX = mousePosition.x - diffBounds.left;
        if (relativeY === 1) {
          const activeStatus = activeFile?.status;
          const status = ansiStatus(activeStatus);
          const inner = Math.max(1, rightWidth - 4);
          const fileLabel = `${status}${status ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', inner)}${ANSI_RESET}`;
          const currentFileHover = hoveredAction?.kind === 'file-header' ? hoveredAction.id : undefined;
          const currentFileCopied = copiedAction?.kind === 'file-header' ? copiedAction.id : undefined;
          const fileHeaderLine = composeLeftRight(fileLabel, fileActions(currentFileHover, currentFileCopied), inner);
          const actionId = getActionFromRenderedLine(relativeX - 2, fileHeaderLine, FILE_ACTIONS);
          if (actionId) {
            nextHoveredAction = {kind: 'file-header', id: actionId};
          }
        } else if (relativeY === 2) {
          const currentFileHover = hoveredAction?.kind === 'file-header' ? hoveredAction.id : undefined;
          const currentFileCopied = copiedAction?.kind === 'file-header' ? copiedAction.id : undefined;
          const activeStatus = activeFile?.status;
          const status = ansiStatus(activeStatus);
          const inner = Math.max(1, rightWidth - 4);
          const fileLabel = `${status}${status ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', inner)}${ANSI_RESET}`;
          const fileHeaderLine = composeLeftRight(fileLabel, fileActions(currentFileHover, currentFileCopied), inner);
          const metricsCore = activeSection
            ? `${formatMetrics(activeSection.metrics)}  ${ANSI_GRAY}file ${activeSectionIndex + 1}/${sections.length}${ANSI_RESET}`
            : `${ANSI_GRAY}No changes to review${ANSI_RESET}`;
          const counter = `${ANSI_GRAY}ln ${visibleLineStart}-${visibleLineEnd}/${allDiffLines.length}${ANSI_RESET}`;
          const metricsWidth = visibleWidth(metricsCore);
          const counterWidth = visibleWidth(counter);
          const metricsLine = `${metricsCore}${' '.repeat(Math.max(1, inner - metricsWidth - counterWidth))}${counter}`;
          const actionId = getActionFromRenderedLine(
            relativeX - 2,
            addAbsolutePathActionToMetricsRow(metricsLine, fileHeaderLine, currentFileHover, currentFileCopied, inner),
            [ABSOLUTE_PATH_ACTION],
          );
          if (actionId) {
            nextHoveredAction = {kind: 'file-header', id: actionId};
          }
        } else {
          const diffLineIndex = diffOffset + relativeY - 3;
          const blockLineIndex = findHoveredBlockLineIndex(allDiffLines, diffLineIndex);
          nextHoveredBlockLineIndex = blockLineIndex;
          const line = blockLineIndex === null ? undefined : allDiffLines[blockLineIndex];
          if (line && blockLineIndex !== null && diffLineIndex === blockLineIndex) {
            const actionId = getActionFromRenderedLine(relativeX - 2, addBlockActionsToLine(line), BLOCK_ACTIONS);
            if (actionId) {
              nextHoveredAction = {kind: 'block', id: actionId, lineIndex: blockLineIndex};
            }
          }
        }
      }

      setHoveredBlockLineIndex((current) => (current === nextHoveredBlockLineIndex ? current : nextHoveredBlockLineIndex));

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
    activeFile,
    activeFilePath,
    activeSection,
    activeSectionIndex,
    allDiffLines,
    copiedAction,
    diffOffset,
    getTreeRowHit,
    hoveredAction,
    hoveredBlockLineIndex,
    mouse,
    rightWidth,
    sections.length,
    visibleLineEnd,
    visibleLineStart,
  ]);

  useEffect(() => {
    const handleDrag = (position: {x: number; y: number}, action: 'dragging' | null) => {
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
  }, [copyCodeSelection, getCodeSelectionPoint, mouse, scheduleCodeSelection, setCodeSelection]);

  useEffect(() => {
    const handleClick = (position: {x: number; y: number}, action: 'press' | 'release' | null) => {
      const mousePosition = normalizeMousePosition(position);
      if (action === 'release') {
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

      const selectionPoint = getCodeSelectionPoint(mousePosition);
      if (selectionPoint) {
        setHoveredAction(null);
        setCodeSelection({anchor: selectionPoint, focus: selectionPoint, active: true});
        return;
      }

      if (codeSelectionRef.current) {
        setCodeSelection(null);
      }

      const treeBounds = getBounds(treePanelRef);
      if (isInside(treeBounds, mousePosition.x, mousePosition.y) && treeBounds) {
        if (isTreeHeaderCopyTarget(treeBounds, mousePosition.x, mousePosition.y, stateRef.current.treeContentWidth)) {
          void copyFileTree();
          return;
        }

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

      if (relativeY === 1) {
        const activeStatus = activeFile?.status;
        const status = ansiStatus(activeStatus);
        const fileLabel = `${status}${status ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', Math.max(1, rightWidth - 4))}${ANSI_RESET}`;
        const currentFileHover = hoveredAction?.kind === 'file-header' ? hoveredAction.id : undefined;
        const currentFileCopied = copiedAction?.kind === 'file-header' ? copiedAction.id : undefined;
        const fileHeaderLine = composeLeftRight(fileLabel, fileActions(currentFileHover, currentFileCopied), Math.max(1, rightWidth - 4));
        const actionId = getActionFromRenderedLine(relativeX - 2, fileHeaderLine, FILE_ACTIONS);
        if (actionId) {
          void runCopyCommand(actionId, activeFile, focusedBlock, {kind: 'file-header', id: actionId});
        }
        return;
      }

      if (relativeY === 2) {
        const currentFileHover = hoveredAction?.kind === 'file-header' ? hoveredAction.id : undefined;
        const currentFileCopied = copiedAction?.kind === 'file-header' ? copiedAction.id : undefined;
        const activeStatus = activeFile?.status;
        const status = ansiStatus(activeStatus);
        const inner = Math.max(1, rightWidth - 4);
        const fileLabel = `${status}${status ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', inner)}${ANSI_RESET}`;
        const fileHeaderLine = composeLeftRight(fileLabel, fileActions(currentFileHover, currentFileCopied), inner);
        const metricsCore = activeSection
          ? `${formatMetrics(activeSection.metrics)}  ${ANSI_GRAY}file ${activeSectionIndex + 1}/${sections.length}${ANSI_RESET}`
          : `${ANSI_GRAY}No changes to review${ANSI_RESET}`;
        const counter = `${ANSI_GRAY}ln ${visibleLineStart}-${visibleLineEnd}/${allDiffLines.length}${ANSI_RESET}`;
        const metricsWidth = visibleWidth(metricsCore);
        const counterWidth = visibleWidth(counter);
        const metricsLine = `${metricsCore}${' '.repeat(Math.max(1, inner - metricsWidth - counterWidth))}${counter}`;
        const actionId = getActionFromRenderedLine(
          relativeX - 2,
          addAbsolutePathActionToMetricsRow(metricsLine, fileHeaderLine, currentFileHover, currentFileCopied, inner),
          [ABSOLUTE_PATH_ACTION],
        );
        if (actionId) {
          void runCopyCommand(actionId, activeFile, focusedBlock, {kind: 'file-header', id: actionId});
        }
        return;
      }

      const diffLineIndex = diffOffset + relativeY - 3;
      const blockLineIndex = findHoveredBlockLineIndex(allDiffLines, diffLineIndex);
      const line = blockLineIndex === null ? undefined : allDiffLines[blockLineIndex];
      if (!line || diffLineIndex !== blockLineIndex) return;

      const blockTarget = findBlockTargetFromLine(line, review);
      const actionId = getActionFromRenderedLine(relativeX - 2, addBlockActionsToLine(line), BLOCK_ACTIONS);
      if (!actionId || !blockTarget) return;

      void runCopyCommand(actionId, blockTarget.file, blockTarget.block, {kind: 'block', id: actionId, lineIndex: blockLineIndex});
    };

    mouse.events.on('click', handleClick);
    return () => mouse.events.off('click', handleClick);
  }, [
    activeFile,
    activeFilePath,
    activeSection,
    activeSectionIndex,
    allDiffLines,
    copiedAction,
    diffOffset,
    getCodeSelectionPoint,
    getTreeRowHit,
    hoveredAction,
    mouse,
    copyCodeSelection,
    copyFileTree,
    jumpToFile,
    review,
    rightWidth,
    runCopyCommand,
    setCodeSelection,
    sections.length,
    showToast,
    toggleTreeDirectory,
    visibleLineEnd,
    visibleLineStart,
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
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Box>
          <Text color="cyanBright" bold>branch-review</Text>
          <Text color="gray"> </Text>
          <Text color="white">{branch}</Text>
          <Text color="gray"> against </Text>
          <Text color="yellow">{base}</Text>
        </Box>
        <Text color="magentaBright">
          {branchMetrics.filesChanged} files • +{branchMetrics.additions} • -{branchMetrics.deletions} • {branchMetrics.changedLines} changed
        </Text>
      </Box>

      <Box>
        <TreePane
          panelRef={treePanelRef}
          width={leftWidth}
          height={contentHeight}
          hovered={treeHovered}
          setHovered={setTreeHovered}
        >
          <Box width={treeContentWidth} justifyContent="space-between">
            <Text color="cyan">Changed files</Text>
            <Text
              color={copiedAction?.kind === 'tree-header' ? 'greenBright' : hoveredAction?.kind === 'tree-header' ? 'cyanBright' : 'gray'}
              bold={copiedAction?.kind === 'tree-header' || hoveredAction?.kind === 'tree-header'}
            >
              {copiedAction?.kind === 'tree-header' ? successLabel(TREE_HEADER_COPY_LABEL) : TREE_HEADER_COPY_LABEL}
            </Text>
          </Box>
          {visibleRows.map((row, index) => (
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

            const activeStatus = review?.files.find((file) => file.path === activeFilePath)?.status;
            const status = ansiStatus(activeStatus);
            const fileLabel = `${status}${status ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', inner)}${ANSI_RESET}`;
            const fileHover = hoveredAction?.kind === 'file-header' ? hoveredAction.id : undefined;
            const fileCopied = copiedAction?.kind === 'file-header' ? copiedAction.id : undefined;
            const fileLabelWithActions = composeLeftRight(fileLabel, review && hasChanges ? fileActions(fileHover, fileCopied) : '', inner);

            const metricsCore = activeSection
              ? `${formatMetrics(activeSection.metrics)}  ${ANSI_GRAY}file ${activeSectionIndex + 1}/${sections.length}${ANSI_RESET}`
              : `${ANSI_GRAY}No changes to review${ANSI_RESET}`;
            const counter = `${ANSI_GRAY}ln ${visibleLineStart}-${visibleLineEnd}/${allDiffLines.length}${ANSI_RESET}`;
            const counterWidth = visibleWidth(counter);
            const metricsWidth = visibleWidth(metricsCore);
            const gap = Math.max(1, inner - metricsWidth - counterWidth);
            const baseMetricsRow = `${metricsCore}${' '.repeat(gap)}${counter}`;
            const metricsRow = addAbsolutePathActionToMetricsRow(
              baseMetricsRow,
              fileLabelWithActions,
              fileHover,
              fileCopied,
              inner,
            );

            const rows: string[] = [
              frameTopBorder(rightWidth, borderAnsi),
              frameLine(fileLabelWithActions, inner, borderAnsi),
              frameLine(metricsRow, inner, borderAnsi),
            ];
            if (!hasChanges) {
              rows.push(frameLine(`${ANSI_CYAN_BRIGHT_BOLD}No changes to review${ANSI_RESET}`, inner, borderAnsi));
              rows.push(frameLine(`${ANSI_GRAY}${emptyStateHint ?? 'Run again after making changes.'}${ANSI_RESET}`, inner, borderAnsi));
            }

            for (const [index, line] of visibleDiffLines.entries()) {
              const absoluteLineIndex = diffOffset + index;
              const blockHover = hoveredAction?.kind === 'block' && hoveredAction.lineIndex === absoluteLineIndex
                ? hoveredAction.id
                : undefined;
              const blockCopied = copiedAction?.kind === 'block' && copiedAction.lineIndex === absoluteLineIndex
                ? copiedAction.id
                : undefined;
              const visibleActionBlockLineIndex = hoveredBlockLineIndex ?? focusedBlockLineIndex;
              const visibleLine = visibleActionBlockLineIndex === absoluteLineIndex
                ? addBlockActionsToLine(line || ' ', blockHover, blockCopied)
                : line || ' ';
              const selectedLine = highlightSelectedCode(visibleLine, absoluteLineIndex, codeSelection);
              rows.push(frameLine(highlightActionLabel(selectedLine, blockHover), inner, borderAnsi));
            }
            rows.push(frameBottomBorder(rightWidth, borderAnsi));

            return rows.map((row, i) => <Text key={`diff-${i}`}>{row}</Text>);
          })()}
        </DiffPane>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
        {toast
          ? <Text color="cyan">✓ {toast}</Text>
          : <Text color="gray">{footerHints}</Text>}
        <Text color="gray">{base}...{branch}</Text>
      </Box>
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
