import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSearch, splitGlob } from '../src/search.js';
import { compilePattern } from '../src/text.js';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-test-'));
  await fs.mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.cs'), 'class Alpha\r\n{\r\n  // TODO fix\r\n}\r\n');
  await fs.writeFile(path.join(dir, 'src', 'deep', 'b.ts'), 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n');
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'c.ts'), 'alpha in a dependency\n');
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0, 1, 2]));
});

afterAll(() => fs.rm(dir, { recursive: true, force: true }));

describe('compilePattern', () => {
  it('turns a leading PCRE flag group into JS flags', () => {
    const re = compilePattern('(?i)warn|error', false);
    expect(re.flags).toBe('i');
    expect(re.test('WARN')).toBe(true);
  });

  it('adds ignore_case without duplicating the flag', () => {
    expect(compilePattern('(?i)x', true).flags).toBe('i');
  });

  it('rejects invalid regex', () => {
    expect(() => compilePattern('(', false)).toThrow();
  });
});

describe('splitGlob', () => {
  it('keeps the literal directory prefix as the root', () => {
    const { root, glob } = splitGlob('src/**/*.ts', '/repo');
    expect(root.endsWith('/repo/src')).toBe(true);
    expect(glob.endsWith('/repo/src/**/*.ts')).toBe(true);
  });
});

describe('runSearch', () => {
  it('reports each pattern separately and skips node_modules and binaries', async () => {
    const { ok, text } = await runSearch({ patterns: ['alpha', 'gamma'], ignore_case: true }, dir);
    expect(ok).toBe(true);
    expect(text).toContain('Searched 2 files.');
    expect(text).toContain('/alpha/i: 2 matches in 2 files');
    expect(text).toContain('src/a.cs\n  1: class Alpha');
    expect(text).toContain('src/deep/b.ts\n  1: const alpha = 1;');
    expect(text).toContain('/gamma/i: 1 matches in 1 files');
    expect(text).not.toContain('node_modules');
  });

  it('prints context lines and honours include and glob paths', async () => {
    const { text } = await runSearch({ patterns: ['beta'], paths: ['src/**/*.ts'], context: 1 }, dir);
    expect(text).toContain('  1- const alpha = 1;\n  2: const beta = 2;\n  3- const gamma = 3;');
    const folders = await runSearch({ patterns: ['beta'], paths: ['s*/deep'] }, dir);
    expect(folders.text).toContain('src/deep/b.ts\n  2: const beta = 2;');
    const inc = await runSearch({ patterns: ['alpha'], include: ['*.cs'], ignore_case: true }, dir);
    expect(inc.text).toContain('1 matches in 1 files');
  });

  it('lists files only and caps output', async () => {
    const { text } = await runSearch({ patterns: ['const'], files_only: true }, dir);
    expect(text).toContain('src/deep/b.ts (3)');
    const capped = await runSearch({ patterns: ['const'], max_matches: 1 }, dir);
    expect(capped.text).toContain('(2 more not shown');
  });

  it('finds negative-lookaround matches the whole-file prefilter would miss', async () => {
    const { text } = await runSearch({ patterns: ['const (?!alpha)\\w+ = \\d;$', '\\d;(?!\\s)'], paths: ['src/deep/b.ts'] }, dir);
    expect(text).toContain('2 matches in 1 files');
    expect(text).toContain('3 matches in 1 files');
  });

  it('treats an existing path with glob characters as a literal folder', async () => {
    await fs.mkdir(path.join(dir, 'app', '[id]'), { recursive: true });
    await fs.writeFile(path.join(dir, 'app', '[id]', 'page.tsx'), 'export const page = 1;\n');
    const { text } = await runSearch({ patterns: ['page'], paths: ['app/[id]'] }, dir);
    expect(text).toContain('app/[id]/page.tsx\n  1: export const page = 1;');
  });

  it('shows the first files by path when capped, whatever order reads finish in', async () => {
    const { text } = await runSearch({ patterns: ['(?i)alpha'], max_matches: 1, files_only: true }, dir);
    expect(text).toContain('2 matches in 2 files\nsrc/a.cs (1)\n(1 more not shown');
  });

  it('reports missing paths and invalid patterns', async () => {
    expect((await runSearch({ patterns: ['x'], paths: ['nope'] }, dir)).text).toContain('Nothing found at: nope');
    const bad = await runSearch({ patterns: ['('] }, dir);
    expect(bad.ok).toBe(false);
  });
});
