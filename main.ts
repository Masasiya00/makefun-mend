// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0];
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** All positions i >= from where O matches lines at tier (overlaps allowed). */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after from. */
function findTierOcc(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First tier with an occurrence at or after from that ends at the file's last line. */
function findTierEof(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from).filter((p) => p + O.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line) or a new line. */
interface NEntry {
  ctx: boolean;
  text: string;
  oIdx: number;
}

/** Render the lines N writes over a match at pos (context lines from the file; tier-2 re-indent). */
function writeN(fileLines: string[], pos: number, O: string[], N: NEntry[], tier: number): string[] {
  let P = '';
  let F = '';
  if (tier === 2 && O.length > 0) {
    P = leadWs(O[0]!);
    F = leadWs(fileLines[pos]!);
  }
  const out: string[] = [];
  for (const e of N) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oIdx]!);
      continue;
    }
    if (tier === 2 && !onlyWs(e.text) && e.text.startsWith(P)) out.push(F + e.text.slice(P.length));
    else out.push(e.text);
  }
  return out;
}


/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk body line. `empty` marks a raw empty line (a context line with empty text). */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows this hunk's last context or `+` line. */
  bsAfterLastCtxPlus: boolean;
  /** A `\` line follows this hunk's last `+` line (false when it has none). */
  bsAfterLastPlus: boolean;
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | undefined;
  pairNew: string | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  hasHunk: boolean;
}

/** Path from a `--- ` / `+++ ` line: text after the four characters, up to the first tab, trimmed, one leading a/ or b/ removed. */
function dashPath(line: string): string {
  const p = line.slice(4).split('\t')[0]!.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Validate a `diff --git a/<X> b/<Y>` line; returns [X, Y]. */
function diffGitPaths(line: string, ln: number): [string, string] {
  if (!line.startsWith('diff --git a/')) throw new Exit2(`error: parse ${ln}`);
  const rest = line.slice('diff --git a/'.length);
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) throw new Exit2(`error: parse ${ln}`);
  return [rest.slice(0, idx), rest.slice(idx + 3)];
}

function isHunkHeader(line: string): RegExpMatchArray | null {
  return line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
}

/** Scan a unified patch into sections (SPEC.md section 6). */
function scanUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const [x, y] = diffGitPaths(line, ln);
      cur = { gitOld: x, gitNew: y, pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, newFile: false, deletedFile: false, hunks: [], hasHunk: false };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.hasHunk) {
        cur.pairOld = dashPath(line);
        cur.pairNew = dashPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = { gitOld: undefined, gitNew: undefined, pairOld: dashPath(line), pairNew: dashPath(lines[i + 1]!), renOld: undefined, renNew: undefined, newFile: false, deletedFile: false, hunks: [], hasHunk: false };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = isHunkHeader(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${ln}`);
      const hunk: Hunk = { a: Number(m[1]), body: [], bsAfterLastCtxPlus: false, bsAfterLastPlus: false };
      i += 1;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '', empty: true });
          i += 1;
        } else if (bl.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: bl.slice(1), empty: false });
          i += 1;
        } else if (bl.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: bl.slice(1), empty: false });
          i += 1;
        } else if (bl.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: bl.slice(1), empty: false });
          i += 1;
        } else if (bl.startsWith('\\')) {
          hunk.body.push({ kind: 'bs', text: bl.slice(1), empty: false });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      let lastCtxPlus = -1;
      let lastPlus = -1;
      hunk.body.forEach((b, k) => {
        if (b.kind === 'ctx' || b.kind === 'new') lastCtxPlus = k;
        if (b.kind === 'new') lastPlus = k;
      });
      hunk.bsAfterLastCtxPlus = lastCtxPlus >= 0 && hunk.body[lastCtxPlus + 1]?.kind === 'bs';
      hunk.bsAfterLastPlus = lastPlus >= 0 && hunk.body[lastPlus + 1]?.kind === 'bs';
      cur.hunks.push(hunk);
      cur.hasHunk = true;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${ln + 1}`);
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; returns the new text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const m = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NEntry[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        O.push(b.text);
        N.push({ ctx: true, text: b.text, oIdx: O.length - 1 });
      } else if (b.kind === 'old') O.push(b.text);
      else if (b.kind === 'new') N.push({ ctx: false, text: b.text, oIdx: -1 });
    }
    if (O.length > 0) {
      const found = findTierOcc(m.lines, O, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + O.length === m.lines.length;
      const rep = writeN(m.lines, best, O, N, found.tier);
      m.lines = [...m.lines.slice(0, best), ...rep, ...m.lines.slice(best + O.length)];
      if (atEnd) m.final = !h.bsAfterLastCtxPlus;
      d += N.length - O.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > m.lines.length) pos = m.lines.length;
      const atEnd = pos === m.lines.length;
      const rep = N.map((e) => e.text);
      m.lines = [...m.lines.slice(0, pos), ...rep, ...m.lines.slice(pos)];
      if (atEnd) m.final = !h.bsAfterLastCtxPlus;
      d += N.length;
    }
  }
  return renderFile(m);
}

/** One unified section as an edit (SPEC.md section 6). */
function sectionEdit(s: Section, strict: boolean, moves: [string, string][]): Edit {
  const oldRaw = s.pairOld ?? s.renOld ?? s.gitOld ?? null;
  const newRaw = s.pairNew ?? s.renNew ?? s.gitNew ?? null;
  const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === '/dev/null' ? null : newRaw;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = newPath === null || s.deletedFile;
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (isCreate) {
      const p = newPath;
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let final = true;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        const h = s.hunks[k]!;
        if (h.body.some((b) => b.kind === 'new')) {
          final = !h.bsAfterLastPlus;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldPath;
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const o = oldPath!;
      const nw = newPath!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const out = applyHunks(cur, s.hunks, strict, o);
      tree.now.set(nw, out);
      tree.now.set(o, null);
      moves.push([o, nw]);
      return;
    }
    const p = (oldPath ?? newPath)!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(cur, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  return scanUnified(lines).map((s) => sectionEdit(s, strict, moves));
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const m = parseFile(cur);
    const found = findTierOcc(m.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const N: NEntry[] = newLines.map((t) => ({ ctx: false, text: t, oIdx: -1 }));
    const rep = writeN(m.lines, pos, oldLines, N, found.tier);
    m.lines = [...m.lines.slice(0, pos), ...rep, ...m.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile(m));
  };
}

/** Scan SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLn}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLn}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLn}`);
    edits.push(srBlockEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLn: number;
  content: { line: string; ln: number }[];
}

/** Scan a V4A patch into sections (SPEC.md section 8). */
function scanV4a(lines: string[]): V4ASection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const ln = i + 1;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    if (kind !== null) {
      if (cur !== null) sections.push(cur);
      cur = { kind, path, headerLn: ln, content: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${ln}`);
    }
    cur.content.push({ line, ln });
  }
  if (cur !== null) sections.push(cur);
  for (const s of sections) {
    while (s.content.length > 0 && blank(s.content[s.content.length - 1]!.line)) s.content.pop();
  }
  return sections;
}

/** Parse an Update File section's chunks from its content lines. */
function parseV4aChunks(content: { line: string; ln: number }[], headerLn: number): { moveTo: string | null; chunks: V4AChunk[] } {
  let moveTo: string | null = null;
  let k = 0;
  const firstNonBlank = content.findIndex((c) => !blank(c.line));
  if (firstNonBlank >= 0 && content[firstNonBlank]!.line.startsWith('*** Move to: ')) {
    moveTo = content[firstNonBlank]!.line.slice('*** Move to: '.length).trim();
    k = firstNonBlank + 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let afterEof = false;
  for (; k < content.length; k += 1) {
    const { line, ln } = content[k]!;
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      chunks.push(cur);
      afterEof = false;
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
      afterEof = true;
      continue;
    }
    if (afterEof) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${ln}`);
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      if (line === '') cur.body.push({ kind: 'ctx', text: '', empty: true });
      else if (line.startsWith(' ')) cur.body.push({ kind: 'ctx', text: line.slice(1), empty: false });
      else if (line.startsWith('-')) cur.body.push({ kind: 'old', text: line.slice(1), empty: false });
      else cur.body.push({ kind: 'new', text: line.slice(1), empty: false });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLn}`);
  return { moveTo, chunks };
}

/** One V4A section as an edit (SPEC.md section 8). */
function v4aSectionEdit(s: V4ASection, strict: boolean, moves: [string, string][]): Edit {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const c of s.content) {
      if (c.line === '') fileLines.push('');
      else if (c.line.startsWith('+')) fileLines.push(c.line.slice(1));
      else throw new Exit2(`error: parse ${c.ln}`);
    }
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, text);
    };
  }
  if (s.kind === 'delete') {
    for (const c of s.content) {
      if (!blank(c.line)) throw new Exit2(`error: parse ${c.ln}`);
    }
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  const { moveTo, chunks } = parseV4aChunks(s.content, s.headerLn);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const f = findTierOcc(m.lines, [ch.anchor], cursor, strict);
        if (f === null) throw new Fail('no-match', s.path);
        cursor = f.occ[0]! + 1;
      }
      const O: string[] = [];
      const N: NEntry[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          O.push(b.text);
          N.push({ ctx: true, text: b.text, oIdx: O.length - 1 });
        } else if (b.kind === 'old') O.push(b.text);
        else if (b.kind === 'new') N.push({ ctx: false, text: b.text, oIdx: -1 });
      }
      if (O.length > 0) {
        const found = ch.eof ? findTierEof(m.lines, O, cursor, strict) : findTierOcc(m.lines, O, cursor, strict);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.occ[0]!;
        const rep = writeN(m.lines, pos, O, N, found.tier);
        m.lines = [...m.lines.slice(0, pos), ...rep, ...m.lines.slice(pos + O.length)];
        cursor = pos + rep.length;
      } else {
        const pos = ch.eof ? m.lines.length : cursor;
        const rep = N.map((e) => e.text);
        m.lines = [...m.lines.slice(0, pos), ...rep, ...m.lines.slice(pos)];
        cursor = pos + rep.length;
      }
    }
    const out = renderFile(m);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(s.path, null);
      moves.push([s.path, moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  return scanV4a(lines).map((s) => v4aSectionEdit(s, strict, moves));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const byKey = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      byKey.delete(oldP);
      byKey.delete(newP);
      byKey.set(newP, `R ${oldP} -> ${newP}`);
    }
  }
  const rows = [...byKey.keys()].sort(byteCmp).map((k) => byKey.get(k)!);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
