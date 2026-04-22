import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, DOMElement, Text, useApp, useInput, useStdout} from 'ink';
import {
  MouseProvider,
  useMouseAction,
  useOnMouseClick,
  useOnMouseHover,
} from '@zenobius/ink-mouse';
import {buildTreeRows, type TreeRow} from '../tree.js';
import {
  flattenSectionLines,
  formatMetrics,
  getSectionForLine,
  getSectionIndexForLine,
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function applyScrollDelta(currentOffset: number, maxOffset: number, delta: number) {
  return clamp(currentOffset + delta, 0, maxOffset);
}

export function applyMouseScroll(currentOffset: number, maxOffset: number, action: string | undefined) {
  if (action === 'scrolldown') {
    return applyScrollDelta(currentOffset, maxOffset, 1);
  }

  if (action === 'scrollup') {
    return applyScrollDelta(currentOffset, maxOffset, -1);
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

const TreeFileRow = memo(function TreeFileRow({
  row,
  selected,
  onSelect,
}: {
  row: TreeRow;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const [hovered, setHovered] = useState(false);

  useOnMouseHover(ref, setHovered);
  useOnMouseClick(ref, (clicked) => {
    if (clicked && row.kind === 'file') {
      onSelect(row.path);
    }
  });

  const accent = row.kind === 'dir' ? 'yellow' : selected ? 'black' : hovered ? 'cyan' : 'white';
  const background = selected ? 'cyan' : undefined;
  const glyph = row.kind === 'dir' ? '▾' : '•';

  return (
    <Box ref={ref} flexShrink={0}>
      <Text color={accent} backgroundColor={background} bold={selected} dimColor={row.kind === 'dir'} wrap="truncate-end">
        {' '.repeat(row.depth * 2)}{glyph} {row.label}
      </Text>
    </Box>
  );
});

function AppContent({base, branch, sections, branchMetrics, dimensions}: AppProps) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const columns = dimensions?.columns ?? stdout?.columns ?? 120;
  const terminalRows = dimensions?.rows ?? stdout?.rows ?? 40;

  const files = useMemo(() => sections.map((section) => section.path), [sections]);
  const rows = useMemo(() => buildTreeRows(files), [files]);
  const allDiffLines = useMemo(() => flattenSectionLines(sections), [sections]);

  const leftWidth = Math.max(34, Math.floor(columns * 0.27));
  const rightWidth = Math.max(78, columns - leftWidth - 4);
  const contentHeight = Math.max(terminalRows - 9, 10);
  const visibleTreeRows = Math.max(contentHeight - 2, 4);
  const visibleDiffRows = Math.max(contentHeight - 2, 6);
  const maxDiffOffset = Math.max(allDiffLines.length - visibleDiffRows, 0);
  const maxTreeOffset = Math.max(rows.length - visibleTreeRows, 0);

  const treePanelRef = useRef<DOMElement>(null);
  const diffPanelRef = useRef<DOMElement>(null);
  const [diffOffset, setDiffOffset] = useState(0);
  const [treeOffset, setTreeOffset] = useState(0);
  const [diffHovered, setDiffHovered] = useState(false);
  const [treeHovered, setTreeHovered] = useState(false);
  const mouseAction = useMouseAction();

  useOnMouseHover(treePanelRef, setTreeHovered);
  useOnMouseHover(diffPanelRef, setDiffHovered);

  const activeSectionIndex = getSectionIndexForLine(sections, diffOffset);
  const activeSection = getSectionForLine(sections, diffOffset);
  const activeFilePath = activeSection?.path ?? '';
  const activeRowIndex = rows.findIndex((row) => row.path === activeFilePath);

  useEffect(() => {
    setDiffOffset((current) => clamp(current, 0, maxDiffOffset));
  }, [maxDiffOffset]);

  useEffect(() => {
    setTreeOffset((current) => {
      const clamped = clamp(current, 0, maxTreeOffset);
      return ensureVisible(activeRowIndex, clamped, visibleTreeRows);
    });
  }, [activeRowIndex, maxTreeOffset, visibleTreeRows]);

  useEffect(() => {
    if (mouseAction !== 'scrollup' && mouseAction !== 'scrolldown') {
      return;
    }

    if (treeHovered) {
      setTreeOffset((current) => applyMouseScroll(current, maxTreeOffset, mouseAction));
      return;
    }

    if (diffHovered) {
      setDiffOffset((current) => applyMouseScroll(current, maxDiffOffset, mouseAction));
    }
  }, [mouseAction, treeHovered, diffHovered, maxTreeOffset, maxDiffOffset]);

  const visibleRows = rows.slice(treeOffset, treeOffset + visibleTreeRows);
  const visibleDiffLines = allDiffLines.slice(diffOffset, diffOffset + visibleDiffRows);
  const visibleLineStart = diffOffset + 1;
  const visibleLineEnd = Math.min(diffOffset + visibleDiffRows, allDiffLines.length);
  const treeRowStart = rows.length === 0 ? 0 : treeOffset + 1;
  const treeRowEnd = Math.min(treeOffset + visibleTreeRows, rows.length);

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
        <Box
          ref={treePanelRef}
          width={leftWidth}
          height={contentHeight}
          flexDirection="column"
          flexShrink={0}
          overflow="hidden"
          borderStyle="round"
          borderColor={treeHovered ? 'cyan' : 'gray'}
          paddingX={1}
          marginRight={1}
        >
          <Box justifyContent="space-between" flexShrink={0}>
            <Text color="cyan">Changed files</Text>
            <Text color="gray">{treeRowStart}-{treeRowEnd}/{rows.length}</Text>
          </Box>
          {visibleRows.map((row) => (
            <TreeFileRow
              key={row.path}
              row={row}
              selected={row.kind === 'file' && row.path === activeFilePath}
              onSelect={jumpToFile}
            />
          ))}
        </Box>

        <Box
          ref={diffPanelRef}
          width={rightWidth}
          height={contentHeight}
          flexDirection="column"
          flexShrink={0}
          overflow="hidden"
          borderStyle="round"
          borderColor={diffHovered ? 'cyan' : 'gray'}
          paddingX={1}
        >
          <Box justifyContent="space-between" flexShrink={0}>
            <Text color="cyan" bold wrap="truncate-end">{activeFilePath}</Text>
            <Text color="gray">lines {visibleLineStart}-{visibleLineEnd}/{allDiffLines.length}</Text>
          </Box>
          {activeSection ? (
            <Text color="yellow" wrap="truncate-end">{formatMetrics(activeSection.metrics)} • section {activeSectionIndex + 1}/{sections.length}</Text>
          ) : (
            <Text color="gray">No diff loaded.</Text>
          )}
          {visibleDiffLines.map((line, index) => (
            <Text key={`${diffOffset}-${index}`} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
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
