import type {FileStatus} from './git.js';

export type TreeRow = {
  // Unique per row: a file and a directory can share a path (`bin/tool` and
  // `bin/tool/index.js`), so the id is `${kind}:${path}`.
  id: string;
  kind: 'dir' | 'file';
  label: string;
  depth: number;
  path: string;
  // What identifies the row's file: its path, unless two files show the same
  // path text (a name that failed to decode next to a real file named like
  // its escaped stand-in). A directory's key is its path.
  key: string;
  status?: FileStatus;
  expanded?: boolean;
};

// A changed file for the tree: its path alone, or its path and the key that
// tells it apart from another file with the same path text.
export type TreeFile = string | {path: string; key: string};

type TreeNode = {
  name: string;
  path: string;
  key: string;
  kind: 'dir' | 'file';
  status?: FileStatus;
  children?: Map<string, TreeNode>;
};

function compareNames(a: string, b: string) {
  return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
}

function walk(node: TreeNode, depth: number, rows: TreeRow[]) {
  if (node.kind === 'dir') {
    rows.push({id: rowId('dir', node.path), kind: 'dir', label: node.name, depth, path: node.path, key: node.key});

    const children = [...(node.children?.values() ?? [])].sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'dir' ? -1 : 1;
      }

      return compareNames(left.name, right.name);
    });

    for (const child of children) {
      walk(child, depth + 1, rows);
    }

    return;
  }

  rows.push({id: rowId('file', node.key), kind: 'file', label: node.name, depth, path: node.path, key: node.key, status: node.status});
}

function rowId(kind: TreeRow['kind'], path: string) {
  return `${kind}:${path}`;
}

// Children are keyed by kind and name, so a path that is a file on one side
// of the diff and a directory on the other (`docs` and `docs/README.md`)
// keeps both nodes. A file node goes under its file key, so two files with
// the same path text keep both nodes too.
function childKey(kind: TreeNode['kind'], name: string) {
  return `${kind}:${name}`;
}

// `statusByKey` is keyed like the files: by key where one is given, else by path.
export function buildTreeRows(files: TreeFile[], statusByKey?: ReadonlyMap<string, FileStatus>): TreeRow[] {
  const roots = new Map<string, TreeNode>();
  const entries = files.map((file) => (typeof file === 'string' ? {path: file, key: file} : file));

  for (const {path: filePath, key: fileKey} of entries.sort((left, right) => compareNames(left.path, right.path))) {
    const status = statusByKey?.get(fileKey);
    const parts = filePath.split('/');

    let currentMap = roots;
    let currentPath = '';

    for (const [index, part] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (index === parts.length - 1) {
        currentMap.set(childKey('file', fileKey), {name: part, path: currentPath, key: fileKey, kind: 'file', status});
        break;
      }

      const key = childKey('dir', part);
      let directory = currentMap.get(key);
      if (!directory) {
        directory = {name: part, path: currentPath, key: currentPath, kind: 'dir', children: new Map()};
        currentMap.set(key, directory);
      }
      currentMap = directory.children!;
    }
  }

  const rows: TreeRow[] = [];
  const sortedRoots = [...roots.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'file' ? -1 : 1;
    }

    return compareNames(left.name, right.name);
  });

  for (const root of sortedRoots) {
    walk(root, 0, rows);
  }

  return rows;
}

function isDescendantOf(filePath: string, directoryPath: string) {
  return filePath.startsWith(`${directoryPath}/`);
}

export function applyTreeCollapse(rows: TreeRow[], collapsedPaths: ReadonlySet<string>): TreeRow[] {
  const visibleRows: TreeRow[] = [];
  const collapsedAncestors: string[] = [];

  for (const row of rows) {
    while (
      collapsedAncestors.length > 0
      && !isDescendantOf(row.path, collapsedAncestors[collapsedAncestors.length - 1]!)
    ) {
      collapsedAncestors.pop();
    }

    if (collapsedAncestors.length > 0) continue;

    if (row.kind === 'dir') {
      const expanded = !collapsedPaths.has(row.path);
      visibleRows.push({...row, expanded});
      if (!expanded) {
        collapsedAncestors.push(row.path);
      }
      continue;
    }

    visibleRows.push(row);
  }

  return visibleRows;
}

// The id of the row that shows the active file, named by its key: its own
// row, or the deepest collapsed directory that hides it. A key starts with
// the file's path, so the directory check works on it as on a path.
export function findTreeSelectionId(rows: TreeRow[], activeFileKey: string) {
  if (!activeFileKey) return '';
  const fileId = rowId('file', activeFileKey);
  if (rows.some((row) => row.id === fileId)) {
    return fileId;
  }

  let collapsedParent: TreeRow | undefined;
  for (const row of rows) {
    if (
      row.kind === 'dir'
      && row.expanded === false
      && isDescendantOf(activeFileKey, row.path)
      && (!collapsedParent || row.path.length > collapsedParent.path.length)
    ) {
      collapsedParent = row;
    }
  }

  return collapsedParent?.id ?? fileId;
}

function hasLaterSibling(rows: TreeRow[], rowIndex: number, depth: number) {
  for (let index = rowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.depth < depth) return false;
    if (row.depth === depth) return true;
  }

  return false;
}

function treePrefix(rows: TreeRow[], rowIndex: number, depth: number) {
  let prefix = '';
  for (let ancestorDepth = 0; ancestorDepth < depth; ancestorDepth += 1) {
    prefix += hasLaterSibling(rows, rowIndex, ancestorDepth) ? '│   ' : '    ';
  }

  return prefix;
}

// A label on its own tree line, with CR and LF escaped so a file name can't
// end the line and forge another one.
function lineLabel(label: string) {
  return label.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

// A fence longer than any run of backticks in the lines, so no file name can
// close it early.
function fenceFor(lines: ReadonlyArray<string>) {
  let longestRun = 0;
  for (const line of lines) {
    for (const match of line.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  }
  return '`'.repeat(Math.max(3, longestRun + 1));
}

export function formatTreePayload(rows: TreeRow[], rootPath = '.') {
  const body = rows.length === 0
    ? [lineLabel(rootPath), '└── (no selected files)']
    : [
      lineLabel(rootPath),
      ...rows.map((row, index) => {
        const connector = hasLaterSibling(rows, index, row.depth) ? '├──' : '└──';
        return `${treePrefix(rows, index, row.depth)}${connector} ${lineLabel(row.label)}`;
      }),
    ];
  const fence = fenceFor(body);
  return [fence, ...body, fence].join('\n');
}
