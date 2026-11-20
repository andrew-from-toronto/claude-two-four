import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clean } from './text.js';

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
}

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

export async function readCi(spec: CiSpec, cwd: string): Promise<{ ok: boolean; text: string }> {
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

    const fields = 'databaseId,workflowName,displayTitle,event,status,conclusion,url,headSha,headBranch,jobs';
    const runs = await Promise.all(ids.map(async (id) => JSON.parse(await gh(['run', 'view', id, ...repoArgs, '--json', fields], cwd)) as RunView));
    const logJobs: { run: RunView; job: Job }[] = [];
    for (const run of runs) {
      const jobs = target.kind === 'run' && target.job ? run.jobs.filter((j) => String(j.databaseId) === target.job) : run.jobs.filter((j) => FAILED.has(j.conclusion));
      for (const job of jobs) if (job.status === 'completed' && logJobs.length < MAX_LOG_JOBS) logJobs.push({ run, job });
    }
    const logs = new Map<number, string[]>(
      await Promise.all(
        logJobs.map(async ({ job }): Promise<[number, string[]]> => {
          try {
            const log = await gh(['api', `repos/${repo ?? '{owner}/{repo}'}/actions/jobs/${job.databaseId}/logs`], cwd);
            return [job.databaseId, condenseLog(log, job.steps ?? [], tail)];
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
      const jobs = target.kind === 'run' && target.job ? run.jobs.filter((j) => String(j.databaseId) === target.job) : run.jobs;
      for (const job of jobs) {
        if (!FAILED.has(job.conclusion) && !(target.kind === 'run' && target.job)) continue;
        const failedSteps = (job.steps ?? []).filter((s) => FAILED.has(s.conclusion)).map((s) => s.name);
        out.push(`  ${label(job.status, job.conclusion)} job ${job.name} (${job.databaseId})${failedSteps.length ? `, failed step: ${failedSteps.join(', ')}` : ''}`);
        const log = logs.get(job.databaseId);
        if (log) out.push(...log);
        else if (job.status === 'completed') out.push(`    (log not fetched: only the first ${MAX_LOG_JOBS} failed jobs are)`);
      }
    }
    return { ok: true, text: out.join('\n').trimStart() };
  } catch (e) {
    return { ok: false, text: [...out, `gh failed: ${(e as Error).message}`].join('\n') };
  }
}
