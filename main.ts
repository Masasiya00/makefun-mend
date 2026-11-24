// mend: one patch tool for every AI edit format.
// Node 22, standard library only. The contract is SPEC.md.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON tool calls), applies its edits to the tree
// rooted at the working directory, and writes every change or none.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

/** A fault in the patch itself: exit 2, `error: parse <line>`. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

/** One edit failed: exit 1, `error: <code> <path>`. */
class EditFail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(code + ' ' + path);
    this.code = code;
    this.path = path;
  }
}

function parseFail(line: number): never {
  throw new ParseError(line);
}

// ------------------------------------------------------------- small bits

/** True when the line is empty or only whitespace. */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** The leading spaces and tabs of a line. */
function leadingWS(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** Compare two strings in UTF-8 byte order. */
function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ------------------------------------------------------------ file model

/** One text file: its lines, its line break, whether it ends with one. */
interface FileModel {
  lines: string[];
  sep: string;
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], sep: '\n', ends: false };
  const nl = text.indexOf('\n');
  const sep = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(sep);
  let ends = false;
  if (text.endsWith(sep)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, sep, ends };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.sep) + (f.ends ? f.sep : '');
}

/** A patch's lines: split at \n, one trailing \r removed from each, and
 *  the empty piece after a final \n dropped. */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

// ------------------------------------------------------------------ paths

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.indexOf('\\') !== -1) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFail('unsafe', p);
}

// ------------------------------------------------------------- matching

/** A line normalised for one matching tier. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || k > lines.length) return out;
  const no = o.map((l) => normLine(l, tier));
  const nl = lines.map((l) => normLine(l, tier));
  for (let i = 0; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (nl[i + j] !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and the index into O when it is a context
 *  line (null for a line only N has). */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Build the lines that replace a match: context lines are the file's own
 *  matched lines; at tier 2 every other non-blank line that starts with
 *  O's first line's leading whitespace has that replaced by the file's
 *  first matched line's leading whitespace. */
function buildN(
  n: NLine[],
  fileLines: string[],
  pos: number,
  o: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = leadingWS(fileLines[pos]);
  const p = leadingWS(o[0]);
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(fileLines[pos + e.ctx]);
      continue;
    }
    let t = e.text;
    if (tier === 2 && !/^[ \t]*$/.test(t) && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/** The first line at or after `from` equal to a single line at the first
 *  tier where one is; -1 when there is none. */
function findSingle(
  lines: string[],
  anchor: string,
  from: number,
  strict: boolean,
): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i], t) === want) return i;
    }
  }
  return -1;
}

// ------------------------------------------------------------------- tree

/** The working tree: the disk as it was, plus the edits applied so far.
 *  Nothing is written to disk until the run decides it succeeded. */
class Tree {
  /** Raw text as it was on disk (null: absent), for every path touched. */
  orig: Map<string, string | null> = new Map();
  /** Current state of every touched path (null: deleted). */
  state: Map<string, FileModel | null> = new Map();
  /** Successful moves, in patch order, as [old path, new path]. */
  moves: Array<[string, string]> = [];
  private loaded: Map<string, string | null> = new Map();

  private loadRaw(p: string): string | null {
    if (this.loaded.has(p)) return this.loaded.get(p) as string | null;
    let raw: string | null;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      raw = null;
    }
    this.loaded.set(p, raw);
    return raw;
  }

  exists(p: string): boolean {
    if (this.state.has(p)) return this.state.get(p) !== null;
    return this.loadRaw(p) !== null;
  }

  getModel(p: string): FileModel | null {
    if (this.state.has(p)) return this.state.get(p) as FileModel | null;
    const raw = this.loadRaw(p);
    if (raw === null) return null;
    return parseFile(raw);
  }

  getRaw(p: string): string | null {
    const m = this.getModel(p);
    return m === null ? null : renderFile(m);
  }

  set(p: string, model: FileModel | null): void {
    if (!this.orig.has(p)) this.orig.set(p, this.loadRaw(p));
    this.state.set(p, model);
  }

  setRaw(p: string, text: string): void {
    this.set(p, parseFile(text));
  }

  setText(p: string, lines: string[], ends: boolean): void {
    this.set(p, { lines, sep: '\n', ends });
  }
}

/** One parsed edit. */
interface Edit {
  apply(tree: Tree, strict: boolean): void;
}

// ------------------------------------------------------- output and write

/** The exit-0 lines: one per changed path, in UTF-8 byte order of the
 *  sort key (the path itself, or the new path for a move line). */
function outputLines(tree: Tree): string[] {
  const byKey = new Map<string, { key: string; text: string }>();
  for (const [p, before] of tree.orig) {
    const m = tree.state.get(p);
    const after = m === null ? null : m === undefined ? before : renderFile(m);
    if (before === after) continue;
    if (before === null) byKey.set(p, { key: p, text: 'A ' + p });
    else if (after === null) byKey.set(p, { key: p, text: 'D ' + p });
    else byKey.set(p, { key: p, text: 'M ' + p });
  }
  for (const [oldP, newP] of tree.moves) {
    const beforeOld = tree.orig.get(oldP);
    const afterOldModel = tree.state.get(oldP);
    const afterOld =
      afterOldModel === null ? null : afterOldModel === undefined ? beforeOld : renderFile(afterOldModel);
    const beforeNew = tree.orig.get(newP);
    const afterNewModel = tree.state.get(newP);
    const afterNew =
      afterNewModel === null ? null : afterNewModel === undefined ? beforeNew : renderFile(afterNewModel);
    if (beforeOld !== null && beforeOld !== undefined && afterOld === null && beforeNew === null && afterNew !== null) {
      byKey.delete(oldP);
      byKey.delete(newP);
      byKey.set('R:' + newP, { key: newP, text: 'R ' + oldP + ' -> ' + newP });
    }
  }
  const rows = [...byKey.values()];
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  return rows.map((r) => r.text);
}

/** Write every change to disk: only paths whose bytes actually differ. */
function writeTree(tree: Tree): void {
  for (const [p, before] of tree.orig) {
    const m = tree.state.get(p);
    const after = m === null ? null : m === undefined ? before : renderFile(m);
    if (after === before) continue;
    if (after === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, after, 'utf8');
    }
  }
}

// ------------------------------------------------------------ unified diff

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  oldPath: string;
  newPath: string;
  pairNamed: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** O and N of a hunk body, in body order. */
function hunkON(hunk: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of hunk.body) {
    if (bl === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: null });
    }
  }
  return { o, n };
}

/** True when a `\` line immediately follows the hunk's last context or
 *  `+` line; an empty body line counts as a context line. */
function hunkBackslash(hunk: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < hunk.body.length; k += 1) {
    const bl = hunk.body[k];
    if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const next = hunk.body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

/** True when a `\` line immediately follows the hunk's last `+` line. */
function hunkPlusBackslash(hunk: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < hunk.body.length; k += 1) {
    if (hunk.body[k].startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const next = hunk.body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = model.lines.slice();
  let ends = model.ends;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkON(hunk);
    const backslash = hunkBackslash(hunk);
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new EditFail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (let k = 1; k < found.occ.length; k += 1) {
        const dist = Math.abs(found.occ[k] - target);
        if (dist < bestDist) {
          best = found.occ[k];
          bestDist = dist;
        }
      }
      const pos = best;
      const repl = buildN(n, lines, pos, o, found.tier);
      const touchesEnd = pos + o.length === lines.length;
      lines.splice(pos, o.length, ...repl);
      if (touchesEnd) ends = !backslash;
      d += n.length - o.length;
    } else {
      let insertPos = hunk.a + d;
      if (insertPos < 0) insertPos = 0;
      if (insertPos > lines.length) insertPos = lines.length;
      const atEnd = insertPos === lines.length;
      const ins = n.map((e) => e.text);
      lines.splice(insertPos, 0, ...ins);
      if (atEnd) ends = !backslash;
      d += n.length;
    }
  }
  return { lines, sep: model.sep, ends };
}

/** The path after a `--- ` or `+++ ` line: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed and
 *  one leading `a/` or `b/` removed. */
function parseUnifiedPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab !== -1) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHasHunk = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const prefix = 'diff --git a/';
      if (!line.startsWith(prefix)) parseFail(i + 1);
      const rest = line.slice(prefix.length);
      const idx = rest.lastIndexOf(' b/');
      if (idx === -1) parseFail(i + 1);
      cur = {
        oldPath: rest.slice(0, idx),
        newPath: rest.slice(idx + 3),
        pairNamed: false,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      curHasHunk = false;
      i += 1;
    } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur === null || curHasHunk) {
        cur = { oldPath: '', newPath: '', pairNamed: false, isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
        curHasHunk = false;
      }
      cur.oldPath = parseUnifiedPath(line);
      cur.newPath = parseUnifiedPath(lines[i + 1]);
      cur.pairNamed = true;
      i += 2;
    } else if (line.startsWith('--- ')) {
      if (cur !== null && !curHasHunk) parseFail(i + 2);
      i += 1;
    } else if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) parseFail(i + 1);
      if (cur === null) parseFail(i + 1);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      curHasHunk = true;
      i = j;
    } else if (cur !== null && !curHasHunk) {
      if (line.startsWith('rename from ')) {
        if (!cur.pairNamed) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.pairNamed) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(s: Section): Edit {
  return {
    apply(tree: Tree, strict: boolean): void {
      const oldIsNull = s.oldPath === '/dev/null';
      const newIsNull = s.newPath === '/dev/null';
      if (!oldIsNull) checkSafe(s.oldPath);
      if (!newIsNull) checkSafe(s.newPath);
      if (s.isCreate || oldIsNull) {
        if (tree.exists(s.newPath)) throw new EditFail('exists', s.newPath);
        const plus: string[] = [];
        for (const h of s.hunks) {
          for (const bl of h.body) {
            if (bl.startsWith('+')) plus.push(bl.slice(1));
          }
        }
        let ends = true;
        if (plus.length === 0) {
          ends = false;
        } else {
          let lastHunk: Hunk | null = null;
          for (const h of s.hunks) {
            if (h.body.some((bl) => bl.startsWith('+'))) lastHunk = h;
          }
          if (lastHunk !== null && hunkPlusBackslash(lastHunk)) ends = false;
        }
        tree.setText(s.newPath, plus, ends);
        return;
      }
      if (s.isDelete || newIsNull) {
        if (!tree.exists(s.oldPath)) throw new EditFail('missing', s.oldPath);
        tree.set(s.oldPath, null);
        return;
      }
      if (s.oldPath !== s.newPath) {
        if (!tree.exists(s.oldPath)) throw new EditFail('missing', s.oldPath);
        if (tree.exists(s.newPath)) throw new EditFail('exists', s.newPath);
        const model = tree.getModel(s.oldPath);
        if (model === null) throw new EditFail('missing', s.oldPath);
        const result = applyHunks(model, s.hunks, strict, s.oldPath);
        tree.set(s.newPath, result);
        tree.set(s.oldPath, null);
        tree.moves.push([s.oldPath, s.newPath]);
        return;
      }
      if (!tree.exists(s.oldPath)) throw new EditFail('missing', s.oldPath);
      const model = tree.getModel(s.oldPath);
      if (model === null) throw new EditFail('missing', s.oldPath);
      const result = applyHunks(model, s.hunks, strict, s.oldPath);
      tree.set(s.oldPath, result);
    },
  };
}

// --------------------------------------------------------- SEARCH/REPLACE

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path: the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks once trimmed; else the previous block's path.
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevReplace; k -= 1) {
      const cand = lines[k];
      if (isBlank(cand)) continue;
      const trimmed = cand.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) parseFail(searchIdx + 1);
    // The first `=======` after SEARCH, then the first `>>>>>>> REPLACE`.
    let eqIdx = -1;
    for (let k = searchIdx + 1; k < n; k += 1) {
      if (lines[k].trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx === -1) parseFail(searchIdx + 1);
    let repIdx = -1;
    for (let k = eqIdx + 1; k < n; k += 1) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        repIdx = k;
        break;
      }
    }
    if (repIdx === -1) parseFail(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const foundPath: string = path;
    edits.push({
      apply(tree: Tree, strict: boolean): void {
        checkSafe(foundPath);
        if (oldLines.length === 0) {
          if (tree.exists(foundPath)) throw new EditFail('exists', foundPath);
          tree.setText(foundPath, newLines.slice(), newLines.length > 0);
          return;
        }
        const model = tree.getModel(foundPath);
        if (model === null) throw new EditFail('missing', foundPath);
        const found = findTier(model.lines, oldLines, strict);
        if (found === null) throw new EditFail('no-match', foundPath);
        if (found.occ.length > 1) throw new EditFail('ambiguous', foundPath);
        const pos = found.occ[0];
        const nlines: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
        const repl = buildN(nlines, model.lines, pos, oldLines, found.tier);
        const out = model.lines.slice();
        out.splice(pos, oldLines.length, ...repl);
        tree.set(foundPath, { lines: out, sep: model.sep, ends: model.ends });
      },
    });
    prevPath = foundPath;
    prevReplace = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

// -------------------------------------------------------------------- V4A

function isV4aSectionStart(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let k = 0; k < n; k += 1) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) parseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') parseFail(first + 1);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') parseFail(n + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i])) i += 1;
    if (i >= last) break;
    const header = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (header.startsWith('*** Add File: ')) {
      kind = 'add';
      path = header.slice('*** Add File: '.length).trim();
    } else if (header.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = header.slice('*** Delete File: '.length).trim();
    } else if (header.startsWith('*** Update File: ')) {
      kind = 'update';
      path = header.slice('*** Update File: '.length).trim();
    } else {
      parseFail(i + 1);
    }
    const headerIdx = i;
    let j = i + 1;
    while (j < last && !isV4aSectionStart(lines[j])) j += 1;
    let bodyEnd = j;
    while (bodyEnd > headerIdx + 1 && isBlank(lines[bodyEnd - 1])) bodyEnd -= 1;
    const body = lines.slice(headerIdx + 1, bodyEnd);
    const bodyBase = headerIdx + 1;
    if (kind === 'add') edits.push(v4aAddEdit(path, body, bodyBase));
    else if (kind === 'delete') edits.push(v4aDeleteEdit(path, body, bodyBase));
    else edits.push(v4aUpdateEdit(path, body, bodyBase, headerIdx + 1));
    i = j;
  }
  return edits;
}

function v4aAddEdit(path: string, body: string[], bodyBase: number): Edit {
  const fileLines: string[] = [];
  for (let k = 0; k < body.length; k += 1) {
    const bl = body[k];
    if (bl.startsWith('+')) fileLines.push(bl.slice(1));
    else if (bl === '') fileLines.push('');
    else parseFail(bodyBase + k + 1);
  }
  return {
    apply(tree: Tree): void {
      checkSafe(path);
      if (tree.exists(path)) throw new EditFail('exists', path);
      tree.setText(path, fileLines, fileLines.length > 0);
    },
  };
}

function v4aDeleteEdit(path: string, body: string[], bodyBase: number): Edit {
  for (let k = 0; k < body.length; k += 1) {
    if (!isBlank(body[k])) parseFail(bodyBase + k + 1);
  }
  return {
    apply(tree: Tree): void {
      checkSafe(path);
      if (!tree.exists(path)) throw new EditFail('missing', path);
      tree.set(path, null);
    },
  };
}

function v4aUpdateEdit(path: string, body: string[], bodyBase: number, headerLineNo: number): Edit {
  // `*** Move to:` is only the section's first line, literally: the first
  // content line after the header. A blank first line is a body line
  // (an empty context line) that starts the first chunk, so a Move to
  // after it is a parse error on the Move to line.
  let moveTo: string | null = null;
  let rest = body;
  let restBase = bodyBase;
  if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
    moveTo = body[0].slice('*** Move to: '.length).trim();
    rest = body.slice(1);
    restBase = bodyBase + 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let afterEof = false;
  for (let k = 0; k < rest.length; k += 1) {
    const bl = rest[k];
    const lineNo = restBase + k + 1;
    if (bl === '*** End of File') {
      if (cur === null) parseFail(lineNo);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      afterEof = true;
      continue;
    }
    if (bl.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const a = bl.slice(2).trim();
      cur = { anchor: a === '' ? null : a, o: [], n: [], eof: false };
      afterEof = false;
      continue;
    }
    // A blank line outside a chunk body (after End of File, before the
    // next @@) is ignored.
    if (afterEof && isBlank(bl)) continue;
    if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
      if (cur === null) {
        if (afterEof) parseFail(lineNo);
        cur = { anchor: null, o: [], n: [], eof: false };
      }
      if (bl === '') {
        cur.o.push('');
        cur.n.push({ text: '', ctx: cur.o.length - 1 });
      } else if (bl.startsWith(' ')) {
        const t = bl.slice(1);
        cur.o.push(t);
        cur.n.push({ text: t, ctx: cur.o.length - 1 });
      } else if (bl.startsWith('-')) {
        cur.o.push(bl.slice(1));
      } else {
        cur.n.push({ text: bl.slice(1), ctx: null });
      }
      continue;
    }
    parseFail(lineNo);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) parseFail(headerLineNo);
  const moveToPath: string | null = moveTo;
  return {
    apply(tree: Tree, strict: boolean): void {
      checkSafe(path);
      if (moveToPath !== null) checkSafe(moveToPath);
      const model = tree.getModel(path);
      if (model === null) throw new EditFail('missing', path);
      if (moveToPath !== null && tree.exists(moveToPath)) throw new EditFail('exists', moveToPath);
      let lines = model.lines.slice();
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const idx = findSingle(lines, chunk.anchor, cursor, strict);
          if (idx === -1) throw new EditFail('no-match', path);
          cursor = idx + 1;
        }
        if (chunk.o.length > 0) {
          const tiers = strict ? [0] : [0, 1, 2];
          let pos = -1;
          let tier = 0;
          for (const t of tiers) {
            const occ = occurrences(lines, chunk.o, t).filter((p) => {
              if (p < cursor) return false;
              if (chunk.eof) return p + chunk.o.length === lines.length;
              return true;
            });
            if (occ.length > 0) {
              pos = occ[0];
              tier = t;
              break;
            }
          }
          if (pos === -1) throw new EditFail('no-match', path);
          const repl = buildN(chunk.n, lines, pos, chunk.o, tier);
          lines.splice(pos, chunk.o.length, ...repl);
          cursor = pos + repl.length;
        } else {
          const insertPos = chunk.eof ? lines.length : cursor;
          const ins = chunk.n.map((e) => e.text);
          lines.splice(insertPos, 0, ...ins);
          cursor = insertPos + ins.length;
        }
      }
      const result: FileModel = { lines, sep: model.sep, ends: model.ends };
      if (moveToPath !== null) {
        tree.set(moveToPath, result);
        tree.set(path, null);
        tree.moves.push([path, moveToPath]);
      } else {
        tree.set(path, result);
      }
    },
  };
}

// ------------------------------------------------------------------- JSON

/** The lines of a JSON `insert` new_str: split at \n, one trailing \r
 *  removed from each, without the empty piece after a final \n; an empty
 *  string has no lines. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  return patchLines(s);
}

function jsonEdit(obj: unknown, lineNo: number): Edit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) parseFail(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') parseFail(lineNo);
  if (typeof o.command !== 'string') parseFail(lineNo);
  const path: string = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') parseFail(lineNo);
    const text: string = o.file_text;
    return {
      apply(tree: Tree): void {
        checkSafe(path);
        if (tree.exists(path)) throw new EditFail('exists', path);
        tree.setRaw(path, text);
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') parseFail(lineNo);
    let newStr = '';
    if (o.new_str !== undefined) {
      if (typeof o.new_str !== 'string') parseFail(lineNo);
      newStr = o.new_str;
    }
    const oldStr: string = o.old_str;
    return {
      apply(tree: Tree): void {
        checkSafe(path);
        const model = tree.getModel(path);
        if (model === null) throw new EditFail('missing', path);
        const raw = renderFile(model);
        const isCrlf = model.sep === '\r\n';
        const text = isCrlf ? raw.replace(/\r\n/g, '\n') : raw;
        const oldN = isCrlf ? oldStr.replace(/\r\n/g, '\n') : oldStr;
        const newN = isCrlf ? newStr.replace(/\r\n/g, '\n') : newStr;
        let count = 0;
        let at = -1;
        let idx = text.indexOf(oldN);
        while (idx !== -1) {
          count += 1;
          at = idx;
          idx = text.indexOf(oldN, idx + 1);
        }
        if (count === 0) throw new EditFail('no-match', path);
        if (count > 1) throw new EditFail('ambiguous', path);
        const replaced = text.slice(0, at) + newN + text.slice(at + oldN.length);
        tree.setRaw(path, isCrlf ? replaced.replace(/\n/g, '\r\n') : replaced);
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) parseFail(lineNo);
    if (typeof o.new_str !== 'string') parseFail(lineNo);
    const insertLine: number = o.insert_line;
    const newStr: string = o.new_str;
    return {
      apply(tree: Tree): void {
        checkSafe(path);
        const model = tree.getModel(path);
        if (model === null) throw new EditFail('missing', path);
        if (insertLine < 0 || insertLine > model.lines.length) throw new EditFail('no-match', path);
        const ins = splitNewStr(newStr);
        const out = model.lines.slice();
        out.splice(insertLine, 0, ...ins);
        tree.set(path, { lines: out, sep: model.sep, ends: model.ends });
      },
    };
  }
  parseFail(lineNo);
}

function parseJson(lines: string[], text: string): Edit[] {
  const firstNonWs = text.search(/\S/);
  if (firstNonWs === -1) return [];
  if (text[firstNonWs] === '[') {
    const startLine = text.slice(0, firstNonWs).split('\n').length;
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      parseFail(startLine);
    }
    if (!Array.isArray(arr)) parseFail(startLine);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(jsonEdit(el, startLine));
    return edits;
  }
  const edits: Edit[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    if (isBlank(line)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      parseFail(k + 1);
    }
    edits.push(jsonEdit(obj, k + 1));
  }
  return edits;
}

// ------------------------------------------------------- format detection

function detectFormat(text: string): string | null {
  const lines = patchLines(text);
  let firstNonBlank = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (!isBlank(lines[k])) {
      firstNonBlank = k;
      break;
    }
  }
  if (firstNonBlank !== -1) {
    if (lines[firstNonBlank].trim() === '*** Begin Patch') return 'v4a';
    const c = lines[firstNonBlank].trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k].trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------- run

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seen.has('check')) return { code: 2, out: ['error: usage'] };
        seen.add('check');
        check = true;
      } else if (arg === '--strict') {
        if (seen.has('strict')) return { code: 2, out: ['error: usage'] };
        seen.add('strict');
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('format')) return { code: 2, out: ['error: usage'] };
        seen.add('format');
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return { code: 2, out: ['error: usage'] };
        }
        format = v;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 ? '-' : positional[0];
  let patchText: string;
  if (patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    const detected = detectFormat(patchText);
    if (detected === null) return { code: 2, out: ['error: format'] };
    fmt = detected;
  }
  const lines = patchLines(patchText);
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: ['error: parse ' + e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const failures: string[] = [];
  for (const edit of edits) {
    try {
      edit.apply(tree, strict);
    } catch (e) {
      if (e instanceof EditFail) failures.push('error: ' + e.code + ' ' + e.path);
      else throw e;
    }
  }
  if (failures.length > 0) {
    failures.push('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    return { code: 1, out: failures };
  }
  const out = outputLines(tree);
  out.push('ok: ' + out.length + (out.length === 1 ? ' file' : ' files'));
  if (!check) writeTree(tree);
  return { code: 0, out };
}

// --------------------------------------------------------------- handover

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = run(process.argv.slice(2));
  for (const line of result.out) process.stdout.write(line + '\n');
  process.exitCode = result.code;
}
