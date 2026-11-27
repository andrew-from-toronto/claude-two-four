import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

interface Limit {
  kind: string;
  percent: number;
  severity?: string | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
}

interface Window {
  utilization: number | null;
  resets_at?: string | null;
}

interface Money {
  amount_minor: number;
  currency: string;
  exponent: number;
}

export interface UsageResponse {
  limits?: Limit[] | null;
  five_hour?: Window | null;
  seven_day?: Window | null;
  spend?: { used?: Money | null; limit?: Money | null; percent?: number | null; enabled?: boolean | null } | null;
}

export async function readUsage(): Promise<{ ok: boolean; text: string }> {
  let token: string;
  try {
    token = await readToken();
  } catch (e) {
    return { ok: false, text: `Could not read the Claude login token: ${(e as Error).message}` };
  }
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, text: `Usage request failed: ${(e as Error).message}` };
  }
  const body = await res.text();
  if (res.status === 401) return { ok: false, text: 'Usage request returned 401: the login token has expired. Claude Code refreshes it on its next request; try again shortly.' };
  if (!res.ok) return { ok: false, text: `Usage request returned ${res.status}: ${body.slice(0, 500)}` };
  return { ok: true, text: formatUsage(JSON.parse(body) as UsageResponse, new Date()) };
}

async function readToken(): Promise<string> {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');
  const creds = JSON.parse(await fs.readFile(file, 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) throw new Error(`no claudeAiOauth.accessToken in ${file}`);
  return token;
}

export function formatUsage(u: UsageResponse, now: Date, timeZone?: string): string {
  const lines: string[] = [];
  if (u.limits?.length) {
    for (const l of u.limits) lines.push(limitLine(limitLabel(l), l.percent, l.severity, l.resets_at, now, timeZone));
  } else {
    if (u.five_hour?.utilization != null) lines.push(limitLine('Session (5h)', u.five_hour.utilization, null, u.five_hour.resets_at, now, timeZone));
    if (u.seven_day?.utilization != null) lines.push(limitLine('Weekly (all models)', u.seven_day.utilization, null, u.seven_day.resets_at, now, timeZone));
  }
  const s = u.spend;
  if (s?.enabled && s.used && s.limit) lines.push(`Extra usage: ${money(s.used)} of ${money(s.limit)} ${s.limit.currency} (${s.percent ?? 0}%)`);
  return lines.length ? lines.join('\n') : 'No usage limits reported for this account.';
}

function limitLabel(l: Limit): string {
  const model = l.scope?.model?.display_name;
  switch (l.kind) {
    case 'session':
      return 'Session (5h)';
    case 'weekly_all':
      return 'Weekly (all models)';
    case 'weekly_scoped':
      return `Weekly (${model ?? l.scope?.surface ?? 'scoped'})`;
    default:
      return model ? `${l.kind} (${model})` : l.kind;
  }
}

function limitLine(label: string, percent: number, severity: string | null | undefined, resetsAt: string | null | undefined, now: Date, timeZone?: string): string {
  let line = `${label}: ${Math.round(percent)}%`;
  if (severity && severity !== 'normal') line += ` [${severity}]`;
  if (resetsAt) {
    const at = new Date(resetsAt);
    const when = at.toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    line += `, resets ${when} (in ${duration(at.getTime() - now.getTime())})`;
  }
  return line;
}

function duration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function money(v: Money): string {
  return (v.amount_minor / 10 ** v.exponent).toFixed(v.exponent);
}
