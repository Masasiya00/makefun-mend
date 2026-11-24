// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none.
// Node 22, standard library only. See SPEC.md for the contract.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

// An exit-2 failure: the single line it prints is `error: ...`.
class Fail2 extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

// One edit that failed: printed as `error: <code> <path>` on exit 1.
class EditFail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(code + ' ' + path);
    this.code = code;
    this.path = path;
  }
}

function parseFail(n: number): Fail2 {
  return new Fail2('error: parse ' + n);
}

// ------------------------------------------------------------ line helpers

// A patch's lines: split at \n, one trailing \r removed from each, and
// without the empty piece after a final \n.
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

// Remove trailing spaces and tabs.
function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

// Remove leading spaces and tabs.
function trimLeftWs(s: string): string {
  return s.replace(/^[ \t]+/, '');
}

// Remove leading and trailing spaces and tabs.
function trimBothWs(s: string): string {
  return trimLeftWs(trimRightWs(s));
}

// Leading spaces and tabs of a line.
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// True when a line is empty or only spaces and tabs.
function isBlankWs(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or ...
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// Compare two strings in UTF-8 byte order.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ------------------------------------------------------------ file records

interface FileRec {
  lines: string[];
  sep: string;
  ends: boolean;
}

// Split a file's text into its lines, its line break and whether it ends
// with one. The break is CRLF when the first line feed follows a carriage
// return, LF otherwise. An empty file has no lines and no final break.
function parseText(text: string): FileRec {
  if (text === '') return { lines: [], sep: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  if (firstLf === -1) return { lines: [text], sep: '\n', ends: false };
  const sep = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(sep);
  let ends = false;
  if (text.endsWith(sep)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, sep, ends };
}

// Join a record back to text. A record with no lines writes empty.
function serializeText(rec: FileRec): string {
  if (rec.lines.length === 0) return '';
  return rec.lines.join(rec.sep) + (rec.ends ? rec.sep : '');
}

function cloneRec(rec: FileRec): FileRec {
  return { lines: rec.lines.slice(), sep: rec.sep, ends: rec.ends };
}

// ------------------------------------------------------------ the tree

// The tree as the patch leaves it, with the original text of every path
// an edit touched, so the end can be compared with the start. Nothing is
// written to disk until the run decides the exit code.
class Tree {
  private cur = new Map<string, FileRec | null>();
  private orig = new Map<string, string | null>();

  private readOriginal(p: string): string | null {
    try {
      if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
    return null;
  }

  // The current record of a path, or null when it does not exist. The
  // caller gets a copy; it only takes effect through set().
  get(p: string): FileRec | null {
    if (this.cur.has(p)) {
      const r = this.cur.get(p);
      return r === undefined || r === null ? null : cloneRec(r);
    }
    const text = this.readOriginal(p);
    this.orig.set(p, text);
    if (text === null) {
      this.cur.set(p, null);
      return null;
    }
    const rec = parseText(text);
    this.cur.set(p, rec);
    return cloneRec(rec);
  }

  exists(p: string): boolean {
    return this.get(p) !== null;
  }

  set(p: string, rec: FileRec | null): void {
    if (!this.orig.has(p)) this.orig.set(p, this.readOriginal(p));
    this.cur.set(p, rec === null ? null : cloneRec(rec));
  }

  originalText(p: string): string | null {
    if (this.orig.has(p)) {
      const t = this.orig.get(p);
      return t === undefined ? null : t;
    }
    return this.readOriginal(p);
  }

  currentText(p: string): string | null {
    if (!this.cur.has(p)) return this.originalText(p);
    const r = this.cur.get(p);
    return r === undefined || r === null ? null : serializeText(r);
  }

  touchedPaths(): string[] {
    return [...this.cur.keys()];
  }

  // Write every path whose text changed. A path that ends absent is
  // removed; a path that ends present is created with its directories.
  writeAll(): void {
    for (const p of this.cur.keys()) {
      const before = this.originalText(p);
      const after = this.currentText(p);
      if (before === after) continue;
      if (after === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, after, 'utf8');
      }
    }
  }
}

// ------------------------------------------------------------ matching

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

interface Found {
  tier: number;
  positions: number[];
}

// The first tier at which O occurs at least once, with every occurrence
// at that tier, at or after `from`. Occurrences may overlap. Null when
// O occurs at no tier.
function findOccurrences(O: string[], file: string[], strict: boolean, from = 0): Found | null {
  for (const tier of tiersToTry(strict)) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= file.length; i++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (!lineMatches(O[k], file[i + k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// The first line at or after `from` equal to a single line, at the first
// tier where one is. -1 when there is none.
function findSingleLine(needle: string, file: string[], from: number, strict: boolean): number {
  for (const tier of tiersToTry(strict)) {
    for (let i = from; i < file.length; i++) {
      if (lineMatches(needle, file[i], tier)) return i;
    }
  }
  return -1;
}

// Build the lines that replace a match. A context line is written as the
// file's own matched line, never the patch's. At tier 2 every other line
// of N is re-indented: F is the leading whitespace of the file's first
// matched line, P that of O's first line; a line of N that is not empty
// and not only whitespace, and starts with P, has that P replaced by F.
// ctxO gives, for each line of N, its index in O when it is a context
// line, and -1 otherwise.
function buildNewLines(O: string[], N: string[], ctxO: number[], file: string[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leadingWs(file[pos]);
    p = leadingWs(O[0]);
  }
  const out: string[] = [];
  for (let k = 0; k < N.length; k++) {
    const oi = ctxO[k];
    if (oi >= 0) {
      out.push(file[pos + oi]);
      continue;
    }
    const line = N[k];
    if (tier === 2 && !isBlankWs(line) && line.startsWith(p)) {
      out.push(f + line.slice(p.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

// One body line of a unified hunk or a V4A chunk: a context line, an old
// line, a new line, or a backslash line. fromEmpty marks a context line
// that came from a literally empty patch line.
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  fromEmpty: boolean;
}

function bodyEntry(line: string): BodyEntry {
  if (line === '') return { kind: 'ctx', text: '', fromEmpty: true };
  const first = line[0];
  if (first === ' ') return { kind: 'ctx', text: line.slice(1), fromEmpty: false };
  if (first === '-') return { kind: 'old', text: line.slice(1), fromEmpty: false };
  if (first === '+') return { kind: 'new', text: line.slice(1), fromEmpty: false };
  return { kind: 'bs', text: line.slice(1), fromEmpty: false };
}

// Split a body's entries into old lines O, new lines N, and, for each
// line of N, its index in O when it is a context line, -1 otherwise.
function splitBody(body: BodyEntry[]): { O: string[]; N: string[]; ctxO: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctxO: number[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      ctxO.push(O.length);
      O.push(e.text);
      N.push(e.text);
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else if (e.kind === 'new') {
      ctxO.push(-1);
      N.push(e.text);
    }
  }
  return { O, N, ctxO };
}

// Whether a backslash line immediately follows the body's last context
// or + entry, and whether one immediately follows its last + entry.
function backslashFlags(body: BodyEntry[]): { afterCtxPlus: boolean; afterPlus: boolean } {
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') lastCtxPlus = k;
    if (body[k].kind === 'new') lastPlus = k;
  }
  const afterCtxPlus = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1].kind === 'bs';
  const afterPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1].kind === 'bs';
  return { afterCtxPlus, afterPlus };
}

// ---------------------------------------------------------------- edits

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface Chunk {
  anchor: string | null;
  body: BodyEntry[];
  eof: boolean;
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; fileLines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: Chunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFail('unsafe', p);
}

// ------------------------------------------------------------ unified

interface SectionBits {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function emptySection(): SectionBits {
  return {
    pairOld: undefined,
    pairNew: undefined,
    hasPair: false,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

// Parse a `diff --git a/<X> b/<Y>` line. The form must start with
// `diff --git a/` and hold ` b/`; X is the part between, taking the last
// ` b/` so paths holding spaces stay right, and Y is the rest.
function parseDiffGit(line: string, lineNo: number): { old: string; nw: string } {
  const prefix = 'diff --git a/';
  if (!line.startsWith(prefix)) throw parseFail(lineNo);
  const idx = line.lastIndexOf(' b/');
  if (idx < 0) throw parseFail(lineNo);
  return { old: line.slice(prefix.length, idx), nw: line.slice(idx + 3) };
}

// A path from a `--- ` or `+++ ` line: the text after the four characters,
// up to the first tab, with surrounding spaces removed. /dev/null means
// no file. A leading a/ or b/ is removed from either.
function parseHeaderPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function isBodyLine(line: string): boolean {
  if (line === '') return true;
  const c = line[0];
  return c === ' ' || c === '-' || c === '+' || c === '\\';
}

function parseUnified(lines: string[]): Edit[] {
  const sections: SectionBits[] = [];
  let cur: SectionBits | null = null;
  let curHunk: Hunk | null = null;
  let skipNext = false;
  for (let i = 0; i < lines.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ')) {
        const d = parseDiffGit(line, i + 1);
        curHunk = null;
        cur = emptySection();
        cur.diffOld = d.old;
        cur.diffNew = d.nw;
        sections.push(cur);
        continue;
      }
      if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        curHunk = null;
        cur = emptySection();
        cur.pairOld = parseHeaderPath(line);
        cur.pairNew = parseHeaderPath(next);
        cur.hasPair = true;
        sections.push(cur);
        skipNext = true;
        continue;
      }
      if (isBodyLine(line)) {
        curHunk.body.push(bodyEntry(line));
        continue;
      }
      curHunk = null;
    }
    if (line.startsWith('diff --git ')) {
      const d = parseDiffGit(line, i + 1);
      cur = emptySection();
      cur.diffOld = d.old;
      cur.diffNew = d.nw;
      sections.push(cur);
      continue;
    }
    if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.pairOld = parseHeaderPath(line);
        cur.pairNew = parseHeaderPath(next);
        cur.hasPair = true;
        skipNext = true;
      } else {
        cur = emptySection();
        cur.pairOld = parseHeaderPath(line);
        cur.pairNew = parseHeaderPath(next);
        cur.hasPair = true;
        sections.push(cur);
        skipNext = true;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw parseFail(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw parseFail(i + 1);
      curHunk = { a: parseInt(m[1], 10), body: [] };
      cur.hunks.push(curHunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        throw parseFail(i + 2);
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        continue;
      }
      continue;
    }
  }
  // Empty lines at the end of a hunk body are not part of it. A line of
  // a single space is not an empty line: it is a context line whose text
  // is empty, and it stays.
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.body.length > 0) {
        const last = h.body[h.body.length - 1];
        if (last.kind === 'ctx' && last.fromEmpty) h.body.pop();
        else break;
      }
    }
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.hasPair ? (s.pairOld === undefined ? null : s.pairOld) : s.renameFrom !== undefined ? s.renameFrom : s.diffOld !== undefined ? s.diffOld : null;
    const newPath = s.hasPair ? (s.pairNew === undefined ? null : s.pairNew) : s.renameTo !== undefined ? s.renameTo : s.diffNew !== undefined ? s.diffNew : null;
    const isCreate = (s.hasPair && s.pairOld === null) || s.newFile;
    const isDelete = (s.hasPair && s.pairNew === null) || s.deletedFile;
    edits.push({ kind: 'unified', oldPath, newPath, isCreate, isDelete, hunks: s.hunks });
  }
  return edits;
}

function applyUnified(e: Extract<Edit, { kind: 'unified' }>, tree: Tree, strict: boolean): [string, string] | null {
  const oldP = e.oldPath;
  const newP = e.newPath;
  if (e.isCreate) {
    if (newP === null) throw new EditFail('unsafe', '');
    checkSafe(newP);
    if (tree.exists(newP)) throw new EditFail('exists', newP);
    const made: string[] = [];
    let ends = false;
    let lastPlusHunk: Hunk | null = null;
    for (const h of e.hunks) {
      let hasPlus = false;
      for (const b of h.body) {
        if (b.kind === 'new') {
          made.push(b.text);
          hasPlus = true;
        }
      }
      if (hasPlus) lastPlusHunk = h;
    }
    if (made.length > 0) {
      ends = lastPlusHunk === null ? true : !backslashFlags(lastPlusHunk.body).afterPlus;
    }
    tree.set(newP, { lines: made, sep: '\n', ends });
    return null;
  }
  if (e.isDelete) {
    if (oldP === null) throw new EditFail('unsafe', '');
    checkSafe(oldP);
    if (!tree.exists(oldP)) throw new EditFail('missing', oldP);
    tree.set(oldP, null);
    return null;
  }
  if (oldP === null) throw new EditFail('unsafe', '');
  checkSafe(oldP);
  const isMove = newP !== null && newP !== oldP;
  if (isMove) {
    checkSafe(newP as string);
    if (!tree.exists(oldP)) throw new EditFail('missing', oldP);
    if (tree.exists(newP as string)) throw new EditFail('exists', newP as string);
  } else {
    if (!tree.exists(oldP)) throw new EditFail('missing', oldP);
  }
  const rec = tree.get(oldP);
  if (rec === null) throw new EditFail('missing', oldP);
  let lines = rec.lines.slice();
  let ends = rec.ends;
  let d = 0;
  for (const h of e.hunks) {
    const { O, N, ctxO } = splitBody(h.body);
    const flags = backslashFlags(h.body);
    if (O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines = lines.slice(0, pos).concat(N, lines.slice(pos));
      if (atEnd) ends = !flags.afterCtxPlus;
      d += N.length;
      continue;
    }
    const found = findOccurrences(O, lines, strict);
    if (found === null) throw new EditFail('no-match', oldP);
    const target = h.a - 1 + d;
    let best = found.positions[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const touchesEnd = pos + O.length === lines.length;
    const rep = buildNewLines(O, N, ctxO, lines, pos, found.tier);
    lines = lines.slice(0, pos).concat(rep, lines.slice(pos + O.length));
    if (touchesEnd) ends = !flags.afterCtxPlus;
    d += N.length - O.length;
  }
  if (isMove) {
    const dest = newP as string;
    tree.set(dest, { lines, sep: rec.sep, ends });
    tree.set(oldP, null);
    return [oldP, dest];
  }
  tree.set(oldP, { lines, sep: rec.sep, ends });
  return null;
}

// ------------------------------------------------------------ search/replace

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let j = -1;
    for (let k = i; k < lines.length; k++) {
      if (trimRightWs(lines[k]) === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j === -1) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw parseFail(j + 1);
    }
    let eq = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (trimRightWs(lines[k]) === '=======') {
        eq = k;
        break;
      }
    }
    if (eq === -1) throw parseFail(j + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (trimRightWs(lines[k]) === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw parseFail(j + 1);
    blocks.push({ kind: 'sr', path, oldLines: lines.slice(j + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function applySearchReplace(e: Extract<Edit, { kind: 'sr' }>, tree: Tree, strict: boolean): null {
  checkSafe(e.path);
  if (e.oldLines.length === 0) {
    if (tree.exists(e.path)) throw new EditFail('exists', e.path);
    tree.set(e.path, { lines: e.newLines.slice(), sep: '\n', ends: e.newLines.length > 0 });
    return null;
  }
  const rec = tree.get(e.path);
  if (rec === null) throw new EditFail('missing', e.path);
  const found = findOccurrences(e.oldLines, rec.lines, strict);
  if (found === null) throw new EditFail('no-match', e.path);
  if (found.positions.length > 1) throw new EditFail('ambiguous', e.path);
  const pos = found.positions[0];
  const minus: number[] = [];
  for (let k = 0; k < e.newLines.length; k++) minus.push(-1);
  const rep = buildNewLines(e.oldLines, e.newLines, minus, rec.lines, pos, found.tier);
  const lines = rec.lines.slice(0, pos).concat(rep, rec.lines.slice(pos + e.oldLines.length));
  tree.set(e.path, { lines, sep: rec.sep, ends: rec.ends });
  return null;
}

// ---------------------------------------------------------------- V4A

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw parseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseFail(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw parseFail(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const hdr = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (hdr.startsWith('*** Add File: ')) {
      kind = 'add';
      path = hdr.slice('*** Add File: '.length).trim();
    } else if (hdr.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = hdr.slice('*** Delete File: '.length).trim();
    } else if (hdr.startsWith('*** Update File: ')) {
      kind = 'update';
      path = hdr.slice('*** Update File: '.length).trim();
    } else {
      throw parseFail(i + 1);
    }
    const headerLine = i + 1;
    let j = i + 1;
    const content: { text: string; no: number }[] = [];
    while (j < last) {
      const l = lines[j];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push({ text: l, no: j + 1 });
      j++;
    }
    while (content.length > 0 && isBlankWs(content[content.length - 1].text)) content.pop();
    edits.push(buildV4aSection(kind, path, headerLine, content));
    i = j;
  }
  return edits;
}

function buildV4aSection(kind: 'add' | 'delete' | 'update', path: string, headerLine: number, content: { text: string; no: number }[]): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const c of content) {
      if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else if (c.text === '') fileLines.push('');
      else throw parseFail(c.no);
    }
    return { kind: 'v4a-add', path, fileLines };
  }
  if (kind === 'delete') {
    for (const c of content) {
      if (c.text.trim() !== '') throw parseFail(c.no);
    }
    return { kind: 'v4a-delete', path };
  }
  let moveTo: string | null = null;
  let rest = content;
  if (content.length > 0 && content[0].text.startsWith('*** Move to: ')) {
    moveTo = content[0].text.slice('*** Move to: '.length).trim();
    rest = content.slice(1);
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let needAt = false;
  for (const c of rest) {
    const text = c.text;
    if (text === '*** End of File') {
      if (cur === null) throw parseFail(c.no);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      needAt = true;
      continue;
    }
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), body: [], eof: false };
      needAt = false;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (needAt) {
        if (text.trim() === '') continue;
        throw parseFail(c.no);
      }
      if (cur === null) {
        if (chunks.length > 0) throw parseFail(c.no);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(bodyEntry(text));
      continue;
    }
    throw parseFail(c.no);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw parseFail(headerLine);
  return { kind: 'v4a-update', path, moveTo, chunks };
}

function applyV4aUpdate(e: Extract<Edit, { kind: 'v4a-update' }>, tree: Tree, strict: boolean): [string, string] | null {
  checkSafe(e.path);
  if (e.moveTo !== null) checkSafe(e.moveTo);
  const rec = tree.get(e.path);
  if (rec === null) throw new EditFail('missing', e.path);
  if (e.moveTo !== null && tree.exists(e.moveTo)) throw new EditFail('exists', e.moveTo);
  let lines = rec.lines.slice();
  let cursor = 0;
  for (const chunk of e.chunks) {
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const idx = findSingleLine(chunk.anchor, lines, cursor, strict);
      if (idx === -1) throw new EditFail('no-match', e.path);
      cursor = idx + 1;
    } else if (chunk.anchor !== null && chunk.anchor === '') {
      // An empty anchor is no anchor: the cursor does not move.
    }
    const { O, N, ctxO } = splitBody(chunk.body);
    if (chunk.eof) {
      if (O.length === 0) {
        const pos = lines.length;
        lines = lines.slice(0, pos).concat(N, lines.slice(pos));
        cursor = pos + N.length;
        continue;
      }
      const start = lines.length - O.length;
      if (start < cursor) throw new EditFail('no-match', e.path);
      let tier = -1;
      for (const t of tiersToTry(strict)) {
        let ok = true;
        for (let k = 0; k < O.length; k++) {
          if (!lineMatches(O[k], lines[start + k], t)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          tier = t;
          break;
        }
      }
      if (tier === -1) throw new EditFail('no-match', e.path);
      const rep = buildNewLines(O, N, ctxO, lines, start, tier);
      lines = lines.slice(0, start).concat(rep, lines.slice(start + O.length));
      cursor = start + N.length;
      continue;
    }
    if (O.length === 0) {
      const pos = cursor > lines.length ? lines.length : cursor;
      lines = lines.slice(0, pos).concat(N, lines.slice(pos));
      cursor = pos + N.length;
      continue;
    }
    const found = findOccurrences(O, lines, strict, cursor);
    if (found === null) throw new EditFail('no-match', e.path);
    const pos = found.positions[0];
    const rep = buildNewLines(O, N, ctxO, lines, pos, found.tier);
    lines = lines.slice(0, pos).concat(rep, lines.slice(pos + O.length));
    cursor = pos + N.length;
  }
  if (e.moveTo !== null) {
    tree.set(e.moveTo, { lines, sep: rec.sep, ends: rec.ends });
    tree.set(e.path, null);
    return [e.path, e.moveTo];
  }
  tree.set(e.path, { lines, sep: rec.sep, ends: rec.ends });
  return null;
}

// ---------------------------------------------------------------- JSON

function jsonEdit(obj: unknown, lineNo: number): Edit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw parseFail(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw parseFail(lineNo);
  if (typeof o.command !== 'string') throw parseFail(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw parseFail(lineNo);
    return { kind: 'json-create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw parseFail(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw parseFail(lineNo);
    return { kind: 'json-str', path: o.path, oldStr: o.old_str, newStr: o.new_str === undefined ? '' : o.new_str };
  }
  if (o.command === 'insert') {
    if (!Number.isInteger(o.insert_line)) throw parseFail(lineNo);
    if (typeof o.new_str !== 'string') throw parseFail(lineNo);
    return { kind: 'json-insert', path: o.path, insertLine: o.insert_line as number, newStr: o.new_str };
  }
  throw parseFail(lineNo);
}

function parseJson(lines: string[], text: string): Edit[] {
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return [];
  const firstChar = lines[startIdx].trimStart()[0];
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw parseFail(startIdx + 1);
    }
    if (!Array.isArray(arr)) throw parseFail(startIdx + 1);
    if (arr.length === 0) throw parseFail(1);
    const edits: Edit[] = [];
    for (const obj of arr) edits.push(jsonEdit(obj, startIdx + 1));
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw parseFail(i + 1);
    }
    edits.push(jsonEdit(obj, i + 1));
  }
  return edits;
}

function countOverlapping(hay: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
}

function applyJson(e: Edit, tree: Tree): null {
  if (e.kind === 'json-create') {
    checkSafe(e.path);
    if (tree.exists(e.path)) throw new EditFail('exists', e.path);
    tree.set(e.path, parseText(e.fileText));
    return null;
  }
  if (e.kind === 'json-str') {
    checkSafe(e.path);
    const rec = tree.get(e.path);
    if (rec === null) throw new EditFail('missing', e.path);
    const text = serializeText(rec);
    let normText = text;
    let normOld = e.oldStr;
    let normNew = e.newStr;
    if (rec.sep === '\r\n') {
      normText = text.replace(/\r\n/g, '\n');
      normOld = e.oldStr.replace(/\r\n/g, '\n');
      normNew = e.newStr.replace(/\r\n/g, '\n');
    }
    const count = countOverlapping(normText, normOld);
    if (count === 0) throw new EditFail('no-match', e.path);
    if (count > 1) throw new EditFail('ambiguous', e.path);
    const at = normText.indexOf(normOld);
    const replaced = normText.slice(0, at) + normNew + normText.slice(at + normOld.length);
    const outText = rec.sep === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced;
    tree.set(e.path, parseText(outText));
    return null;
  }
  if (e.kind === 'json-insert') {
    checkSafe(e.path);
    const rec = tree.get(e.path);
    if (rec === null) throw new EditFail('missing', e.path);
    if (e.insertLine < 0 || e.insertLine > rec.lines.length) throw new EditFail('no-match', e.path);
    const ins = patchLines(e.newStr);
    const lines = rec.lines.slice(0, e.insertLine).concat(ins, rec.lines.slice(e.insertLine));
    tree.set(e.path, { lines, sep: rec.sep, ends: rec.ends });
    return null;
  }
  return null;
}

// ------------------------------------------------------------ dispatch

function applyEdit(e: Edit, tree: Tree, strict: boolean): [string, string] | null {
  switch (e.kind) {
    case 'unified':
      return applyUnified(e, tree, strict);
    case 'sr':
      return applySearchReplace(e, tree, strict);
    case 'v4a-add': {
      checkSafe(e.path);
      if (tree.exists(e.path)) throw new EditFail('exists', e.path);
      tree.set(e.path, { lines: e.fileLines.slice(), sep: '\n', ends: e.fileLines.length > 0 });
      return null;
    }
    case 'v4a-delete': {
      checkSafe(e.path);
      if (!tree.exists(e.path)) throw new EditFail('missing', e.path);
      tree.set(e.path, null);
      return null;
    }
    case 'v4a-update':
      return applyV4aUpdate(e, tree, strict);
    default:
      return applyJson(e, tree);
  }
}

// ------------------------------------------------------------ detection

// With --format=auto the format is the first of these that holds:
// v4a, json, search-replace, unified. Otherwise there is no format.
function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | undefined;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== undefined) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (trimRightWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------ CLI

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | undefined;
}

function parseCli(argv: string[]): CliArgs | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let afterDashDash = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (!afterDashDash) {
      if (a === '--') {
        afterDashDash = true;
        continue;
      }
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
        continue;
      }
      if (a.startsWith('-') && a !== '-') return null;
    }
    positional.push(a);
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional[0] };
}

// ------------------------------------------------------------ output

// The changed-path lines for an exit 0: one A, D or M line per path whose
// state changed, with a successful move pair that still looks like a move
// (its old path existed before and is gone after, its new path did not
// exist before and is there after) printed as one R line instead. Lines
// sort by their key in UTF-8 byte order: the path for A, D and M, the new
// path for R.
function outputLines(tree: Tree, moves: [string, string][]): string[] {
  const byPath = new Map<string, { key: string; text: string }>();
  for (const p of tree.touchedPaths()) {
    const before = tree.originalText(p);
    const after = tree.currentText(p);
    if (before === after) continue;
    if (before === null) byPath.set(p, { key: p, text: 'A ' + p });
    else if (after === null) byPath.set(p, { key: p, text: 'D ' + p });
    else byPath.set(p, { key: p, text: 'M ' + p });
  }
  for (const [oldP, newP] of moves) {
    const beforeOld = tree.originalText(oldP);
    const afterOld = tree.currentText(oldP);
    const beforeNew = tree.originalText(newP);
    const afterNew = tree.currentText(newP);
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      byPath.delete(oldP);
      byPath.delete(newP);
      byPath.set('R:' + newP, { key: newP, text: 'R ' + oldP + ' -> ' + newP });
    }
  }
  const rows = [...byPath.values()];
  rows.sort((a, b) => byteCompare(a.key, b.key));
  return rows.map((r) => r.text);
}

// ------------------------------------------------------------ run

interface Outcome {
  exit: number;
  lines: string[];
}

function run(argv: string[], getStdin: () => string): Outcome {
  const cli = parseCli(argv);
  if (cli === null) return { exit: 2, lines: ['error: usage'] };
  let patchText: string;
  if (cli.patch === undefined || cli.patch === '-') {
    patchText = getStdin();
  } else {
    try {
      patchText = readFileSync(cli.patch, 'utf8');
    } catch {
      return { exit: 2, lines: ['error: no-patch'] };
    }
  }
  let format = cli.format;
  const lines = patchLines(patchText);
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { exit: 2, lines: ['error: format'] };
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof Fail2) return { exit: 2, lines: [err.line] };
    throw err;
  }
  if (edits.length === 0) return { exit: 2, lines: ['error: parse 1'] };
  const tree = new Tree();
  const failures: EditFail[] = [];
  const moves: [string, string][] = [];
  for (const e of edits) {
    try {
      const mv = applyEdit(e, tree, cli.strict);
      if (mv !== null) moves.push(mv);
    } catch (err) {
      if (err instanceof EditFail) failures.push(err);
      else throw err;
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => 'error: ' + f.code + ' ' + f.path);
    out.push('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    return { exit: 1, lines: out };
  }
  const changed = outputLines(tree, moves);
  if (!cli.check) tree.writeAll();
  const n = changed.length;
  changed.push(n === 1 ? 'ok: 1 file' : 'ok: ' + n + ' files');
  return { exit: 0, lines: changed };
}

// ------------------------------------------------------------ entry point

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const outcome = run(process.argv.slice(2), () => readFileSync(0, 'utf8'));
  for (const line of outcome.lines) process.stdout.write(line + '\n');
  process.exitCode = outcome.exit;
}
