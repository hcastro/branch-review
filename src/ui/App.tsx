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
  getSectionIndexForLine,
  padToWidth,
  truncateAnsi,
  visibleWidth,
  wrapSections,
  type BranchMetrics,
  type DiffSection,
} from '../sections.js';

type AppProps = {
  base: string;
  branch: string;
  sections: DiffSection[];
  branchMetrics: BranchMetrics;
  dimensions?: {columns: number; rows: number};
};

const SCROLL_STEP = 3;
const DIFF_PANE_PADDING_X = 2;

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

function getBounds(ref: React.RefObject<DOMElement>) {
  const node = ref.current;
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

function isInside(bounds: {left: number; top: number; width: number; height: number} | null, x: number, y: number) {
  if (!bounds) return false;
  return x >= bounds.left && x < bounds.left + bounds.width && y >= bounds.top && y < bounds.top + bounds.height;
}

const TreeFileRow = memo(function TreeFileRow({
  row,
  selected,
  hovered,
}: {
  row: TreeRow;
  selected: boolean;
  hovered: boolean;
}) {
  const accent = row.kind === 'dir' ? 'yellow' : selected ? 'black' : hovered ? 'cyan' : 'white';
  const background = selected ? 'cyan' : undefined;
  const glyph = row.kind === 'dir' ? '▾' : '•';

  return (
    <Box>
      <Text color={accent} backgroundColor={background} bold={selected} dimColor={row.kind === 'dir'} wrap="truncate-end">
        {' '.repeat(row.depth * 2)}{glyph} {row.label}
      </Text>
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
      borderStyle="round"
      borderColor={hovered ? 'cyan' : 'gray'}
      paddingX={DIFF_PANE_PADDING_X}
    >
      {children}
    </Box>
  );
}

const ANSI_CYAN_BRIGHT_BOLD = '[96;1m';
const ANSI_GRAY = '[90m';
const ANSI_RESET = '[0m';

function truncateStart(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return '…'.slice(0, maxWidth);
  return '…' + text.slice(text.length - maxWidth + 1);
}

function AppContent({base, branch, sections: rawSections, branchMetrics, dimensions}: AppProps) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const mouse = useMouse();
  const columns = dimensions?.columns ?? stdout?.columns ?? 120;
  const terminalRows = dimensions?.rows ?? stdout?.rows ?? 40;

  const leftWidth = Math.max(34, Math.floor(columns * 0.27));
  const rightWidth = Math.max(78, columns - leftWidth - 4);
  const diffContentWidth = Math.max(1, rightWidth - 2 - DIFF_PANE_PADDING_X * 2);
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
  const rows = useMemo(() => buildTreeRows(files), [files]);
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

  const activeSectionIndex = getDominantSectionIndex(sections, diffOffset, diffOffset + visibleDiffRows);
  const activeSection = activeSectionIndex >= 0 ? sections[activeSectionIndex] : null;
  const activeFilePath = activeSection?.path ?? '';
  const activeRowIndex = rows.findIndex((row) => row.path === activeFilePath);

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

  useEffect(() => {
    const handleScroll = (position: {x: number; y: number}, direction: 'scrollup' | 'scrolldown' | null) => {
      if (direction !== 'scrollup' && direction !== 'scrolldown') return;
      const delta = direction === 'scrollup' ? -SCROLL_STEP : SCROLL_STEP;

      const treeBounds = getBounds(treePanelRef);
      if (isInside(treeBounds, position.x, position.y)) {
        setTreeOffset((current) => applyScrollDelta(current, stateRef.current.maxTreeOffset, delta));
        return;
      }

      const diffBounds = getBounds(diffPanelRef);
      if (isInside(diffBounds, position.x, position.y)) {
        setDiffOffset((current) => applyScrollDelta(current, stateRef.current.maxDiffOffset, delta));
      }
    };

    mouse.events.on('scroll', handleScroll);
    return () => mouse.events.off('scroll', handleScroll);
  }, [mouse]);

  useEffect(() => {
    const handlePosition = (position: {x: number; y: number}) => {
      const treeBounds = getBounds(treePanelRef);
      if (!isInside(treeBounds, position.x, position.y) || !treeBounds) {
        setHoveredTreeRow((current) => (current === null ? current : null));
        return;
      }

      const relativeY = position.y - treeBounds.top - 3;
      if (relativeY < 0 || relativeY >= stateRef.current.visibleTreeRows) {
        setHoveredTreeRow((current) => (current === null ? current : null));
        return;
      }

      const rowIndex = stateRef.current.treeOffset + relativeY;
      if (rowIndex < 0 || rowIndex >= stateRef.current.rows.length) {
        setHoveredTreeRow((current) => (current === null ? current : null));
        return;
      }

      setHoveredTreeRow((current) => (current === rowIndex ? current : rowIndex));
    };

    mouse.events.on('position', handlePosition);
    return () => mouse.events.off('position', handlePosition);
  }, [mouse]);

  useEffect(() => {
    const handleClick = (position: {x: number; y: number}, action: 'press' | 'release' | null) => {
      if (action !== 'press') return;
      const treeBounds = getBounds(treePanelRef);
      if (!isInside(treeBounds, position.x, position.y) || !treeBounds) return;

      const relativeY = position.y - treeBounds.top - 3;
      if (relativeY < 0 || relativeY >= stateRef.current.visibleTreeRows) return;

      const rowIndex = stateRef.current.treeOffset + relativeY;
      const row = stateRef.current.rows[rowIndex];
      if (row && row.kind === 'file') {
        jumpToFile(row.path);
      }
    };

    mouse.events.on('click', handleClick);
    return () => mouse.events.off('click', handleClick);
  }, [mouse, jumpToFile]);

  const visibleRows = rows.slice(treeOffset, treeOffset + visibleTreeRows);
  const visibleDiffLines = allDiffLines.slice(diffOffset, diffOffset + visibleDiffRows);
  const visibleLineStart = diffOffset + 1;
  const visibleLineEnd = Math.min(diffOffset + visibleDiffRows, allDiffLines.length);
  const treeRowStart = rows.length === 0 ? 0 : treeOffset + 1;
  const treeRowEnd = Math.min(treeOffset + visibleTreeRows, rows.length);

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
          <Box justifyContent="space-between">
            <Text color="cyan">Changed files</Text>
            <Text color="gray">{treeRowStart}-{treeRowEnd}/{rows.length}</Text>
          </Box>
          {visibleRows.map((row, index) => (
            <TreeFileRow
              key={row.path}
              row={row}
              selected={row.kind === 'file' && row.path === activeFilePath}
              hovered={hoveredTreeRow !== null && hoveredTreeRow === treeOffset + index}
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
            const inner = diffContentWidth;

            const fileLabel = `${ANSI_CYAN_BRIGHT_BOLD}${truncateStart(activeFilePath || ' ', inner)}${ANSI_RESET}`;

            const metricsCore = activeSection
              ? `${formatMetrics(activeSection.metrics)}  ${ANSI_GRAY}file ${activeSectionIndex + 1}/${sections.length}${ANSI_RESET}`
              : `${ANSI_GRAY}No diff loaded.${ANSI_RESET}`;
            const counter = `${ANSI_GRAY}ln ${visibleLineStart}-${visibleLineEnd}/${allDiffLines.length}${ANSI_RESET}`;
            const counterWidth = visibleWidth(counter);
            const metricsWidth = visibleWidth(metricsCore);
            const gap = Math.max(1, inner - metricsWidth - counterWidth);
            const metricsRow = padToWidth(`${metricsCore}${' '.repeat(gap)}${counter}`, inner);

            return (
              <>
                <Text>{padToWidth(truncateAnsi(fileLabel, inner), inner)}</Text>
                <Text>{metricsRow}</Text>
                {visibleDiffLines.map((line, i) => (
                  <Text key={`diff-${i}`}>
                    {padToWidth(truncateAnsi(line || ' ', inner), inner)}
                  </Text>
                ))}
              </>
            );
          })()}
        </DiffPane>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text color="gray">scroll hovered pane • ↑/↓ jump file • click file jumps diff • PgUp/PgDn page • g/G top-bottom • q quit</Text>
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
