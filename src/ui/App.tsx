import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, DOMElement, Text, useApp, useInput, useStdout} from 'ink';
import {
  MouseProvider,
  useMouse,
  useOnMouseHover,
} from '@zenobius/ink-mouse';
import {buildTreeRows, type TreeRow} from '../tree.js';
import {
  flattenSectionLines,
  formatMetrics,
  frameBottomBorder,
  frameLine,
  frameTopBorder,
  getSectionIndexForLine,
  HUNK_ACTION_LABELS,
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
import type {ReviewFile, ReviewHunk, ReviewModel} from '../review/model.js';

type AppProps = {
  base: string;
  branch: string;
  sections: DiffSection[];
  branchMetrics: BranchMetrics;
  review?: ReviewModel;
  copyWriter?: ClipboardWriter;
  dimensions?: {columns: number; rows: number};
};

const SCROLL_STEP = 3;
const TOAST_TIMEOUT_MS = 2200;
const FILE_ACTIONS = [
  {id: 'copy.path', label: 'Copy path'},
  {id: 'copy.fileDiff', label: 'Copy diff'},
  {id: 'copy.filePrompt', label: 'Copy prompt'},
] as const;
const HUNK_ACTIONS = [
  {id: 'copy.hunkCode', label: HUNK_ACTION_LABELS.code},
  {id: 'copy.hunkDiff', label: HUNK_ACTION_LABELS.diff},
  {id: 'copy.hunkPrompt', label: HUNK_ACTION_LABELS.prompt},
  {id: 'more', label: HUNK_ACTION_LABELS.more},
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

function getDominantSectionIndex(sections: DiffSection[], startLine: number, endLineExclusive: number) {
  if (sections.length === 0) {
    return -1;
  }

  let bestIndex = getSectionIndexForLine(sections, startLine);
  let bestOverlap = -1;

  for (const [index, section] of sections.entries()) {
    const overlap = Math.min(endLineExclusive, section.endLineExclusive) - Math.max(startLine, section.startLine);
    if (overlap > bestOverlap) {
      bestIndex = index;
      bestOverlap = overlap;
    }
  }

  return bestIndex;
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

function isInside(bounds: {left: number; top: number; width: number; height: number} | null, x: number, y: number) {
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
  width,
  rowRef,
}: {
  row: TreeRow;
  selected: boolean;
  hovered: boolean;
  width: number;
  rowRef?: React.Ref<DOMElement>;
}) {
  const accent = row.kind === 'dir' ? 'yellow' : selected ? 'black' : hovered ? 'cyan' : 'white';
  const background = selected ? 'cyan' : undefined;
  const glyph = row.kind === 'dir' ? '▾' : '•';
  const copyVisible = row.kind === 'file' && (selected || hovered);
  const indicatorWidth = row.kind === 'file' ? 8 : 0;

  return (
    <Box ref={rowRef} width={width}>
      <Box width={Math.max(1, width - indicatorWidth)}>
        <Text color={accent} backgroundColor={background} bold={selected} dimColor={row.kind === 'dir'} wrap="truncate-end">
          {' '.repeat(row.depth * 2)}{glyph} {row.label}
        </Text>
      </Box>
      {row.kind === 'file' && (
        <Box width={indicatorWidth} justifyContent="flex-end">
          <Text color={statusColor(row.status)} backgroundColor={selected ? 'cyan' : undefined} bold={Boolean(row.status)}>
            {statusLabel(row.status)}
          </Text>
          <Text color={copyVisible ? 'cyan' : 'gray'} backgroundColor={selected ? 'cyan' : undefined}>
            {copyVisible ? ' Copy' : '     '}
          </Text>
        </Box>
      )}
    </Box>
  );
});

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
const ANSI_GREEN = '[32m';
const ANSI_RED = '[31m';
const ANSI_YELLOW = '[33m';
const ANSI_MAGENTA = '[35m';
const ANSI_RESET = '[0m';

type HoveredAction =
  | {kind: 'file'; id: string}
  | {kind: 'hunk'; id: string; lineIndex: number}
  | null;

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

function actionButton(label: string, primary = false) {
  const color = primary ? ANSI_CYAN_BRIGHT : ANSI_GRAY;
  return `${ANSI_GRAY}╭─${ANSI_RESET}${color}${label}${ANSI_RESET}${ANSI_GRAY}─╮${ANSI_RESET}`;
}

function composeLeftRight(left: string, right: string, width: number) {
  if (!right) return truncateAnsi(left, width);

  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(1, width - rightWidth - 1);
  const safeLeft = visibleWidth(left) > availableLeft ? truncateAnsi(left, availableLeft) : left;
  const gap = Math.max(1, width - visibleWidth(safeLeft) - rightWidth);
  return `${safeLeft}${' '.repeat(gap)}${right}`;
}

function fileActions(hoveredAction?: string) {
  return FILE_ACTIONS
    .map((action) => actionButton(action.label, action.id === 'copy.filePrompt' || action.id === hoveredAction))
    .join(' ');
}

function highlightActionLabel(line: string, actionId: string | undefined) {
  if (!actionId) return line;

  const action = [...FILE_ACTIONS, ...HUNK_ACTIONS].find((entry) => entry.id === actionId);
  if (!action) return line;

  return line.replace(
    action.label,
    `${ANSI_CYAN_BRIGHT_BOLD}${action.label}${ANSI_RESET}`,
  );
}

function hunkActionsLine(hoveredAction?: string) {
  return HUNK_ACTIONS
    .map((action) => {
      const color = action.id === hoveredAction
        ? ANSI_CYAN_BRIGHT
        : ANSI_GRAY;
      return `${color}${action.label}${ANSI_RESET}`;
    })
    .join('  ');
}

function isHunkContentLine(line: string) {
  return /^│\s+• .+:\d+:/.test(stripAnsi(line));
}

function findHunkContentLineIndex(lines: string[], index: number) {
  for (const candidate of [index, index - 1, index + 1, index - 2, index + 2]) {
    if (candidate >= 0 && candidate < lines.length && isHunkContentLine(lines[candidate] ?? '')) {
      return candidate;
    }
  }

  return null;
}

function findHoveredHunkLineIndex(lines: string[], index: number) {
  const scanFloor = Math.max(0, index - 500);
  for (let candidate = index; candidate >= scanFloor; candidate -= 1) {
    const line = lines[candidate] ?? '';
    if (isHunkContentLine(line)) {
      return candidate;
    }
  }

  return findHunkContentLineIndex(lines, index);
}

function addHunkActionsToLine(line: string, hoveredAction?: string) {
  const plain = stripAnsi(line);
  if (!isHunkContentLine(line)) return line;

  const contentStart = plain.indexOf('│ ') + 2;
  const contentEnd = plain.lastIndexOf(' │');
  if (contentStart < 2 || contentEnd <= contentStart) return line;

  const contentWidth = contentEnd - contentStart;
  const leftText = plain.slice(contentStart, contentEnd).trimEnd();
  const content = composeLeftRight(`${ANSI_CYAN}${leftText}${ANSI_RESET}`, hunkActionsLine(hoveredAction), contentWidth);

  return `${ANSI_CYAN}│${ANSI_RESET} ${content} ${ANSI_CYAN}│${ANSI_RESET}`;
}

function stripAnsi(line: string) {
  return line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function makeToast(message: string, hint?: string) {
  return hint ? `${message} · ${hint}` : message;
}

function isTreeCopyTarget(relativeX: number, width: number) {
  return relativeX >= Math.max(0, width - 5);
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

function findHunkFromLine(line: string, activeFile: ReviewFile | undefined): ReviewHunk | undefined {
  if (!activeFile) return undefined;
  const plain = stripAnsi(line);
  const match = plain.match(/•\s+(.+):(\d+):/);
  if (!match) return undefined;

  const lineStart = Number(match[2]);
  return activeFile.hunks.find((hunk) => hunk.lineStart === lineStart) ?? activeFile.hunks[0];
}

function AppContent({base, branch, sections: rawSections, branchMetrics, review, copyWriter, dimensions}: AppProps) {
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
  const rows = useMemo(() => buildTreeRows(files, statusByPath), [files, statusByPath]);
  const allDiffLines = useMemo(() => flattenSectionLines(sections), [sections]);

  const maxDiffOffset = Math.max(allDiffLines.length - visibleDiffRows, 0);
  const maxTreeOffset = Math.max(rows.length - visibleTreeRows, 0);

  const treePanelRef = useRef<DOMElement>(null);
  const diffPanelRef = useRef<DOMElement>(null);
  const treeRowRefs = useRef(new Map<number, DOMElement>());
  const [diffOffset, setDiffOffset] = useState(0);
  const [treeOffset, setTreeOffset] = useState(0);
  const [treeHovered, setTreeHovered] = useState(false);
  const [diffHovered, setDiffHovered] = useState(false);
  const [hoveredTreeRow, setHoveredTreeRow] = useState<number | null>(null);
  const [hoveredHunkLineIndex, setHoveredHunkLineIndex] = useState<number | null>(null);
  const [hoveredAction, setHoveredAction] = useState<HoveredAction>(null);
  const [toast, setToast] = useState<string | null>(null);

  const activeSectionIndex = getDominantSectionIndex(sections, diffOffset, diffOffset + visibleDiffRows);
  const activeSection = activeSectionIndex >= 0 ? sections[activeSectionIndex] : null;
  const activeFilePath = activeSection?.path ?? '';
  const activeRowIndex = rows.findIndex((row) => row.path === activeFilePath);
  const activeFile = useMemo(
    () => review?.files.find((file) => file.path === activeFilePath),
    [activeFilePath, review],
  );
  const focusedHunk = activeFile?.hunks[0];

  const stateRef = useRef({
    treeOffset,
    maxTreeOffset,
    maxDiffOffset,
    visibleTreeRows,
    rows,
  });
  stateRef.current = {treeOffset, maxTreeOffset, maxDiffOffset, visibleTreeRows, rows};

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

  const setTreeRowRef = useCallback((rowIndex: number) => (element: DOMElement | null) => {
    if (element) {
      treeRowRefs.current.set(rowIndex, element);
      return;
    }

    treeRowRefs.current.delete(rowIndex);
  }, []);

  const getTreeRowHit = useCallback((x: number, y: number) => {
    for (const [rowIndex, element] of treeRowRefs.current) {
      const bounds = getNodeBounds(element);
      if (bounds && isInside(bounds, x, y)) {
        return {rowIndex, bounds};
      }
    }

    return null;
  }, []);

  const showToast = useCallback((message: string, hint?: string) => {
    setToast(makeToast(message, hint));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(null), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [toast]);

  const runCopyCommand = useCallback(async (commandId: string, commandFile = activeFile, commandHunk = focusedHunk) => {
    if (!review || !commandFile) {
      showToast('Copy action unavailable.');
      return;
    }

    const result = await executeCopyCommand(commandId, {
      model: review,
      activeFile: commandFile,
      focusedHunk: commandHunk,
    }, copyWriter ? {write: copyWriter} : {});

    showToast(result.toast, result.hint);
  }, [activeFile, copyWriter, focusedHunk, review, showToast]);

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
      const mousePosition = normalizeMousePosition(position);
      let nextHoveredAction: HoveredAction = null;
      let nextHoveredHunkLineIndex: number | null = null;
      const treeBounds = getBounds(treePanelRef);
      if (!isInside(treeBounds, mousePosition.x, mousePosition.y) || !treeBounds) {
        setHoveredTreeRow((current) => (current === null ? current : null));
      } else {
        const treeRowHit = getTreeRowHit(mousePosition.x, mousePosition.y);
        if (!treeRowHit) {
          setHoveredTreeRow((current) => (current === null ? current : null));
        } else {
          const {rowIndex, bounds} = treeRowHit;
          if (rowIndex < 0 || rowIndex >= stateRef.current.rows.length) {
            setHoveredTreeRow((current) => (current === null ? current : null));
          } else {
            setHoveredTreeRow((current) => (current === rowIndex ? current : rowIndex));
            const row = stateRef.current.rows[rowIndex];
            const relativeX = mousePosition.x - bounds.left;
            if (row?.kind === 'file' && isTreeCopyTarget(relativeX, bounds.width)) {
              nextHoveredAction = {kind: 'file', id: 'copy.path'};
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
          const fileHeaderLine = composeLeftRight(fileLabel, fileActions(), inner);
          const actionId = getActionFromRenderedLine(relativeX - 2, fileHeaderLine, FILE_ACTIONS);
          if (actionId) {
            nextHoveredAction = {kind: 'file', id: actionId};
          }
        } else {
          const diffLineIndex = diffOffset + relativeY - 3;
          const hunkLineIndex = findHoveredHunkLineIndex(allDiffLines, diffLineIndex);
          nextHoveredHunkLineIndex = hunkLineIndex;
          const line = hunkLineIndex === null ? undefined : allDiffLines[hunkLineIndex];
          if (line && hunkLineIndex !== null && diffLineIndex === hunkLineIndex) {
            const actionId = getActionFromRenderedLine(relativeX - 2, addHunkActionsToLine(line), HUNK_ACTIONS);
            if (actionId) {
              nextHoveredAction = {kind: 'hunk', id: actionId, lineIndex: hunkLineIndex};
            }
          }
        }
      }

      setHoveredHunkLineIndex((current) => (current === nextHoveredHunkLineIndex ? current : nextHoveredHunkLineIndex));

      setHoveredAction((current) => {
        if (current?.kind === nextHoveredAction?.kind && current?.id === nextHoveredAction?.id) {
          if (current?.kind !== 'hunk' || nextHoveredAction?.kind !== 'hunk' || current.lineIndex === nextHoveredAction.lineIndex) {
            return current;
          }
        }

        return nextHoveredAction;
      });
    };

    mouse.events.on('position', handlePosition);
    return () => mouse.events.off('position', handlePosition);
  }, [
    activeFile,
    activeFilePath,
    allDiffLines,
    diffOffset,
    getTreeRowHit,
    mouse,
    rightWidth,
  ]);

  useEffect(() => {
    const handleClick = (position: {x: number; y: number}, action: 'press' | 'release' | null) => {
      if (action !== 'press') return;
      const mousePosition = normalizeMousePosition(position);
      const treeBounds = getBounds(treePanelRef);
      if (isInside(treeBounds, mousePosition.x, mousePosition.y) && treeBounds) {
        const treeRowHit = getTreeRowHit(mousePosition.x, mousePosition.y);
        if (!treeRowHit) return;

        const {rowIndex, bounds} = treeRowHit;
        const row = stateRef.current.rows[rowIndex];
        if (row && row.kind === 'file') {
          const relativeX = mousePosition.x - bounds.left;
          const rowFile = review?.files.find((file) => file.path === row.path);
          if (isTreeCopyTarget(relativeX, bounds.width) && rowFile) {
            void runCopyCommand('copy.path', rowFile, rowFile.hunks[0]);
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
        const fileHeaderLine = composeLeftRight(fileLabel, fileActions(), Math.max(1, rightWidth - 4));
        const actionId = getActionFromRenderedLine(relativeX - 2, fileHeaderLine, FILE_ACTIONS);
        if (actionId) {
          void runCopyCommand(actionId);
        }
        return;
      }

      const diffLineIndex = diffOffset + relativeY - 3;
      const hunkLineIndex = findHoveredHunkLineIndex(allDiffLines, diffLineIndex);
      const line = hunkLineIndex === null ? undefined : allDiffLines[hunkLineIndex];
      if (!line || diffLineIndex !== hunkLineIndex) return;

      const hunk = findHunkFromLine(line, activeFile);
      const actionId = getActionFromRenderedLine(relativeX - 2, addHunkActionsToLine(line), HUNK_ACTIONS);
      if (!actionId) return;

      if (actionId === 'more') {
        showToast('More actions coming soon.');
        return;
      }

      void runCopyCommand(actionId, activeFile, hunk);
    };

    mouse.events.on('click', handleClick);
    return () => mouse.events.off('click', handleClick);
  }, [
    activeFile,
    allDiffLines,
    diffOffset,
    getTreeRowHit,
    mouse,
    jumpToFile,
    review,
    rightWidth,
    runCopyCommand,
    showToast,
  ]);

  const visibleRows = rows.slice(treeOffset, treeOffset + visibleTreeRows);
  const visibleDiffLines = allDiffLines.slice(diffOffset, diffOffset + visibleDiffRows);
  const visibleLineStart = diffOffset + 1;
  const visibleLineEnd = Math.min(diffOffset + visibleDiffRows, allDiffLines.length);
  const treeRowStart = rows.length === 0 ? 0 : treeOffset + 1;
  const treeRowEnd = Math.min(treeOffset + visibleTreeRows, rows.length);
  const treeCounter = `${treeRowStart}-${treeRowEnd}/${rows.length}`;

  useInput((input, key) => {
    if (key.downArrow) {
      jumpToSection(activeSectionIndex + 1);
      return;
    }

    if (key.upArrow) {
      jumpToSection(activeSectionIndex - 1);
      return;
    }

    if (input === 'j') {
      setDiffOffset(applyScrollDelta(diffOffset, maxDiffOffset, 1));
      return;
    }

    if (input === 'k') {
      setDiffOffset(applyScrollDelta(diffOffset, maxDiffOffset, -1));
      return;
    }

    if (key.pageDown) {
      setDiffOffset(applyScrollDelta(diffOffset, maxDiffOffset, visibleDiffRows));
      return;
    }

    if (key.pageUp) {
      setDiffOffset(applyScrollDelta(diffOffset, maxDiffOffset, -visibleDiffRows));
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
          <Text>{composeLeftRight(`${ANSI_CYAN}Changed files${ANSI_RESET}`, `${ANSI_GRAY}${treeCounter}${ANSI_RESET}`, treeContentWidth)}</Text>
          {visibleRows.map((row, index) => (
            <TreeFileRow
              key={row.path}
              row={row}
              selected={row.kind === 'file' && row.path === activeFilePath}
              hovered={hoveredTreeRow !== null && hoveredTreeRow === treeOffset + index}
              width={treeContentWidth}
              rowRef={setTreeRowRef(treeOffset + index)}
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

            const activeStatus = review?.files.find((file) => file.path === activeFilePath)?.status;
            const status = ansiStatus(activeStatus);
            const fileLabel = `${status}${status ? ' ' : ''}${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', inner)}${ANSI_RESET}`;
            const fileHover = hoveredAction?.kind === 'file' ? hoveredAction.id : undefined;
            const fileLabelWithActions = composeLeftRight(fileLabel, review ? fileActions(fileHover) : '', inner);

            const metricsCore = activeSection
              ? `${formatMetrics(activeSection.metrics)}  ${ANSI_GRAY}file ${activeSectionIndex + 1}/${sections.length}${ANSI_RESET}`
              : `${ANSI_GRAY}No diff loaded.${ANSI_RESET}`;
            const counter = `${ANSI_GRAY}ln ${visibleLineStart}-${visibleLineEnd}/${allDiffLines.length}${ANSI_RESET}`;
            const counterWidth = visibleWidth(counter);
            const metricsWidth = visibleWidth(metricsCore);
            const gap = Math.max(1, inner - metricsWidth - counterWidth);
            const metricsRow = `${metricsCore}${' '.repeat(gap)}${counter}`;

            const rows: string[] = [
              frameTopBorder(rightWidth, borderAnsi),
              frameLine(fileLabelWithActions, inner, borderAnsi),
              frameLine(metricsRow, inner, borderAnsi),
            ];
            for (const [index, line] of visibleDiffLines.entries()) {
              const absoluteLineIndex = diffOffset + index;
              const hunkHover = hoveredAction?.kind === 'hunk' && hoveredAction.lineIndex === absoluteLineIndex
                ? hoveredAction.id
                : undefined;
              const visibleLine = hoveredHunkLineIndex === absoluteLineIndex
                ? addHunkActionsToLine(line || ' ', hunkHover)
                : line || ' ';
              rows.push(frameLine(highlightActionLabel(visibleLine, hunkHover), inner, borderAnsi));
            }
            rows.push(frameBottomBorder(rightWidth, borderAnsi));

            return rows.map((row, i) => <Text key={`diff-${i}`}>{row}</Text>);
          })()}
        </DiffPane>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
        {toast
          ? <Text color="cyan">✓ {toast}</Text>
          : <Text color="gray">{process.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} palette • y copy menu • ↑/↓ jump file • PgUp/PgDn page • g/G top-bottom • / search • q quit</Text>}
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
