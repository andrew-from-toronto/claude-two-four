import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import picomatch from 'picomatch';

const execFileP = promisify(execFile);

export interface SearchSpec {
  patterns: string[];
  paths?: string[] | undefined;
  include?: string[] | undefined;
  ignore_case?: boolean | undefined;
  context?: number | undefined;
  max_matches?: number | undefined;
  files_only?: boolean | undefined;
}

interface FileHits {
  file: string;
  count: number;
  /** Hit line indexes, capped at max_matches. */
  hits: number[];
  /** Only the hit and context lines, so large files aren't retained. */
  text: Map<number, string>;
}

const GLOB_CHARS = /[*?[\]{}]/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', '.vs']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 300;
const READ_CONCURRENCY = 64;
const NOCASE = process.platform === 'win32';

const toSlash = (p: string) => p.replace(/\\/g, '/');
const clip = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}...` : s);

/** Accepts a leading PCRE-style (?i), (?m) or (?s) group, which JavaScript regex rejects, as flags. */
export function compilePattern(source: string, ignoreCase: boolean): RegExp {
  const m = /^\(\?([ims]+)\)/.exec(source);
  const flags = new Set(m ? m[1]!.split('') : []);
  if (ignoreCase) flags.add('i');
  return new RegExp(m ? source.slice(m[0].length) : source, [...flags].join(''));
}

/** Splits a glob into the deepest literal directory and the absolute pattern. */
export function splitGlob(pattern: string, baseDir: string): { root: string; glob: string } {
  const glob = toSlash(path.resolve(baseDir, pattern));
  const segs = glob.split('/');
  let root = segs.slice(0, segs.findIndex((s) => GLOB_CHARS.test(s))).join('/');
  if (root === '' || /^[A-Za-z]:$/.test(root)) root += '/';
  return { root, glob };
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(p, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Uses git's view of the tree (honours .gitignore) when the directory is in a repo, else walks it. */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: dir,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    const files = stdout.split('\0').filter(Boolean);
    if (files.length) return files.map((f) => path.join(dir, f));
  } catch {
    // not a git repo
  }
  return walk(dir);
}

export async function resolveFiles(paths: string[], baseDir: string): Promise<{ files: string[]; missing: string[] }> {
  const files = new Set<string>();
  const missing: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(baseDir, p);
    const st = await fs.stat(abs).catch(() => null);
    // A real path wins over glob syntax, e.g. a Next.js app/[id] folder.
    if (!st && GLOB_CHARS.test(p)) {
      const { root, glob } = splitGlob(p, baseDir);
      const isMatch = picomatch(glob, { dot: true, nocase: NOCASE });
      const found = (await listFiles(root)).filter((f) => isMatch(toSlash(f)));
      if (!found.length) missing.push(p);
      for (const f of found) files.add(f);
      continue;
    }
    if (!st) missing.push(p);
    else if (st.isDirectory()) for (const f of await listFiles(abs)) files.add(f);
    else files.add(abs);
  }
  return { files: [...files].sort(), missing };
}

async function readText(file: string): Promise<string | null> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, 'r');
    if ((await fh.stat()).size > MAX_FILE_BYTES) return null;
    const buf = await fh.readFile();
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Whole-text test with the m flag, so files that can't match skip line splitting. It never misses a
 * line match except with negative lookarounds, which see the newline; those patterns skip it.
 */
const prefilter = (re: RegExp) =>
  /\(\?<?!/.test(re.source) ? null : new RegExp(re.source, re.flags.includes('m') ? re.flags : `${re.flags}m`);

function snapshot(file: string, lines: string[], all: number[], max: number, ctx: number): FileHits {
  const hits = all.slice(0, max);
  const text = new Map<number, string>();
  for (const h of hits) for (let n = Math.max(0, h - ctx); n <= Math.min(lines.length - 1, h + ctx); n++) text.set(n, lines[n]!);
  return { file, count: all.length, hits, text };
}

/** Adds a file, then drops files past the point where earlier (by path) files already fill the display cap. */
function keep(kept: FileHits[], entry: FileHits, max: number, filesOnly: boolean): void {
  kept.push(entry);
  kept.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  let shown = 0;
  for (let i = 0; i < kept.length; i++) {
    if (shown >= max) {
      kept.length = i;
      return;
    }
    shown += filesOnly ? 1 : kept[i]!.hits.length;
  }
}

export async function runSearch(spec: SearchSpec, baseDir: string): Promise<{ ok: boolean; text: string }> {
  const regexes: RegExp[] = [];
  const bad: string[] = [];
  for (const p of spec.patterns) {
    try {
      regexes.push(compilePattern(p, spec.ignore_case ?? false));
    } catch (e) {
      bad.push(`${p}: ${(e as Error).message}`);
    }
  }
  if (bad.length) return { ok: false, text: `Invalid pattern:\n${bad.join('\n')}` };

  let { files, missing } = await resolveFiles(spec.paths?.length ? spec.paths : ['.'], baseDir);
  if (spec.include?.length) {
    const include = picomatch(spec.include, { basename: true, dot: true, nocase: NOCASE });
    files = files.filter((f) => include(toSlash(f)));
  }

  const max = spec.max_matches ?? 200;
  const ctx = spec.context ?? 0;
  const filesOnly = spec.files_only ?? false;
  const results = regexes.map(() => ({ total: 0, fileCount: 0, kept: [] as FileHits[] }));
  const quick = regexes.map(prefilter);
  let searched = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]!;
      const text = await readText(file);
      if (text === null) continue;
      searched++;
      let lines: string[] | undefined;
      regexes.forEach((re, k) => {
        const q = quick[k];
        if (q && !q.test(text)) return;
        lines ??= text.split('\n');
        const hits: number[] = [];
        for (let n = 0; n < lines.length; n++) if (re.test(lines[n]!)) hits.push(n);
        if (!hits.length) return;
        const r = results[k]!;
        r.total += hits.length;
        r.fileCount++;
        keep(r.kept, snapshot(file, lines, hits, max, ctx), max, filesOnly);
      });
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));

  const display = (f: string) => {
    const rel = path.relative(baseDir, f);
    return toSlash(rel.startsWith('..') || path.isAbsolute(rel) ? f : rel);
  };
  const out = [`Searched ${searched} files.`];
  if (missing.length) out.push(`Nothing found at: ${missing.join(', ')}`);

  results.forEach((r, k) => {
    out.push('', `${regexes[k]}: ${r.total} matches in ${r.fileCount} files`);
    let shown = 0;
    for (const f of r.kept) {
      if (shown >= max) break;
      if (filesOnly) {
        out.push(`${display(f.file)} (${f.count})`);
        shown++;
        continue;
      }
      out.push(display(f.file));
      const hitSet = new Set(f.hits);
      let last = -1;
      for (const h of f.hits) {
        if (shown >= max) break;
        shown++;
        const from = Math.max(0, h - ctx, last + 1);
        if (last >= 0 && from > last + 1) out.push('  --');
        for (let n = from; n <= h + ctx && f.text.has(n); n++) {
          out.push(`  ${n + 1}${hitSet.has(n) ? ':' : '-'} ${clip(f.text.get(n)!)}`);
          last = n;
        }
      }
    }
    const of = filesOnly ? r.fileCount : r.total;
    if (of > shown) out.push(`(${of - shown} more not shown; raise max_matches or narrow paths)`);
  });
  return { ok: true, text: out.join('\n') };
}
