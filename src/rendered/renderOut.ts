import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {escapeHiddenCharacters, escapeHiddenCharactersInJson} from '../controlChars.js';
import {fileKey, type DiffRange, type FileStatus} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {ReviewModel} from '../review/model.js';
import type {ReviewFile} from '../review/model.js';
import {createAssetResolver, LATE_IDENTITY, LOOKUP_BUDGET_MS, pageLookups, reviewAssetSides, reviewPaths, type AssetUse} from './assets.js';
import type {ReviewCardRequest} from './backend.js';
import {changeGroups, type ChangeGroup} from './changes.js';
import {failedMarkdownPage, renderableKind, type RenderableKind} from './classify.js';
import {describeImage, imageBody, imageFacts, type ImageFacts} from './image.js';
import {fileAlias, pageKey, railSignature} from './keys.js';
import type {DifferenceKind, LinkAnswer, RenderedFragment} from './markdown.js';
import type {PageBody} from './page.js';
import {linkReport, type Finding, type ReportSource} from './report.js';
import {createRenderThread} from './renderThread.js';
import {createReviewBuilder} from './review/build.js';
import {GENERATOR} from './review/page.js';
import {reviewCardRequest} from './review/request.js';
import {specialText} from './review/special.js';
import {writeErrorReason} from './site.js';
import {createSourceReader, oneLine, pageBody, sourceSpec, type SourceSpec} from './source.js';

// `--export-html <dir>`: the Review in browser page for the whole branch,
// written to a directory as `index.html`, in this process, with no UI and
// no browser, beside `links.json`. Its markdown files' rich views, its
// images' sides and the markdown outside the review that shows an image it
// changed are rendered here first, then the page is built from them as the
// worker builds the one `r` opens, with all the time it takes. This module
// owns only rendering each file, the report and writing the files.

// The renderer's deadline per file, as for a fragment in the UI. A file past
// it shows its raw text under a one-line reason.
const RENDER_DEADLINE_MS = 5000;
// How long the commits and the branch's state may take: nobody waits on
// the export, but a git that never answers must not hold it forever.
const EXPORT_GIT_BUDGET_MS = 30_000;

// The report names a markdown file's rich view for the file it is, as
// `image` names an image's, never by how it was made.
export type RenderOutState = 'markdown' | Exclude<PageBody['kind'], 'rendered'>;

export type RenderOutFile = {
  path: string;
  status: FileStatus;
  oldPath?: string;
  /** Where its card is on the page: `index.html#file-<n>`. */
  card: string;
  /** What the card shows beside its diff: a markdown file's rich view, an image's or an SVG's sides, or nothing more. */
  kind: ReviewCardRequest['kind'];
  additions: number;
  deletions: number;
  /** For a file with no diff to show, the one line its card says instead. */
  note?: string;
  /** For markdown, an image or an SVG: what its rich view shows. */
  state?: RenderOutState;
  changes?: RenderedFragment['changes'];
  differences?: Array<{kind: DifferenceKind; count: number}>;
  /** An image's or an SVG's sides: each one's size and dimensions. */
  image?: ImageFacts;
  /** Markdown outside the review, whose text is unchanged: the changed images it shows. */
  embeds?: string[];
  /**
   * Some of the file's lookups ran out of time on both of its renders: it
   * claims nothing of the links and images git didn't answer for, and an
   * image's change may be unmarked.
   */
  late?: true;
  reason?: string;
};

export type RenderOutReport = {
  version: 2;
  base: string;
  branch: string;
  /** The out dir, absolute. */
  dir: string;
  /** The page's file name in the out dir, or null when nothing changed and nothing was written. */
  page: string | null;
  /** Every changed file, in the page's order. */
  files: RenderOutFile[];
  /** Markdown the review didn't change that shows an image it did. */
  also: RenderOutFile[];
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
  /** How long one file's lookups may take on each of its renders (LOOKUP_BUDGET_MS). */
  lookupBudgetMs?: number;
  /** How long the search for markdown that shows a changed image may take (2 seconds). */
  embeddersMs?: number;
};

// One file to render: the review's markdown and images, then the markdown
// outside it that may show one of its images.
type Planned = {
  file: ReviewFile;
  kind: RenderableKind;
  key: string;
  failure?: string;
  source?: SourceSpec;
  groups: ChangeGroup[];
  also?: true;
};

const PAGE_FILE = 'index.html';
const LINKS_FILE = 'links.json';

export async function renderToDirectory({cwd, range, review, outDir, outLabel, now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), lookupBudgetMs = LOOKUP_BUDGET_MS, embeddersMs}: Options): Promise<RenderOutReport> {
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

  // A link to another rendered file names its card by the file's stable
  // page name, which the page script takes to that card, as on the page
  // `r` opens. A deleted file has a card, but the link is broken on GitHub,
  // so it reads as missing. Any other path resolves against what git holds.
  const aliasOf = (file: Pick<ReviewFile, 'path' | 'pathError'>) => fileAlias(fileKey({path: file.path, nameError: file.pathError}));
  const links: Record<string, LinkAnswer> = Object.fromEntries(planned.map(({file}): [string, LinkAnswer] => [
    file.path,
    file.status === 'deleted' ? {kind: 'missing'} : {kind: 'inReview', href: `${aliasOf(file)}.html`},
  ]));

  const bodies: PageBody[] = [];
  const late = new Set<Planned>();
  const thread = createRenderThread({deadlineMs: RENDER_DEADLINE_MS});
  const reader = createSourceReader({sleep});
  // The images on every page, under the same rule as the TUI's pages.
  const assets = reviewAssetSides(review, range, 0);
  const resolver = createAssetResolver({cwd, ...(embeddersMs === undefined ? {} : {embeddersMs})});
  // `settled`: every lookup the render started has answered.
  const renderOnce = async (each: Planned): Promise<{body: PageBody; late?: true; settled: Promise<void>}> => {
    if (each.failure !== undefined) return {body: {kind: 'failed', reason: oneLine(each.failure), source: ''}, settled: Promise.resolve()};
    if (each.kind !== 'markdown') {
      const uses: AssetUse[] = [];
      const lookups = pageLookups(resolver, assets, false, uses, {budgetMs: lookupBudgetMs});
      const body: PageBody = {kind: 'image', image: await imageBody({format: each.kind, path: each.file.path, ...(each.file.oldPath ? {oldPath: each.file.oldPath} : {}), status: each.file.status, asset: lookups.asset, baseAsset: lookups.baseAsset})};
      return {body, ...(uses.some((use) => use.identity === LATE_IDENTITY) ? {late: true as const} : {}), settled: lookups.settled()};
    }
    const {file, groups} = each;
    let ranLate = false;
    let settled = Promise.resolve();
    const render = async (source: string) => {
      const result = await thread.render({cwd, path: file.path, ...(file.oldPath ? {oldPath: file.oldPath} : {}), status: file.status, ...(each.also ? {textUnchanged: true as const} : {}), source, groups, links, assets, budgetMs: lookupBudgetMs});
      ranLate = Boolean(result.late);
      settled = result.settled;
      return result.fragment;
    };
    const body = await pageBody(() => reader.read(cwd, each.source!), render);
    return {body, ...(ranLate ? {late: true as const} : {}), settled};
  };
  // A render whose lookups ran out of time (the first read of a tree, a
  // busy machine) shows less than the page will once git answers, so it
  // renders once more, when what the first one asked for is at hand (or a
  // render's deadline has passed), as the TUI's service asks again.
  // Whatever is still late stays unclaimed.
  const renderOne = async (each: Planned): Promise<PageBody> => {
    const first = await renderOnce(each);
    if (!first.late) return first.body;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([first.settled, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RENDER_DEADLINE_MS);
    })]);
    clearTimeout(timer);
    const again = await renderOnce(each);
    if (again.late) late.add(each);
    return again.body;
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
        const file = {path: found.path, status: 'modified', metrics: {path: found.path, additions: 0, deletions: 0, changedLines: 0}, rawDiff: '', renderedLines: [], blocks: []} as ReviewFile;
        const candidate: Planned = {file, kind: 'markdown', groups: [], also: true, source: {kind: 'blob', id: found.oid}, key: pageKey({path: found.path, status: 'modified', after: found.oid, groups: [], rail: `${rail}\0also`})};
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

  // The link and anchor report over the review's markdown.
  const sources: ReportSource[] = planned.flatMap((each, index) => {
    const body = bodies[index]!;
    return each.kind === 'markdown' && body.kind === 'rendered' ? [{path: each.file.path, status: each.file.status, ...body.fragment}] : [];
  });
  const {findings, broken} = linkReport(sources);

  // The page, built from the bodies rendered here as the worker builds it
  // from the fragments it holds: each rendered file's card asks for its
  // body by its key.
  const byKey = new Map([...planned, ...alsoPlanned].map((each, index) => [each.key, [...bodies, ...alsoBodies][index]!]));
  const plannedOf = new Map(planned.map((each) => [each.file.path, each]));
  const cardFor = (file: ReviewFile, each: Planned | undefined): ReviewCardRequest => reviewCardRequest(file, range, each ? {
    kind: each.kind,
    fragment: {cwd, key: each.key, path: file.path, ...(file.oldPath ? {oldPath: file.oldPath} : {}), status: file.status, source: each.source ?? {kind: 'none', reason: 'an image reads its sides as images'}, groups: each.groups},
    ...(broken.has(file.path) ? {brokenRefs: broken.get(file.path)!} : {}),
  } : null);
  const cards: ReviewCardRequest[] = [
    ...review.files.map((file) => ({...cardFor(file, plannedOf.get(file.path)), alias: aliasOf(file)})),
    ...alsoPlanned.map((each, index) => ({...cardFor(each.file, each), also: embedsOf(alsoBodies[index]!)})),
  ];
  const builder = createReviewBuilder({
    sources: createSourceReader({sleep, local: true}),
    fragment: async (request) => ({body: byKey.get(request.key) ?? {kind: 'failed', reason: 'not rendered', source: ''}}),
    // Nobody waits on an export: every side the grammars take is colored.
    buildBudgetMs: Infinity,
    buildColorCost: Infinity,
    gitBudgetMs: EXPORT_GIT_BUDGET_MS,
  });
  const reviewId = createHash('sha256').update(JSON.stringify([cwd, range.base, review.branch])).digest('hex').slice(0, 16);
  const report: RenderOutReport = {version: 2, base: review.base, branch: review.branch, dir: outDir, page: null, files: [], also: [], findings};
  if (cards.length === 0) return report;
  const {html, specials} = await builder.page({
    key: PAGE_FILE,
    cwd,
    refs: {base: range.base, branch: range.branch},
    title: {repo: path.basename(cwd), base: review.base, branch: review.branch, worktree: range.includeWorktree},
    reviewId,
    cards,
    links,
    assets,
    findings,
  });

  prepareDir(outDir, outLabel);
  // Both are checked before either is written, so a refusal writes nothing.
  for (const [name, ours] of [[PAGE_FILE, isOurPage], [LINKS_FILE, isOurLinks]] as const) refuseForeign(outDir, outLabel, name, ours);
  writeFile(outDir, outLabel, PAGE_FILE, html);
  writeFile(outDir, outLabel, LINKS_FILE, formatLinks(review, sources, findings));

  // The one line each card shows in place of a diff, as the builder
  // decided it: a diff too large for the page is known only there.
  const entry = (file: ReviewFile, index: number, each: Planned | undefined, body: PageBody | undefined): RenderOutFile => {
    const special = specials[index];
    return {
      path: file.path,
      status: file.status,
      ...(file.oldPath ? {oldPath: file.oldPath} : {}),
      card: `${PAGE_FILE}#file-${index}`,
      kind: each?.kind ?? 'text',
      additions: file.metrics.additions,
      deletions: file.metrics.deletions,
      ...(special && !body ? {note: specialText(special, file)} : {}),
      ...(body ? {
        state: reportState(body),
        // A markdown file's marks, none for one that didn't render.
        ...(each?.kind === 'markdown' ? {changes: body.kind === 'rendered' ? body.fragment.changes : {changed: 0, removed: 0}, differences: body.kind === 'rendered' ? body.fragment.differences : []} : {}),
        ...(body.kind === 'image' ? {image: imageFacts(body.image)} : {}),
        ...(each && late.has(each) ? {late: true as const} : {}),
        ...(body.kind === 'failed' ? {reason: body.reason} : {}),
      } : {}),
    };
  };
  report.page = PAGE_FILE;
  report.files = review.files.map((file, index) => {
    const each = plannedOf.get(file.path);
    return entry(file, index, each, each ? byKey.get(each.key) : undefined);
  });
  report.also = alsoPlanned.map((each, index) => ({...entry(each.file, review.files.length + index, each, alsoBodies[index]), embeds: embedsOf(alsoBodies[index]!)}));
  return report;
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

// What an earlier export wrote: a page that names us in its <head>, and a
// link report with the keys formatLinks writes.
const LINKS_KEYS = ['base', 'branch', 'findings', 'links', 'version'];
const isOurPage = (file: string) => {
  const head = Buffer.alloc(4096);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString('utf8').includes(GENERATOR);
  } finally {
    fs.closeSync(fd);
  }
};
const isOurLinks = (file: string) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } finally {
    fs.closeSync(fd);
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).sort().join() === LINKS_KEYS.join();
};
const FOREIGN: Record<string, string> = {[PAGE_FILE]: "isn't a branch-review page", [LINKS_FILE]: "isn't a branch-review link report"};

// An export replaces only its own last run: a name in the dir that holds
// anything else (a tracked file, a symlink, a folder) stops it with nothing
// written, so `--export-html site` never writes over a site's own page.
function refuseForeign(outDir: string, outLabel: string, name: string, ours: (file: string) => boolean) {
  const file = path.join(outDir, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw writeFailure(outLabel, error);
  }
  let mine = false;
  try {
    mine = stat.isFile() && ours(file);
  } catch {
    mine = false;
  }
  if (!mine) throw new Error(`can't write the page to ${outLabel}: ${name} is already there and ${FOREIGN[name]}`);
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

function reportState(body: PageBody): RenderOutState {
  return body.kind === 'rendered' ? 'markdown' : body.kind;
}

const STATUS_LETTERS: Record<FileStatus, string> = {modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U'};
const STATUS_NOTES: Partial<Record<FileStatus, string>> = {added: 'new file', untracked: 'untracked', deleted: 'deleted', renamed: 'renamed'};
const LATE_NOTE = 'git was slow · some links and images unchecked';
const STATE_NOTES: Partial<Record<RenderOutState, string>> = {empty: 'empty', tooLarge: 'too large to show', notUtf8: 'not UTF-8 text', failed: "couldn't show"};

// What a file's line in the summary says after its card.
function fileNote(file: RenderOutFile) {
  const unchecked = file.late ? [LATE_NOTE] : [];
  if (file.embeds) return ['text unchanged', `embeds ${file.embeds.map(escapeHiddenCharacters).join(', ')}`, ...unchecked].join(' · ');
  const notes = [STATUS_NOTES[file.status], file.state && STATE_NOTES[file.state]].filter((note): note is string => Boolean(note));
  if (file.image) {
    const facts = describeImage(file.image);
    if (facts) notes.push(facts);
    return [...notes, ...unchecked].join(' · ');
  }
  if (file.note) return [...notes, file.note].join(' · ');
  if (file.state === undefined) return [...notes, `+${file.additions} −${file.deletions}`].join(' · ');
  const changes = file.changes ?? {changed: 0, removed: 0};
  if (changes.changed > 0) notes.push(`${changes.changed} changed`);
  if (changes.removed > 0) notes.push(`${changes.removed} removed`);
  const differences = (file.differences ?? []).reduce((sum, difference) => sum + difference.count, 0);
  if (differences > 0) notes.push(`${differences} difference${differences === 1 ? '' : 's'}`);
  notes.push(...unchecked);
  // Some changes leave nothing to mark, such as a new link definition.
  return notes.length > 0 ? notes.join(' · ') : 'no blocks marked';
}

/**
 * The plain-text report: where the page went, then one line per file with
 * its status, its card on the page and what changed. Repo paths pass
 * through escapeHiddenCharacters, as everywhere the tool prints them.
 */
export function formatRenderOutSummary(report: RenderOutReport, outLabel: string) {
  if (report.page === null) return 'nothing to export · no files changed on this branch\n';
  const dir = outLabel.endsWith('/') ? outLabel : `${outLabel}/`;
  const all = [...report.files, ...report.also];
  const paths = all.map((file) => escapeHiddenCharacters(file.path));
  const width = Math.max(...paths.map((shown) => shown.length)) + 3;
  const cardWidth = Math.max(...all.map((file) => file.card.length - PAGE_FILE.length)) + 2;
  const lines = all.map((file, index) => `  ${file.embeds ? '·' : STATUS_LETTERS[file.status]} ${paths[index]!.padEnd(width)}${file.card.slice(PAGE_FILE.length).padEnd(cardWidth)}${fileNote(file)}`);
  const count = report.files.length;
  return [`Wrote ${dir}${report.page} and ${dir}${LINKS_FILE} for ${count} file${count === 1 ? '' : 's'} · nothing left this machine`, ...lines, ''].join('\n');
}

/**
 * The JSON report. Repo paths and refs can hold characters JSON.stringify
 * leaves as they are, such as C1 and bidi controls, so those are escaped
 * too: the JSON decodes to the same values and prints as plain text.
 */
export function formatRenderOutJson(report: RenderOutReport) {
  return `${escapeHiddenCharactersInJson(JSON.stringify(report, null, 2))}\n`;
}
