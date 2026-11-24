import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { clean, compilePattern } from './text.js';

const execFileP = promisify(execFile);

export type Target =
  | { kind: 'run'; id: string; job?: string | undefined; repo?: string | undefined }
  | { kind: 'pr'; number: string; repo?: string | undefined }
  | { kind: 'sha'; sha: string }
  | { kind: 'branch'; name: string };

export interface CiSpec {
  target: string;
  repo?: string | undefined;
  log_lines?: number | undefined;
  grep?: string | undefined;
  context?: number | undefined;
  max_matches?: number | undefined;
  jobs?: string | undefined;
}

export const CI_DIR = path.join(os.tmpdir(), 'claude-two-four', 'ci');
const MAX_GREP_JOBS = 20;

export interface Step {
  name: string;
  conclusion: string;
  startedAt?: string;
  completedAt?: string;
}

interface Job {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  steps?: Step[];
}

interface RunView {
  databaseId: number;
  workflowName: string;
  displayTitle: string;
  event: string;
  status: string;
  conclusion: string;
  url: string;
  headSha: string;
  headBranch: string;
  jobs: Job[];
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const MAX_LOG_JOBS = 5;

export function parseTarget(raw: string): Target {
  const t = raw.trim();
  let m = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(t);
  if (m) return { kind: 'run', repo: m[1], id: m[2]!, job: m[3] };
  m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(t);
  if (m) return { kind: 'pr', repo: m[1], number: m[2]! };
  m = /^(?:#|pr:)(\d+)$/i.exec(t);
  if (m) return { kind: 'pr', number: m[1]! };
  if (/^\d{6,}$/.test(t)) return { kind: 'run', id: t };
  if (/^\d+$/.test(t)) return { kind: 'pr', number: t };
  if (/^[0-9a-f]{7,40}$/i.test(t)) return { kind: 'sha', sha: t.toLowerCase() };
  return { kind: 'branch', name: t };
}

const TIMESTAMP = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)[\d.]*Z ?/;

/**
 * Slices a job log to each failed step by the step's start and end times (whole seconds), keeping
 * error annotations plus the step's last lines. Falls back to the whole log when no step has times.
 */
export function condenseLog(text: string, steps: Step[], tail: number): string[] {
  const lines: { at: string; text: string }[] = [];
  let at = '';
  for (const raw of text.split(/\r?\n/)) {
    const m = TIMESTAMP.exec(raw);
    if (m) at = m[1]!;
    const line = clean(m ? raw.slice(m[0].length) : raw);
    if (line && !/^##\[(group|endgroup)\]/.test(line)) lines.push({ at, text: line });
  }
  const failed = steps.filter((s) => FAILED.has(s.conclusion) && s.startedAt && s.completedAt);
  const windows = failed.length
    ? failed.map((s) => {
        const window = lines.filter((l) => l.at >= s.startedAt!.slice(0, 19) && l.at <= s.completedAt!.slice(0, 19)).map((l) => l.text);
        // The failing step ends on its ##[error]; anything after is the next step starting in the same second.
        const end = window.findLastIndex((l) => l.includes('##[error]'));
        return { name: s.name, lines: end >= 0 ? window.slice(0, end + 1) : window };
      })
    : [{ name: '(whole job)', lines: lines.map((l) => l.text) }];
  const out: string[] = [];
  for (const w of windows) {
    out.push(`    step: ${w.name}`);
    const errors = [...new Set(w.lines.filter((l) => l.includes('##[error]')).map((l) => l.replace('##[error]', '').trim()))];
    if (errors.length) out.push('      errors:', ...errors.slice(0, 20).map((e) => `        ${e}`));
    if (tail > 0) out.push(`      last ${Math.min(tail, w.lines.length)} lines:`, ...w.lines.slice(-tail).map((l) => `        ${l}`));
  }
  return out;
}

/** Regex over a job log with timestamps stripped; line numbers are the cached file's, for reading around a hit. */
export function grepLog(text: string, re: RegExp, ctx: number, max: number): string[] {
  const lines = text.split(/\r?\n/).map((l) => clean(l.replace(TIMESTAMP, '')));
  const hits: number[] = [];
  let total = 0;
  for (let n = 0; n < lines.length; n++) {
    if (!re.test(lines[n]!)) continue;
    total++;
    if (hits.length < max) hits.push(n);
  }
  const out = [`    ${total} matching lines`];
  const hitSet = new Set(hits);
  let last = -1;
  for (const h of hits) {
    const from = Math.max(0, h - ctx, last + 1);
    const to = Math.min(lines.length - 1, h + ctx);
    if (last >= 0 && from > last + 1) out.push('      --');
    for (let n = from; n <= to; n++) out.push(`      ${n + 1}${hitSet.has(n) ? ':' : '-'} ${lines[n]}`);
    last = Math.max(last, to);
  }
  if (total > hits.length) out.push(`    (${total - hits.length} more; search the log file)`);
  return out;
}

async function gh(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('gh', args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error((err.stderr || err.message).trim());
  }
}

async function fullSha(sha: string, repo: string | undefined, cwd: string): Promise<string> {
  if (sha.length === 40) return sha;
  if (!repo) {
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd, windowsHide: true });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // not in the local clone; ask GitHub
    }
  }
  return (await gh(['api', `repos/${repo ?? '{owner}/{repo}'}/commits/${sha}`, '--jq', '.sha'], cwd)).trim();
}

/** Newest run per workflow, so reruns and superseded pushes don't repeat. */
async function latestRuns(filter: string[], repoArgs: string[], cwd: string): Promise<string[]> {
  const runs = JSON.parse(
    await gh(['run', 'list', ...filter, ...repoArgs, '--limit', '100', '--json', 'databaseId,workflowName,createdAt'], cwd),
  ) as { databaseId: number; workflowName: string; createdAt: string }[];
  const newest = new Map<string, { databaseId: number; createdAt: string }>();
  for (const r of runs) {
    const cur = newest.get(r.workflowName);
    if (!cur || r.createdAt > cur.createdAt) newest.set(r.workflowName, r);
  }
  return [...newest.values()].map((r) => String(r.databaseId));
}

const label = (status: string, conclusion: string) =>
  status !== 'completed' ? status.toUpperCase() : conclusion === 'success' ? 'PASS' : conclusion === 'failure' ? 'FAIL' : conclusion.toUpperCase();

interface ApiStep {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ApiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps?: ApiStep[];
}

/** Run and jobs via two parallel REST calls, faster than `gh run view --json jobs`, which fetches serially. */
async function fetchRun(id: string, repo: string | undefined, cwd: string): Promise<RunView> {
  const base = `repos/${repo ?? '{owner}/{repo}'}/actions/runs/${id}`;
  const [runJson, jobLines] = await Promise.all([
    gh(['api', base], cwd),
    gh(['api', '--paginate', `${base}/jobs?per_page=100`, '--jq', '.jobs[]'], cwd),
  ]);
  const run = JSON.parse(runJson);
  const jobs = jobLines
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ApiJob)
    .map((j) => ({
      databaseId: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? '',
      steps: (j.steps ?? []).map((s) => ({
        name: s.name,
        conclusion: s.conclusion ?? '',
        ...(s.started_at ? { startedAt: s.started_at } : {}),
        ...(s.completed_at ? { completedAt: s.completed_at } : {}),
      })),
    }));
  return {
    databaseId: run.id,
    workflowName: run.name,
    displayTitle: run.display_title,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion ?? '',
    url: run.html_url,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    jobs,
  };
}

/** Completed jobs' logs never change, so a cached copy (keyed by the globally unique job id) is always current. */
async function jobLog(job: Job, repo: string | undefined, cwd: string): Promise<{ text: string; file: string }> {
  const file = path.join(CI_DIR, `${job.databaseId}.log`);
  const cached = await fs.readFile(file, 'utf8').catch(() => null);
  if (cached !== null) return { text: cached, file };
  const text = await gh(['api', `repos/${repo ?? '{owner}/{repo}'}/actions/jobs/${job.databaseId}/logs`], cwd);
  await fs.mkdir(CI_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text);
  await fs.rename(temp, file);
  return { text, file };
}

export async function readCi(spec: CiSpec, cwd: string): Promise<{ ok: boolean; text: string }> {
  let grep: RegExp | undefined;
  let nameFilter: RegExp | undefined;
  try {
    grep = spec.grep ? compilePattern(spec.grep) : undefined;
    nameFilter = spec.jobs ? compilePattern(spec.jobs) : undefined;
  } catch (e) {
    return { ok: false, text: `Invalid pattern: ${(e as Error).message}` };
  }
  const target = parseTarget(spec.target);
  const repo = spec.repo ?? ('repo' in target ? target.repo : undefined);
  const repoArgs = repo ? ['-R', repo] : [];
  const tail = spec.log_lines ?? 30;
  const out: string[] = [];
  try {
    let ids: string[];
    if (target.kind === 'run') ids = [target.id];
    else if (target.kind === 'branch') {
      ids = await latestRuns(['--branch', target.name], repoArgs, cwd);
      out.push(`branch ${target.name}: latest run per workflow`);
    } else {
      const sha =
        target.kind === 'pr'
          ? JSON.parse(await gh(['pr', 'view', target.number, ...repoArgs, '--json', 'headRefOid'], cwd)).headRefOid as string
          : await fullSha(target.sha, repo, cwd);
      ids = await latestRuns(['--commit', sha], repoArgs, cwd);
      out.push(`${target.kind === 'pr' ? `PR #${target.number} head` : 'commit'} ${sha}`);
    }
    if (!ids.length) return { ok: true, text: [...out, 'No workflow runs found.'].join('\n') };

    const runs = await Promise.all(ids.map((id) => fetchRun(id, repo, cwd)));
    const pick = (run: RunView) =>
      target.kind === 'run' && target.job
        ? run.jobs.filter((j) => String(j.databaseId) === target.job)
        : run.jobs.filter((j) => (nameFilter ? nameFilter.test(j.name) : FAILED.has(j.conclusion)));
    const limit = grep ? MAX_GREP_JOBS : MAX_LOG_JOBS;
    const logJobs: Job[] = [];
    const hasLog = (job: Job) => job.status === 'completed' && job.conclusion !== 'skipped';
    for (const run of runs) for (const job of pick(run)) if (hasLog(job) && logJobs.length < limit) logJobs.push(job);
    const logs = new Map<number, string[]>(
      await Promise.all(
        logJobs.map(async (job): Promise<[number, string[]]> => {
          try {
            const { text, file } = await jobLog(job, repo, cwd);
            const body = grep ? grepLog(text, grep, spec.context ?? 0, spec.max_matches ?? 50) : condenseLog(text, job.steps ?? [], tail);
            return [job.databaseId, [`    log: ${file}`, ...body]];
          } catch (e) {
            return [job.databaseId, [`    log unavailable: ${(e as Error).message}`]];
          }
        }),
      ),
    );
    for (const run of runs) {
      out.push('', `${label(run.status, run.conclusion)} ${run.workflowName}: ${run.displayTitle} (${run.event}, ${run.headBranch} @ ${run.headSha.slice(0, 8)}) ${run.url}`);
      const counts = new Map<string, number>();
      for (const j of run.jobs) counts.set(j.conclusion || j.status, (counts.get(j.conclusion || j.status) ?? 0) + 1);
      out.push(run.jobs.length ? `  ${run.jobs.length} jobs: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}` : '  no jobs ran');
      for (const job of pick(run)) {
        const failedSteps = (job.steps ?? []).filter((s) => FAILED.has(s.conclusion)).map((s) => s.name);
        out.push(`  ${label(job.status, job.conclusion)} job ${job.name} (${job.databaseId})${failedSteps.length ? `, failed step: ${failedSteps.join(', ')}` : ''}`);
        const log = logs.get(job.databaseId);
        if (log) out.push(...log);
        else if (job.conclusion === 'skipped') out.push('    (skipped; no log)');
        else if (job.status === 'completed') out.push(`    (log not fetched: limit ${limit} jobs per call; narrow with jobs or a job URL)`);
        else out.push('    (in progress; log available when the job completes)');
      }
    }
    return { ok: true, text: out.join('\n').trimStart() };
  } catch (e) {
    return { ok: false, text: [...out, `gh failed: ${(e as Error).message}`].join('\n') };
  }
}
