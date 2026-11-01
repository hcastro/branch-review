import fs from 'node:fs';
import path from 'node:path';
import {escapeHiddenCharacters, escapeHiddenCharactersInJson} from '../controlChars.js';
import type {DiffRange, FileStatus} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {ReviewModel} from '../review/model.js';
import type {ReviewFile} from '../review/model.js';
import {createAssetResolver, LATE_IDENTITY, LOOKUP_BUDGET_MS, pageLookups, reviewAssetSides, reviewPaths, type AssetUse} from './assets.js';
import {changeGroups, type ChangeGroup} from './changes.js';
import {failedMarkdownPage, renderableKind, type RenderableKind} from './classify.js';
import {describeImage, imageBody, imageFacts, type ImageFacts} from './image.js';
import {pageKey, railSignature} from './keys.js';
import type {DifferenceKind, LinkAnswer, RenderedFragment} from './markdown.js';
import {assembleFilePage, assembleOverview, railLabel, type OverviewEntry, type PageBody, type RailEntry} from './page.js';
import {appearances, findingNotes, linkReport, type Finding, type ReportSource} from './report.js';
import {createRenderThread} from './renderThread.js';
import {writeErrorReason} from './site.js';
import {createSourceReader, oneLine, pageBody, sourceSpec, type SourceSpec} from './source.js';

// `--render-out <dir>`: the review's pages written to a directory, in this
// process, with no UI and no browser: its markdown and images, the markdown
// outside it that shows an image it changed, the overview and links.json.
// The same renderer, report and page shell as the TUI's pages; this module
// owns only reading each file, naming the pages and writing them.

// The renderer's deadline per file, as for a fragment in the UI. A file past
// it shows its raw text under a one-line reason.
const RENDER_DEADLINE_MS = 5000;

export type RenderOutPage = {
  path: string;
  status: FileStatus;
  /** The page's file name inside the out dir. */
  file: string;
  state: PageBody['kind'];
  changes: RenderedFragment['changes'];
  differences: Array<{kind: DifferenceKind; count: number}>;
  /** An image's page: each side's size and dimensions. */
  image?: ImageFacts;
  /** A page outside the review, whose text is unchanged: the changed images it shows. */
  embeds?: string[];
  /**
   * Some of the page's lookups ran out of time on both of its renders: it
   * claims nothing of the links and images git didn't answer for, and an
   * image's change may be unmarked.
   */
  late?: true;
  reason?: string;
};

export type RenderOutReport = {
  version: 1;
  base: string;
  branch: string;
  /** The out dir, absolute. */
  dir: string;
  pages: RenderOutPage[];
  /** Markdown the review didn't change that shows an image it did. */
  also: RenderOutPage[];
  /** What won't resolve on GitHub; links.json has every link. */
  findings: Finding[];
};

type Options = {
  cwd: string;
  range: DiffRange;
  review: ReviewModel;
  /** Absolute. */
  outDir: string;
  /** The out dir as the user typed it, for messages. */
  outLabel: string;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long one page's lookups may take on each of its renders (LOOKUP_BUDGET_MS). */
  lookupBudgetMs?: number;
};

// One file to write a page for: the review's markdown and images, then the
// markdown outside it that may show one of its images.
type Planned = {
  file: Pick<ReviewFile, 'path' | 'status' | 'oldPath'>;
  kind: RenderableKind;
  key: string;
  failure?: string;
  source?: SourceSpec;
  groups: ChangeGroup[];
  also?: true;
};

const OVERVIEW_FILE = 'overview.html';
const LINKS_FILE = 'links.json';

export async function renderToDirectory({cwd, range, review, outDir, outLabel, now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), lookupBudgetMs = LOOKUP_BUDGET_MS}: Options): Promise<RenderOutReport> {
  // A markdown file whose review entry failed is listed too, as a page or a
  // card, so no failure goes missing from the run.
  const files = review.files.flatMap((file): Array<{file: ReviewFile; kind: RenderableKind; failure?: string}> => {
    const kind = renderableKind(file, range);
    if (kind) return [{file, kind}];
    const failed = failedMarkdownPage(file, range);
    return failed === null ? [] : [{file, kind: 'markdown', ...('reason' in failed ? {failure: failed.reason} : {})}];
  });
  const rail = railSignature(files.map(({file}) => file));
  const planned: Planned[] = files.map(({file, kind, failure}) => {
    const ids = patchObjectIds(file.rawDiff) ?? {};
    const groups = kind === 'markdown' ? changeGroups(file) : [];
    return {
      file,
      kind,
      groups,
      ...(failure !== undefined ? {failure} : {}),
      ...(kind === 'markdown' ? {source: sourceSpec(file, range, ids)} : {}),
      key: pageKey({path: file.path, ...(file.oldPath ? {oldPath: file.oldPath} : {}), status: file.status, ...ids, groups, rail}),
    };
  });

  // A link to another rendered file opens its page. A deleted file's page
  // exists, but the link is broken on GitHub, so it reads as missing. Any
  // other path resolves against what git holds.
  const links: Record<string, LinkAnswer> = Object.fromEntries(planned.map(({file, key}): [string, LinkAnswer] => [
    file.path,
    file.status === 'deleted' ? {kind: 'missing'} : {kind: 'inReview', href: `${key}.html`},
  ]));

  const bodies: PageBody[] = [];
  const late = new Set<Planned>();
  const thread = createRenderThread({deadlineMs: RENDER_DEADLINE_MS});
  const reader = createSourceReader({sleep});
  // The images on every page, under the same rule as the TUI's pages.
  const assets = reviewAssetSides(review, range, 0);
  const resolver = createAssetResolver({cwd});
  const renderOnce = async (each: Planned): Promise<{body: PageBody; late?: true}> => {
    if (each.failure !== undefined) return {body: {kind: 'failed', reason: oneLine(each.failure), source: ''}};
    if (each.kind !== 'markdown') {
      const uses: AssetUse[] = [];
      const {asset, baseAsset} = pageLookups(resolver, assets, false, uses, {budgetMs: lookupBudgetMs});
      const body: PageBody = {kind: 'image', image: await imageBody({format: each.kind, path: each.file.path, ...(each.file.oldPath ? {oldPath: each.file.oldPath} : {}), status: each.file.status, asset, baseAsset})};
      return {body, ...(uses.some((use) => use.identity === LATE_IDENTITY) ? {late: true as const} : {})};
    }
    const {file, groups} = each;
    let ranLate = false;
    const render = async (source: string) => {
      const result = await thread.render({cwd, path: file.path, ...(file.oldPath ? {oldPath: file.oldPath} : {}), status: file.status, ...(each.also ? {textUnchanged: true as const} : {}), source, groups, links, assets, budgetMs: lookupBudgetMs});
      ranLate = Boolean(result.late);
      return result.fragment;
    };
    const body = await pageBody(() => reader.read(cwd, each.source!), render);
    return {body, ...(ranLate ? {late: true as const} : {})};
  };
  // A render whose lookups ran out of time (the first read of a tree, a
  // busy machine) shows less than the page will once git answers, so it
  // renders once more, when what the first one asked for is at hand, as
  // the TUI's service asks again. Whatever is still late stays unclaimed.
  const renderOne = async (each: Planned): Promise<PageBody> => {
    const first = await renderOnce(each);
    const settled = first.late ? await renderOnce(each) : first;
    if (settled.late) late.add(each);
    return settled.body;
  };
  const alsoPlanned: Planned[] = [];
  const alsoBodies: PageBody[] = [];
  // The review's images by every path they go by: markdown outside the
  // review may still name a moved image where it was.
  const images = planned.filter((each) => each.kind !== 'markdown');
  const changedImages = reviewPaths(images.map((each) => each.file));
  const embedsOf = (body: PageBody) => (body.kind === 'rendered' ? [...new Set(body.fragment.images.map((image) => image.path).filter((image) => changedImages.has(image)))] : []);
  try {
    for (const each of planned) bodies.push(await renderOne(each));
    // Markdown outside the review that shows one of its images: those whose
    // render marked a block, which only a changed image can, and those
    // that show one but couldn't compare it in time, which say so.
    if (images.length > 0) {
      const names = [...changedImages].map((imagePath) => path.posix.basename(imagePath));
      for (const found of await resolver.embedders(assets, names, reviewPaths(planned.map((each) => each.file)))) {
        const candidate: Planned = {file: {path: found.path, status: 'modified'}, kind: 'markdown', groups: [], also: true, source: {kind: 'blob', id: found.oid}, key: pageKey({path: found.path, status: 'modified', after: found.oid, groups: [], rail: `${rail}\0also`})};
        const body = await renderOne(candidate);
        if (body.kind !== 'rendered') continue;
        if (body.fragment.changes.changed === 0 && !(late.has(candidate) && embedsOf(body).length > 0)) continue;
        alsoPlanned.push(candidate);
        alsoBodies.push(body);
      }
    }
  } finally {
    await thread.close();
  }

  const all = [...planned, ...alsoPlanned];
  const allBodies = [...bodies, ...alsoBodies];
  const railEntries = all.map((each, index): Omit<RailEntry, 'current'> => {
    const body = allBodies[index]!;
    const picture = each.also || (each.kind !== 'markdown' && each.file.status !== 'added' && each.file.status !== 'untracked' && each.file.status !== 'deleted');
    return {
      path: each.file.path,
      status: each.file.status,
      href: `${each.key}.html`,
      label: picture ? 'img' : railLabel(each.file.status, changesOf(body)),
      ...(each.also ? {also: true as const} : {}),
    };
  });

  // The link and anchor report over the review's markdown.
  const sources: ReportSource[] = planned.flatMap((each, index) => {
    const body = bodies[index]!;
    return each.kind === 'markdown' && body.kind === 'rendered' ? [{path: each.file.path, status: each.file.status, ...body.fragment}] : [];
  });
  const {findings, broken} = linkReport(sources);
  const notes = findingNotes(findings);
  const markdownImages = all.flatMap((each, index) => {
    const body = allBodies[index]!;
    return body.kind === 'rendered' ? [{path: each.file.path, status: each.file.status, images: body.fragment.images, href: `${each.key}.html`}] : [];
  });

  prepareDir(outDir, outLabel);
  const renderedAt = now();
  const title = {repo: path.basename(cwd), base: review.base, branch: review.branch, worktree: range.includeWorktree, renderedAt};
  const pageEntry = (each: Planned, body: PageBody): RenderOutPage => ({
    path: each.file.path,
    status: each.file.status,
    file: `${each.key}.html`,
    state: body.kind,
    changes: body.kind === 'rendered' ? body.fragment.changes : {changed: 0, removed: 0},
    differences: body.kind === 'rendered' ? body.fragment.differences : [],
    ...(body.kind === 'image' ? {image: imageFacts(body.image)} : {}),
    ...(each.also ? {embeds: embedsOf(body)} : {}),
    ...(late.has(each) ? {late: true as const} : {}),
    ...(body.kind === 'failed' ? {reason: body.reason} : {}),
  });
  for (const [index, each] of all.entries()) {
    const body = allBodies[index]!;
    const {file} = each;
    const own = each.also ? [] : findings.filter((finding) => finding.path === file.path);
    const appears = each.kind === 'markdown' ? [] : appearances(markdownImages, file.path).map((place) => ({...place, href: markdownImages.find((page) => page.path === place.path)!.href}));
    const refs = each.also ? [] : broken.get(file.path) ?? [];
    const html = assembleFilePage({
      title,
      file: {path: file.path, status: file.status, ...(file.oldPath ? {oldPath: file.oldPath} : {}), ...(each.also ? {also: {embeds: embedsOf(body)}} : {}), body},
      rail: railEntries.map((entry) => ({...entry, current: entry.path === file.path})),
      ...(refs.length > 0 ? {brokenRefs: refs} : {}),
      ...(appears.length > 0 ? {appears} : {}),
      ...(own.length > 0 || notes.length > 0 ? {report: {own, notes}} : {}),
    });
    writeFile(outDir, outLabel, `${each.key}.html`, html);
  }

  const report = planned.map((each, index) => pageEntry(each, bodies[index]!));
  const also = alsoPlanned.map((each, index) => pageEntry(each, alsoBodies[index]!));
  if (all.length > 0) {
    const entry = (page: RenderOutPage): OverviewEntry => ({
      path: page.path,
      status: page.status,
      href: page.file,
      state: page.state,
      changes: page.state === 'rendered' ? page.changes : null,
      ...(page.reason !== undefined ? {reason: page.reason} : {}),
      ...(page.image ? {image: page.image} : {}),
      ...(page.embeds ? {embeds: page.embeds} : {}),
    });
    const differences = new Map<DifferenceKind, number>();
    for (const page of report) for (const difference of page.differences) differences.set(difference.kind, (differences.get(difference.kind) ?? 0) + difference.count);
    const fileOf = (repoPath: string) => report.find((page) => page.path === repoPath)?.file ?? null;
    writeFile(outDir, outLabel, OVERVIEW_FILE, assembleOverview({
      title,
      entries: report.map(entry),
      differences: [...differences].map(([kind, count]) => ({kind, count})),
      ...(also.length > 0 ? {also: also.map(entry)} : {}),
      ...(findings.length > 0 ? {findings: findings.map((finding) => ({...finding, href: fileOf(finding.path)}))} : {}),
    }));
    writeFile(outDir, outLabel, LINKS_FILE, formatLinks(review, sources, findings));
  }

  return {version: 1, base: review.base, branch: review.branch, dir: outDir, pages: report, also, findings};
}

/**
 * links.json: every link on the review's pages with how it resolved, a link
 * to a heading another page doesn't have read as `badAnchor`, and the
 * findings, links and images both. Escaped as the JSON report is.
 */
function formatLinks(review: ReviewModel, sources: readonly ReportSource[], findings: readonly Finding[]) {
  const badRefs = new Set(findings.filter((finding) => finding.what === 'link' && finding.kind === 'badAnchor').map((finding) => `${finding.path}\0${finding.line}\0${finding.target}`));
  const links = sources.flatMap((source) => source.links.map((link) => ({
    path: source.path,
    line: link.line,
    href: link.href,
    status: link.status === 'ok' && link.ref && badRefs.has(`${source.path}\0${link.line}\0${link.href}`) ? 'badAnchor' : link.status,
  })));
  return `${escapeHiddenCharactersInJson(JSON.stringify({version: 1, base: review.base, branch: review.branch, findings, links}, null, 2))}\n`;
}

function writeFailure(outLabel: string, error: unknown) {
  return new Error(`can't write the pages to ${outLabel}: ${writeErrorReason(error)}`);
}

function prepareDir(outDir: string, outLabel: string) {
  try {
    fs.mkdirSync(outDir, {recursive: true});
    if (!fs.statSync(outDir).isDirectory()) throw Object.assign(new Error('not a directory'), {code: 'ENOTDIR'});
  } catch (error) {
    throw writeFailure(outLabel, error);
  }
}

// Temp name then rename, so a reader never sees half a file, and a rerun
// replaces its own files in place. Nothing else in the dir is touched.
function writeFile(outDir: string, outLabel: string, name: string, html: string) {
  const temp = path.join(outDir, `.${name}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, html, {flag: 'wx', mode: 0o644});
    fs.renameSync(temp, path.join(outDir, name));
  } catch (error) {
    fs.rmSync(temp, {force: true});
    throw writeFailure(outLabel, error);
  }
}

function changesOf(body: PageBody) {
  return body.kind === 'rendered' ? body.fragment.changes : null;
}

const STATUS_LETTERS: Record<FileStatus, string> = {modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U'};
const STATUS_NOTES: Partial<Record<FileStatus, string>> = {added: 'new file', untracked: 'untracked', deleted: 'deleted', renamed: 'renamed'};
const LATE_NOTE = 'git was slow · some links and images unchecked';
const STATE_NOTES: Partial<Record<PageBody['kind'], string>> = {empty: 'empty', tooLarge: 'too large to render', notUtf8: 'not UTF-8 text', failed: "couldn't render"};

// What a page's line in the summary says after its file name.
function pageNote(page: RenderOutPage) {
  const unchecked = page.late ? [LATE_NOTE] : [];
  if (page.embeds) return ['text unchanged', `embeds ${page.embeds.map(escapeHiddenCharacters).join(', ')}`, ...unchecked].join(' · ');
  const notes = [STATUS_NOTES[page.status], STATE_NOTES[page.state]].filter((note): note is string => Boolean(note));
  if (page.image) {
    const facts = describeImage(page.image);
    if (facts) notes.push(facts);
    return [...notes, ...unchecked].join(' · ');
  }
  if (page.changes.changed > 0) notes.push(`${page.changes.changed} changed`);
  if (page.changes.removed > 0) notes.push(`${page.changes.removed} removed`);
  const differences = page.differences.reduce((sum, difference) => sum + difference.count, 0);
  if (differences > 0) notes.push(`${differences} difference${differences === 1 ? '' : 's'}`);
  notes.push(...unchecked);
  // Some changes leave nothing to mark, such as a new link definition.
  return notes.length > 0 ? notes.join(' · ') : 'no blocks marked';
}

/**
 * The plain-text report: one line per page with its status, its file in
 * the out dir and what changed. Repo paths pass through
 * escapeHiddenCharacters, as everywhere the tool prints them.
 */
export function formatRenderOutSummary(report: RenderOutReport, outLabel: string) {
  if (report.pages.length === 0) return 'nothing to render · no markdown, images or SVG on this branch\n';
  const dir = outLabel.endsWith('/') ? outLabel : `${outLabel}/`;
  const all = [...report.pages, ...report.also];
  const paths = all.map((page) => escapeHiddenCharacters(page.path));
  const width = Math.max(...paths.map((shown) => shown.length)) + 3;
  const lines = all.map((page, index) => `  ${page.embeds ? '·' : STATUS_LETTERS[page.status]} ${paths[index]!.padEnd(width)}${dir}${page.file}  ${pageNote(page)}`);
  const count = all.length;
  return [`Rendered ${count} page${count === 1 ? '' : 's'} to ${dir} · nothing left this machine`, ...lines, ''].join('\n');
}

/**
 * The JSON report. Repo paths and refs can hold characters JSON.stringify
 * leaves as they are, such as C1 and bidi controls, so those are escaped
 * too: the JSON decodes to the same values and prints as plain text.
 */
export function formatRenderOutJson(report: RenderOutReport) {
  return `${escapeHiddenCharactersInJson(JSON.stringify(report, null, 2))}\n`;
}
