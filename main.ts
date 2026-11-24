// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none.
//
// Node 22 standard library only. The full contract is SPEC.md.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** An exit-2 error: one line on stdout, nothing written. */
class ExitError extends Error {
  readonly text: string;
  readonly code: number;
  constructor(text: string, code: number) {
    super(text);
    this.text = text;
    this.code = code;
  }
}

/** One edit failed: reported on exit 1, nothing written. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

function parseError(line: number): ExitError {
  return new ExitError(`error: parse ${line}`, 2);
}

function editFail(code: string, path: string): EditFailure {
  return new EditFailure(code, path);
}

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

/**
 * A patch's lines (SPEC section 3): the text split at `\n`, each line
 * losing one trailing `\r`, without the empty piece after a final `\n`.
 */
function splitLines(text: string): string[] {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** A blank line: empty or only whitespace (SPEC section 4). */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** A line with trailing spaces and tabs removed. */
function trimEndWs(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

/* ------------------------------------------------------------------ */
/* File model (SPEC section 3)                                         */
/* ------------------------------------------------------------------ */

interface FileModel {
  /** The file's lines, split at its own line break. */
  lines: string[];
  /** The file's line break: CRLF when its first line feed follows a carriage return, else LF. */
  sep: '\r\n' | '\n';
  /** Whether the file ends with its line break. */
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], sep: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const sep: '\r\n' | '\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(sep);
  let ends = false;
  if (text.endsWith(sep)) {
    ends = true;
    parts.pop();
  }
  return { lines: parts, sep, ends };
}

function renderFile(model: FileModel): string {
  if (model.lines.length === 0) return '';
  return model.lines.join(model.sep) + (model.ends ? model.sep : '');
}

/* ------------------------------------------------------------------ */
/* Safe paths (SPEC section 3)                                         */
/* ------------------------------------------------------------------ */

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw editFail('unsafe', p);
}

/* ------------------------------------------------------------------ */
/* The tree: the working directory, staged in memory                   */
/* ------------------------------------------------------------------ */

/**
 * The tree as the edits leave it. Reads fall through to disk on first
 * access and are remembered, so `before` always holds the state the
 * patch started from. Nothing reaches disk until the run writes it.
 */
class Tree {
  private state = new Map<string, string | null>();
  private beforeMap = new Map<string, string | null>();

  get(path: string): string | null {
    if (this.state.has(path)) return this.state.get(path) ?? null;
    let content: string | null;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      content = null;
    }
    this.beforeMap.set(path, content);
    this.state.set(path, content);
    return content;
  }

  exists(path: string): boolean {
    return this.get(path) !== null;
  }

  set(path: string, content: string): void {
    this.get(path);
    this.state.set(path, content);
  }

  remove(path: string): void {
    this.get(path);
    this.state.set(path, null);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.state);
  }

  restore(snap: Map<string, string | null>): void {
    this.state = snap;
  }

  before(path: string): string | null | undefined {
    return this.beforeMap.get(path);
  }

  after(path: string): string | null | undefined {
    return this.state.get(path);
  }

  touchedPaths(): string[] {
    return [...this.beforeMap.keys()];
  }

  writeToDisk(): void {
    for (const [p, content] of this.state) {
      const b = this.beforeMap.get(p);
      if (content === b) continue;
      if (content === null) {
        if (b !== null) rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC section 5)                                     */
/* ------------------------------------------------------------------ */

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every position where O matches the file's lines at one tier. Occurrences may overlap. */
function tierOccurrences(fileLines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (!linesEqual(fileLines[i + k], oldLines[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier at which O occurs at least once, with its occurrences. */
function findAtTier(fileLines: string[], oldLines: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = tierOccurrences(fileLines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * One line of N. A context line (a line of both O and N) is written as
 * the file's own matched line; any other line is new text.
 */
interface NewLine {
  text: string;
  ctx: boolean;
  /** Index into O of the context line this N line mirrors; -1 when not a context line. */
  oIndex: number;
}

/**
 * Build the lines that replace a match. Context lines come from the
 * file. At tier 2 every other non-empty, non-whitespace line that
 * starts with P (the leading spaces and tabs of O's first line) has
 * that P replaced by F (those of the file's first matched line).
 */
function buildNewLines(
  nLines: NewLine[],
  fileLines: string[],
  pos: number,
  tier: number,
  oldLines: string[],
): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && oldLines.length > 0) {
    f = leadingWs(fileLines[pos]);
    p = leadingWs(oldLines[0]);
  }
  const out: string[] = [];
  for (const nl of nLines) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIndex]);
      continue;
    }
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) {
        out.push(f + t.slice(p.length));
        continue;
      }
    }
    out.push(nl.text);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line followed this body line. */
  backslash: boolean;
}

interface Hunk {
  /** A: the hunk's old-side start line (1-based in the old file). */
  a: number;
  /** Raw body lines, trailing empty lines already removed. */
  body: string[];
  entries: BodyEntry[];
  /** O: the context and `-` lines, in body order. */
  oLines: string[];
  /** N: the context and `+` lines, in body order. */
  nLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastCtxOrPlusBackslash: boolean;
}

interface UnifiedSection {
  /** null means /dev/null (no file). */
  oldPath: string | null;
  /** null means /dev/null (no file). */
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  /** A `---`/`+++` pair has named the paths. */
  pairSeen: boolean;
  hunks: Hunk[];
}

/** `diff --git a/<X> b/<Y>`: X runs to the last ` b/` so paths with spaces stay whole. */
function parseDiffGitPaths(line: string, lineNo: number): [string, string] {
  if (!line.startsWith('diff --git a/')) throw parseError(lineNo);
  const rest = line.slice('diff --git a/'.length);
  const idx = rest.lastIndexOf(' b/');
  if (idx === -1) throw parseError(lineNo);
  return [rest.slice(0, idx), rest.slice(idx + 3)];
}

/** The path of a `--- <path>` or `+++ <path>` line: after the four characters, to the first tab, trimmed, one leading `a/` or `b/` removed. */
function parseDashPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function pathOrNull(p: string): string | null {
  return p === '/dev/null' ? null : p;
}

/** Split a hunk's raw body into entries and its O and N line lists. */
function finishHunk(h: Hunk): void {
  const entries: BodyEntry[] = [];
  for (const raw of h.body) {
    if (raw.startsWith('\\')) {
      if (entries.length > 0) entries[entries.length - 1].backslash = true;
      continue;
    }
    if (raw === '') {
      entries.push({ kind: 'ctx', text: '', backslash: false });
      continue;
    }
    const c = raw[0];
    if (c === ' ') entries.push({ kind: 'ctx', text: raw.slice(1), backslash: false });
    else if (c === '-') entries.push({ kind: 'old', text: raw.slice(1), backslash: false });
    else if (c === '+') entries.push({ kind: 'new', text: raw.slice(1), backslash: false });
  }
  const oLines: string[] = [];
  const nLines: NewLine[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      const idx = oLines.length;
      oLines.push(e.text);
      nLines.push({ text: e.text, ctx: true, oIndex: idx });
    } else if (e.kind === 'old') {
      oLines.push(e.text);
    } else {
      nLines.push({ text: e.text, ctx: false, oIndex: -1 });
    }
  }
  let lastCtxOrPlus = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k].kind === 'ctx' || entries[k].kind === 'new') {
      lastCtxOrPlus = entries[k].backslash;
      break;
    }
  }
  h.entries = entries;
  h.oLines = oLines;
  h.nLines = nLines;
  h.lastCtxOrPlusBackslash = lastCtxOrPlus;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let curHunk: Hunk | null = null;
  const newSection = (oldPath: string | null, newPath: string | null): UnifiedSection => {
    const s: UnifiedSection = { oldPath, newPath, isCreate: false, isDelete: false, pairSeen: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (curHunk !== null) {
      // Inside a hunk body.
      if (line.startsWith('diff --git ')) {
        const [x, y] = parseDiffGitPaths(line, i + 1);
        curHunk = null;
        cur = newSection(x, y);
        i++;
        continue;
      }
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        curHunk = null;
        cur = newSection(pathOrNull(parseDashPath(line)), pathOrNull(parseDashPath(lines[i + 1])));
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk.body.push(line);
        i++;
        continue;
      }
      // Any other line ends the body; reprocess it outside the body.
      curHunk = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGitPaths(line, i + 1);
      cur = newSection(x, y);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldP = pathOrNull(parseDashPath(line));
      const newP = pathOrNull(parseDashPath(lines[i + 1]));
      if (cur === null || cur.hunks.length > 0) {
        // A new section (or the first one).
        cur = newSection(oldP, newP);
        cur.pairSeen = true;
      } else {
        // A further pair in the header: the last pair names the paths.
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw parseError(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw parseError(i + 1);
      const hunk: Hunk = { a: Number(m[1]), body: [], entries: [], oLines: [], nLines: [], lastCtxOrPlusBackslash: false };
      cur.hunks.push(hunk);
      curHunk = hunk;
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // A header line, before the section's first hunk.
      if (line.startsWith('--- ')) {
        // Not followed by a `+++ ` line: parse error on the line after it.
        throw parseError(i + 2);
      }
      // A `+++ ` line on its own names no path: only a `+++ ` line
      // directly after a `--- ` line does (the pair branch above), so
      // a lone one is ignored like any other header line.
      if (line.startsWith('rename from ')) {
        if (!cur.pairSeen) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.pairSeen) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line: ignored.
      i++;
      continue;
    }
    // Outside a section, or after its hunks: prose, ignored.
    i++;
  }
  for (const s of sections) {
    for (const h of s.hunks) {
      // Empty lines at the end of a body are not part of it.
      while (h.body.length > 0 && h.body[h.body.length - 1] === '') h.body.pop();
      finishHunk(h);
    }
  }
  if (sections.length === 0) throw parseError(1);
  return sections;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SrEdit {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** A marker line, matched with trailing whitespace removed. */
function isMarker(line: string, marker: string): boolean {
  return trimEndWs(line) === marker;
}

function parseSearchReplace(lines: string[]): SrEdit[] {
  const edits: SrEdit[] = [];
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (isMarker(lines[j], '<<<<<<< SEARCH')) {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    // The path is the nearest line before the SEARCH line, after the
    // previous block's REPLACE line, that is not blank and does not
    // start with three backticks once trimmed.
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw parseError(s + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (isMarker(lines[j], '=======')) {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw parseError(s + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (isMarker(lines[j], '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw parseError(s + 1);
    edits.push({
      path,
      oldLines: lines.slice(s + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw parseError(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** null means no anchor. */
  anchor: string | null;
  body: string[];
  /** The chunk is anchored to the end of the file. */
  eof: boolean;
  oLines: string[];
  nLines: NewLine[];
}

type V4aEdit =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function isV4aHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function finishV4aChunk(ch: V4aChunk): void {
  const oLines: string[] = [];
  const nLines: NewLine[] = [];
  for (const raw of ch.body) {
    if (raw === '' || raw[0] === ' ') {
      const idx = oLines.length;
      oLines.push(raw === '' ? '' : raw.slice(1));
      nLines.push({ text: raw === '' ? '' : raw.slice(1), ctx: true, oIndex: idx });
    } else if (raw[0] === '-') {
      oLines.push(raw.slice(1));
    } else if (raw[0] === '+') {
      nLines.push({ text: raw.slice(1), ctx: false, oIndex: -1 });
    }
  }
  ch.oLines = oLines;
  ch.nLines = nLines;
}

function parseV4aUpdate(
  content: string[],
  contentStart: number,
  path: string,
  headerLineNo: number,
): V4aEdit {
  let moveTo: string | null = null;
  let idx = 0;
  // `*** Move to:` must be the section's first line, literally: the
  // first line after the header, blank lines included. A blank first
  // line is already the first chunk's first body line, so a Move to
  // after it is a parse error on the Move to line.
  if (content.length > 0 && content[0].startsWith('*** Move to: ')) {
    moveTo = content[0].slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let afterEof = false;
  for (let j = idx; j < content.length; j++) {
    const l = content[j];
    const lineNo = contentStart + 1 + j;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false, oLines: [], nLines: [] };
      afterEof = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw parseError(lineNo);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      afterEof = true;
      continue;
    }
    if (cur !== null) {
      // Inside a chunk: only body lines belong here.
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        cur.body.push(l);
        continue;
      }
      throw parseError(lineNo);
    }
    // No chunk open.
    if (chunks.length === 0 && !afterEof) {
      // Before the first chunk: a body line starts it.
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        cur = { anchor: null, body: [l], eof: false, oLines: [], nLines: [] };
        continue;
      }
      // A blank line that is not a body line (only tabs, say) is ignored.
      if (isBlank(l)) continue;
      throw parseError(lineNo);
    }
    // After `*** End of File`: blank lines are ignored.
    if (isBlank(l)) continue;
    throw parseError(lineNo);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw parseError(headerLineNo);
  for (const ch of chunks) finishV4aChunk(ch);
  return { kind: 'update', path, moveTo, chunks };
}

function parseV4a(lines: string[]): V4aEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw parseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw parseError(lines.length + 1);
  const edits: V4aEdit[] = [];
  let i = first + 1;
  while (i < last) {
    // Blank lines between sections are ignored.
    while (i < last && isBlank(lines[i])) i++;
    if (i >= last) break;
    const line = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw parseError(i + 1);
    }
    const headerLineNo = i + 1;
    i++;
    const contentStart = i;
    while (i < last && !isV4aHeader(lines[i])) i++;
    let content = lines.slice(contentStart, i);
    // Blank lines at the end of a section are not part of it.
    while (content.length > 0 && isBlank(content[content.length - 1])) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let j = 0; j < content.length; j++) {
        const l = content[j];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw parseError(contentStart + 1 + j);
      }
      edits.push({ kind: 'add', path, lines: fileLines });
    } else if (kind === 'delete') {
      for (let j = 0; j < content.length; j++) {
        if (!isBlank(content[j])) throw parseError(contentStart + 1 + j);
      }
      edits.push({ kind: 'delete', path });
    } else {
      edits.push(parseV4aUpdate(content, contentStart, path, headerLineNo));
    }
  }
  if (edits.length === 0) throw parseError(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

type JsonEdit =
  | { kind: 'create'; path: string; fileText: string }
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; insertLine: number; newStr: string };

function validateJsonEdit(obj: unknown, lineNo: number): JsonEdit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw parseError(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw parseError(lineNo);
  if (typeof o.command !== 'string') throw parseError(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw parseError(lineNo);
    return { kind: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw parseError(lineNo);
    if (o.new_str === undefined) return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: '' };
    if (typeof o.new_str !== 'string') throw parseError(lineNo);
    return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw parseError(lineNo);
    if (typeof o.new_str !== 'string') throw parseError(lineNo);
    return { kind: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  throw parseError(lineNo);
}

function parseJson(lines: string[], text: string): JsonEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw parseError(1);
  if (lines[first].replace(/^\s+/, '').startsWith('[')) {
    // One JSON array of edit objects; any fault is on the line where the array starts.
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(arr)) throw parseError(first + 1);
    const edits = arr.map((o) => validateJsonEdit(o, first + 1));
    if (edits.length === 0) throw parseError(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw parseError(i + 1);
    }
    edits.push(validateJsonEdit(obj, i + 1));
  }
  if (edits.length === 0) throw parseError(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first !== -1) {
    if (lines[first].trim() === '*** Begin Patch') return 'v4a';
    const t = lines[first].replace(/^\s+/, '');
    if (t.startsWith('[') || t.startsWith('{')) return 'json';
  }
  for (const l of lines) {
    if (trimEndWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  throw new ExitError('error: format', 2);
}

/* ------------------------------------------------------------------ */
/* Applying edits                                                      */
/* ------------------------------------------------------------------ */

type Edit =
  | { kind: 'unified'; section: UnifiedSection }
  | { kind: 'sr'; edit: SrEdit }
  | { kind: 'v4a'; edit: V4aEdit }
  | { kind: 'json'; edit: JsonEdit };

/**
 * Apply a section's hunks in order to a file model. Each hunk works on
 * the result of the ones before it; d tracks the running length change.
 * The file's final break is carried from hunk to hunk: a hunk that
 * touches the end sets it from its trailing `\` line, any other leaves it.
 */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): FileModel {
  let lines = model.lines.slice();
  let ends = model.ends;
  let d = 0;
  for (const h of hunks) {
    const O = h.oLines;
    const N = h.nLines;
    if (O.length > 0) {
      const found = findAtTier(lines, O, strict);
      if (found === null) throw editFail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const pos = best;
      const newLines = buildNewLines(N, lines, pos, found.tier, O);
      const touchesEnd = pos + O.length === lines.length;
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos + O.length)];
      if (touchesEnd) ends = !h.lastCtxOrPlusBackslash;
      d += N.length - O.length;
    } else {
      // An empty O inserts N after the first A + d lines.
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const newLines = N.map((nl) => nl.text);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos)];
      if (atEnd) ends = !h.lastCtxOrPlusBackslash;
      d += N.length;
    }
  }
  return { lines, sep: model.sep, ends };
}

/** A `\` line follows the section's last `+` line anywhere in its hunks. */
function sectionLastPlusBackslash(sec: UnifiedSection): boolean {
  let flag = false;
  for (const h of sec.hunks) {
    for (const e of h.entries) {
      if (e.kind === 'new') flag = e.backslash;
    }
  }
  return flag;
}

function applyUnified(sec: UnifiedSection, tree: Tree, strict: boolean, moves: [string, string][]): void {
  if (sec.isCreate || sec.oldPath === null) {
    // Creation: the new path must not exist; the file is the `+` lines of all its hunks.
    const p = sec.newPath ?? '/dev/null';
    checkSafe(p);
    if (tree.exists(p)) throw editFail('exists', p);
    const contentLines: string[] = [];
    let anyPlus = false;
    for (const h of sec.hunks) {
      for (const e of h.entries) {
        if (e.kind === 'new') {
          contentLines.push(e.text);
          anyPlus = true;
        }
      }
    }
    const model: FileModel = { lines: contentLines, sep: '\n', ends: anyPlus ? !sectionLastPlusBackslash(sec) : false };
    tree.set(p, renderFile(model));
    return;
  }
  if (sec.isDelete || sec.newPath === null) {
    // Deletion: the old path must exist; its hunks are not read.
    const p = sec.oldPath ?? '/dev/null';
    checkSafe(p);
    if (!tree.exists(p)) throw editFail('missing', p);
    tree.remove(p);
    return;
  }
  if (sec.oldPath !== sec.newPath) {
    // Move: the old path must exist, the new path must not.
    const op = sec.oldPath ?? '/dev/null';
    const np = sec.newPath ?? '/dev/null';
    checkSafe(op);
    checkSafe(np);
    if (!tree.exists(op)) throw editFail('missing', op);
    if (tree.exists(np)) throw editFail('exists', np);
    const model = parseFile(tree.get(op) as string);
    const result = applyHunks(model, sec.hunks, strict, op);
    tree.remove(op);
    tree.set(np, renderFile(result));
    moves.push([op, np]);
    return;
  }
  // Change of the one path, which must exist.
  const p = sec.oldPath ?? '/dev/null';
  checkSafe(p);
  if (!tree.exists(p)) throw editFail('missing', p);
  const model = parseFile(tree.get(p) as string);
  const result = applyHunks(model, sec.hunks, strict, p);
  tree.set(p, renderFile(result));
}

function applySr(edit: SrEdit, tree: Tree, strict: boolean): void {
  checkSafe(edit.path);
  if (edit.oldLines.length === 0) {
    // Empty old lines create the file with the new lines.
    if (tree.exists(edit.path)) throw editFail('exists', edit.path);
    const model: FileModel = { lines: edit.newLines.slice(), sep: '\n', ends: edit.newLines.length > 0 };
    tree.set(edit.path, renderFile(model));
    return;
  }
  if (!tree.exists(edit.path)) throw editFail('missing', edit.path);
  const model = parseFile(tree.get(edit.path) as string);
  const found = findAtTier(model.lines, edit.oldLines, strict);
  if (found === null) throw editFail('no-match', edit.path);
  if (found.occ.length > 1) throw editFail('ambiguous', edit.path);
  const pos = found.occ[0];
  const nLines: NewLine[] = edit.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
  const newLines = buildNewLines(nLines, model.lines, pos, found.tier, edit.oldLines);
  const lines = [...model.lines.slice(0, pos), ...newLines, ...model.lines.slice(pos + edit.oldLines.length)];
  tree.set(edit.path, renderFile({ lines, sep: model.sep, ends: model.ends }));
}

/** The first line at or after the cursor equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (linesEqual(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

function applyV4a(edit: V4aEdit, tree: Tree, strict: boolean, moves: [string, string][]): void {
  if (edit.kind === 'add') {
    checkSafe(edit.path);
    if (tree.exists(edit.path)) throw editFail('exists', edit.path);
    const model: FileModel = { lines: edit.lines.slice(), sep: '\n', ends: edit.lines.length > 0 };
    tree.set(edit.path, renderFile(model));
    return;
  }
  if (edit.kind === 'delete') {
    checkSafe(edit.path);
    if (!tree.exists(edit.path)) throw editFail('missing', edit.path);
    tree.remove(edit.path);
    return;
  }
  checkSafe(edit.path);
  if (edit.moveTo !== null) checkSafe(edit.moveTo);
  if (!tree.exists(edit.path)) throw editFail('missing', edit.path);
  if (edit.moveTo !== null && tree.exists(edit.moveTo)) throw editFail('exists', edit.moveTo);
  const model = parseFile(tree.get(edit.path) as string);
  let lines = model.lines.slice();
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== null) {
      const at = findAnchor(lines, ch.anchor, cursor, strict);
      if (at === -1) throw editFail('no-match', edit.path);
      cursor = at + 1;
    }
    const O = ch.oLines;
    const N = ch.nLines;
    if (O.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const newLines = N.map((nl) => nl.text);
      lines = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos)];
      cursor = pos + newLines.length;
    } else {
      // The first occurrence at or after the cursor, at the first tier
      // with one; an end-of-file chunk takes only one that ends at the
      // file's last line.
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        let pos = -1;
        for (let i = cursor; i + O.length <= lines.length; i++) {
          if (ch.eof && i + O.length !== lines.length) continue;
          let ok = true;
          for (let k = 0; k < O.length; k++) {
            if (!linesEqual(lines[i + k], O[k], t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            pos = i;
            break;
          }
        }
        if (pos !== -1) {
          found = { tier: t, pos };
          break;
        }
      }
      if (found === null) throw editFail('no-match', edit.path);
      const newLines = buildNewLines(N, lines, found.pos, found.tier, O);
      lines = [...lines.slice(0, found.pos), ...newLines, ...lines.slice(found.pos + O.length)];
      cursor = found.pos + newLines.length;
    }
  }
  const result = renderFile({ lines, sep: model.sep, ends: model.ends });
  if (edit.moveTo !== null) {
    tree.remove(edit.path);
    tree.set(edit.moveTo, result);
    moves.push([edit.path, edit.moveTo]);
  } else {
    tree.set(edit.path, result);
  }
}

function applyJson(edit: JsonEdit, tree: Tree): void {
  if (edit.kind === 'create') {
    checkSafe(edit.path);
    if (tree.exists(edit.path)) throw editFail('exists', edit.path);
    tree.set(edit.path, edit.fileText);
    return;
  }
  if (edit.kind === 'str_replace') {
    checkSafe(edit.path);
    const content = tree.get(edit.path);
    if (content === null) throw editFail('missing', edit.path);
    const crlf = parseFile(content).sep === '\r\n';
    let text = content;
    let oldStr = edit.oldStr;
    let newStr = edit.newStr;
    if (crlf) {
      text = text.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    // Occurrences may overlap: advance one character past each hit.
    let count = 0;
    let idx = -1;
    let from = 0;
    for (;;) {
      const at = text.indexOf(oldStr, from);
      if (at === -1) break;
      count++;
      if (count === 1) idx = at;
      from = at + 1;
    }
    if (count === 0) throw editFail('no-match', edit.path);
    if (count > 1) throw editFail('ambiguous', edit.path);
    let result = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    tree.set(edit.path, result);
    return;
  }
  // insert
  checkSafe(edit.path);
  const content = tree.get(edit.path);
  if (content === null) throw editFail('missing', edit.path);
  const model = parseFile(content);
  if (edit.insertLine < 0 || edit.insertLine > model.lines.length) throw editFail('no-match', edit.path);
  const newLines = edit.newStr === '' ? [] : splitLines(edit.newStr);
  const lines = [...model.lines.slice(0, edit.insertLine), ...newLines, ...model.lines.slice(edit.insertLine)];
  tree.set(edit.path, renderFile({ lines, sep: model.sep, ends: model.ends }));
}

function applyEdit(edit: Edit, tree: Tree, strict: boolean, moves: [string, string][]): void {
  switch (edit.kind) {
    case 'unified':
      applyUnified(edit.section, tree, strict, moves);
      break;
    case 'sr':
      applySr(edit.edit, tree, strict);
      break;
    case 'v4a':
      applyV4a(edit.edit, tree, strict, moves);
      break;
    case 'json':
      applyJson(edit.edit, tree);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Output (SPEC section 2)                                             */
/* ------------------------------------------------------------------ */

/** The exit-0 lines: one per path whose state changed, in byte order of the paths. */
function computeOutput(tree: Tree, moves: [string, string][]): string[] {
  const byPath = new Map<string, { key: string; text: string }>();
  for (const p of tree.touchedPaths()) {
    const b = tree.before(p);
    const a = tree.after(p);
    if (b === undefined || a === undefined) continue;
    if (b === a) continue;
    if (b === null) byPath.set(p, { key: p, text: `A ${p}` });
    else if (a === null) byPath.set(p, { key: p, text: `D ${p}` });
    else byPath.set(p, { key: p, text: `M ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const bOld = tree.before(oldP);
    const aOld = tree.after(oldP);
    const bNew = tree.before(newP);
    const aNew = tree.after(newP);
    // A move becomes one R line only when the old path existed before
    // the patch and not after it, and the new path did not exist before
    // it and does after it. Otherwise the plain A/D/M lines stand.
    if (bOld !== null && bOld !== undefined && aOld === null && bNew === null && aNew !== null && aNew !== undefined) {
      byPath.delete(oldP);
      byPath.delete(newP);
      byPath.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const arr = [...byPath.values()];
  arr.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  const out = arr.map((e) => e.text);
  out.push(`ok: ${arr.length} ${arr.length === 1 ? 'file' : 'files'}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* The run (SPEC sections 1, 2 and 10)                                 */
/* ------------------------------------------------------------------ */

interface RunResult {
  lines: string[];
  code: number;
}

function usageError(): ExitError {
  return new ExitError('error: usage', 2);
}

function run(argv: string[]): RunResult {
  try {
    return runInner(argv);
  } catch (e) {
    if (e instanceof ExitError) return { lines: [e.text], code: e.code };
    throw e;
  }
}

function runInner(argv: string[]): RunResult {
  // Arguments (SPEC section 1). A usage error wins over everything.
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) throw usageError();
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) throw usageError();
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) throw usageError();
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') throw usageError();
        format = v;
      } else {
        throw usageError();
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) throw usageError();
  const patchArg = positional.length === 1 ? positional[0] : null;

  // The patch: a file, or standard input when absent or `-`.
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      throw new ExitError('error: no-patch', 2);
    }
  }
  const lines = splitLines(patchText);

  // The format, then the whole patch parsed before any file is looked at.
  const fmt = format === null || format === 'auto' ? detectFormat(lines) : format;
  let edits: Edit[];
  if (fmt === 'unified') {
    edits = parseUnified(lines).map((section) => ({ kind: 'unified' as const, section }));
  } else if (fmt === 'search-replace') {
    edits = parseSearchReplace(lines).map((edit) => ({ kind: 'sr' as const, edit }));
  } else if (fmt === 'v4a') {
    edits = parseV4a(lines).map((edit) => ({ kind: 'v4a' as const, edit }));
  } else {
    edits = parseJson(lines, patchText).map((edit) => ({ kind: 'json' as const, edit }));
  }

  // Edits apply in the patch's order to the tree as earlier edits left
  // it. A failed edit changes nothing and the edits after it still run.
  const tree = new Tree();
  const moves: [string, string][] = [];
  const failures: { code: string; path: string }[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const snapMoves = moves.length;
    try {
      applyEdit(edit, tree, strict, moves);
    } catch (e) {
      if (e instanceof EditFailure) {
        tree.restore(snap);
        moves.length = snapMoves;
        failures.push({ code: e.code, path: e.path });
      } else {
        throw e;
      }
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { lines: out, code: 1 };
  }
  const out = computeOutput(tree, moves);
  if (!check) tree.writeToDisk();
  return { lines: out, code: 0 };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const { lines, code } = run(process.argv.slice(2));
  process.stdout.write(lines.map((l) => `${l}\n`).join(''));
  process.exitCode = code;
}
