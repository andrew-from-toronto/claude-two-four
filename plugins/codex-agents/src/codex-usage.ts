import * as z from 'zod/v4';

const limitWindow = z.object({ usedPercent: z.number(), windowDurationMins: z.number().nullish(), resetsAt: z.number().nullish() });
const limit = z.object({ limitId: z.string().nullish(), limitName: z.string().nullish(), primary: limitWindow.nullish(), secondary: limitWindow.nullish() });
export const accountLimits = z.object({ rateLimits: limit, rateLimitsByLimitId: z.record(z.string(), limit).nullish() });
export const threadUsage = z.object({
  threadId: z.string(),
  tokenUsage: z.object({ total: z.object({ totalTokens: z.number(), inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }) }),
});

export type WorkerUsage = { id: string; name?: string; usage?: z.infer<typeof threadUsage>['tokenUsage']['total'] };
const eastern = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const number = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 1 });

function formatWindow(window: z.infer<typeof limitWindow>): string {
  const minutes = window.windowDurationMins;
  const duration = minutes == null ? 'Usage window' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  const remaining = number.format(Math.max(0, 100 - window.usedPercent));
  return `${duration} · ${remaining}% remaining${window.resetsAt == null ? '' : ` · resets ${eastern.format(window.resetsAt * 1000)}`}`;
}

export function formatUsage(account: z.infer<typeof accountLimits> | string, workers: WorkerUsage[]): string {
  const lines = ['Codex allowance'];
  if (typeof account === 'string') lines.push(`Unavailable (${account})`);
  else {
    const buckets = Object.entries(account.rateLimitsByLimitId ?? {});
    if (!buckets.length) buckets.push([account.rateLimits.limitId ?? 'Codex', account.rateLimits]);
    for (const [id, bucket] of buckets) {
      const windows = [bucket.primary, bucket.secondary].filter((window) => window != null);
      const label = bucket.limitName ?? (id === 'codex' ? 'Codex' : id);
      for (const window of windows) lines.push(`${label} · ${formatWindow(window)}`);
    }
    if (lines.length === 1) lines.push('Codex did not report allowance windows for this sign-in.');
  }
  lines.push('', 'Codex worker tokens in this Claude session');
  if (!workers.length) lines.push('No workers started.');
  for (const { id, name, usage } of workers) {
    const label = name ? `${name} (${id})` : id;
    lines.push(usage
      ? `${label} · ${number.format(usage.totalTokens)} total · ${number.format(usage.inputTokens)} input (${number.format(usage.cachedInputTokens)} cached) · ${number.format(usage.outputTokens)} output`
      : `${label} · tokens pending`);
  }
  return lines.join('\n');
}
