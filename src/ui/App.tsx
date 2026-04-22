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
    <Box ref={ref}>
      <Text color={accent} backgroundColor={background} bold={selected} dimColor={row.kind === 'dir'} wrap="truncate-end">
        {' '.repeat(row.depth * 2)}{glyph} {row.label}
      </Text>
    </Box>
  );
});

function DiffPanel({
  panelRef,
  width,
  height,
  diffHovered,
  setDiffHovered,
  children,
}: {
  panelRef: React.RefObject<DOMElement>;
  width: number;
  height: number;
  diffHovered: boolean;
  setDiffHovered: (hovered: boolean) => void;
  children: React.ReactNode;
}) {
  useOnMouseHover(panelRef, setDiffHovered);

  return (
    <Box
      ref={panelRef}
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={diffHovered ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {children}
    </Box>
  );
}

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

  const diffPanelRef = useRef<DOMElement>(null);
  const [diffOffset, setDiffOffset] = useState(0);
  const [diffHovered, setDiffHovered] = useState(false);
  const mouseAction = useMouseAction();

  const activeSectionIndex = getSectionIndexForLine(sections, diffOffset);
  const activeSection = getSectionForLine(sections, diffOffset);
  const activeFilePath = activeSection?.path ?? '';
  const activeRowIndex = rows.findIndex((row) => row.path === activeFilePath);
  const treeOffset = ensureVisible(activeRowIndex, 0, visibleTreeRows);
  const visibleRows = rows.slice(treeOffset, treeOffset + visibleTreeRows);
  const visibleDiffLines = allDiffLines.slice(diffOffset, diffOffset + visibleDiffRows);
  const visibleLineStart = diffOffset + 1;
  const visibleLineEnd = Math.min(diffOffset + visibleDiffRows, allDiffLines.length);

  useEffect(() => {
    setDiffOffset((current) => clamp(current, 0, maxDiffOffset));
  }, [maxDiffOffset]);

  useEffect(() => {
    if (mouseAction !== 'scrollup' && mouseAction !== 'scrolldown') {
      return;
    }

    setDiffOffset((current) => applyMouseScroll(current, maxDiffOffset, mouseAction));
  }, [maxDiffOffset, mouseAction]);

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
      const next = applyScrollDelta(diffOffset, maxDiffOffset, 1);
      setDiffOffset(next);
      return;
    }

    if (input === 'k') {
      const next = applyScrollDelta(diffOffset, maxDiffOffset, -1);
      setDiffOffset(next);
      return;
    }

    if (key.pageDown) {
      const next = applyScrollDelta(diffOffset, maxDiffOffset, visibleDiffRows);
      setDiffOffset(next);
      return;
    }

    if (key.pageUp) {
      const next = applyScrollDelta(diffOffset, maxDiffOffset, -visibleDiffRows);
      setDiffOffset(next);
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
        <Box width={leftWidth} height={contentHeight} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginRight={1}>
          <Box justifyContent="space-between">
            <Text color="cyan">Changed files</Text>
            <Text color="gray">{Math.max(activeSectionIndex + 1, 0)}/{sections.length}</Text>
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

        <DiffPanel
          panelRef={diffPanelRef}
          width={rightWidth}
          height={contentHeight}
          diffHovered={diffHovered}
          setDiffHovered={setDiffHovered}
        >
          <Box justifyContent="space-between">
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
        </DiffPanel>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text color="gray">trackpad scroll • ↑/↓ jump file • click file jumps diff • PgUp/PgDn page • g/G top-bottom • q quit</Text>
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
