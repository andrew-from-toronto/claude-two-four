import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, openSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { OutputDigest } from './digest.js';
import { compilePattern } from './text.js';

const execFileP = promisify(execFile);

export type Shell = 'pwsh' | 'bash';

export interface RunSpec {
  command: string;
  shell?: Shell | undefined;
  cwd?: string | undefined;
  timeout_seconds?: number | undefined;
  match?: string | undefined;
  context_after?: number | undefined;
  tail?: number | undefined;
  preset?: 'dotnet-test' | undefined;
}

export const OUTPUT_DIR = path.join(os.tmpdir(), 'claude-two-four', 'run');

/** Exits with the last native exit code when the final statement failed, like bash's $?. */
const pwshScript = (command: string) =>
  `${command}\n$__ok = $?\nif ($__ok) { exit 0 }\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\nexit 1\n`;

async function bashPath(): Promise<string> {
  if (process.platform !== 'win32') return '/bin/bash';
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const candidates = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  try {
    const { stdout } = await execFileP('where', ['git'], { windowsHide: true });
    for (const git of stdout.split(/\r?\n/).filter(Boolean)) candidates.unshift(path.resolve(path.dirname(git), '..', 'bin', 'bash.exe'));
  } catch {
    // git not on PATH
  }
  for (const c of candidates) if (await fs.stat(c).then(() => true, () => false)) return c;
  throw new Error('Git Bash not found; set CLAUDE_CODE_GIT_BASH_PATH');
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export async function runCommand(spec: RunSpec, baseDir: string): Promise<{ ok: boolean; text: string }> {
  let match: RegExp | undefined;
  try {
    match = spec.match ? compilePattern(spec.match) : undefined;
  } catch (e) {
    return { ok: false, text: `Invalid match pattern: ${(e as Error).message}` };
  }
  const shell = spec.shell ?? (process.platform === 'win32' ? 'pwsh' : 'bash');
  const cwd = path.resolve(baseDir, spec.cwd ?? '.');
  if (!(await fs.stat(cwd).then((s) => s.isDirectory(), () => false))) return { ok: false, text: `cwd not found: ${cwd}` };
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const slug = spec.command.trim().split(/\s+/).slice(0, 3).join('-').replace(/[^\w.-]+/g, '').slice(0, 40) || 'cmd';
  const base = path.join(OUTPUT_DIR, `${stamp}-${randomBytes(2).toString('hex')}-${slug}`);
  const logPath = `${base}.log`;
  const scriptPath = `${base}.${shell === 'pwsh' ? 'ps1' : 'sh'}`;
  await fs.writeFile(scriptPath, shell === 'pwsh' ? pwshScript(spec.command) : `${spec.command}\n`);

  let exe: string;
  let args: string[];
  try {
    [exe, args] =
      shell === 'pwsh'
        ? ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]]
        : [await bashPath(), [scriptPath.replace(/\\/g, '/')]];
  } catch (e) {
    await fs.rm(scriptPath, { force: true });
    return { ok: false, text: (e as Error).message };
  }

  const started = Date.now();
  const timeoutS = Math.min(spec.timeout_seconds ?? 600, 3600);
  const fd = openSync(logPath, 'w');
  let timedOut = false;
  const { code, error } = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    const child = spawn(exe, args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true, detached: process.platform !== 'win32' });
    closeSync(fd);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutS * 1000);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, error: err });
    });
    child.once('exit', (c) => {
      clearTimeout(timer);
      resolve({ code: c });
    });
  });
  await fs.rm(scriptPath, { force: true });
  if (error) {
    await fs.rm(logPath, { force: true });
    return { ok: false, text: `Could not start ${exe}: ${error.message}` };
  }

  const digest = new OutputDigest({ tail: spec.tail ?? 30, match, contextAfter: spec.context_after, dotnetTest: spec.preset === 'dotnet-test' });
  for await (const line of readline.createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })) digest.push(line);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const status = timedOut ? `timed out after ${timeoutS}s, process tree killed` : `exit ${code ?? 'killed'}`;
  const header = `${status} in ${secs}s, ${digest.count} lines. Full output: ${logPath}`;
  return { ok: !timedOut && code === 0, text: [header, ...digest.render()].join('\n') };
}
