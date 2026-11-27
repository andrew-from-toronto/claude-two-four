import { stripVTControlCharacters } from 'node:util';
import * as z from 'zod/v4';

const eventScope = z.object({ threadId: z.string(), turnId: z.string() });
const delta = eventScope.extend({ itemId: z.string(), delta: z.string() });
const item = eventScope.extend({ item: z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('agentMessage'), text: z.string(), phase: z.string().nullish() }),
  z.object({ id: z.string(), type: z.literal('commandExecution'), command: z.string(), status: z.string(), exitCode: z.number().nullish(), aggregatedOutput: z.string().nullish() }),
  z.object({ id: z.string(), type: z.literal('fileChange'), status: z.string(), changes: z.array(z.object({ path: z.string() })) }),
]) });

export function streamEvent(method: string, params: unknown) {
  if (method === 'item/started' || method === 'item/completed') return item.safeParse(params).data;
  if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
    const event = delta.safeParse(params).data;
    if (event) return { ...event, deltaType: method === 'item/agentMessage/delta' ? 'agentMessage' as const : 'commandExecution' as const };
  }
}

export type StreamEvent = NonNullable<ReturnType<typeof streamEvent>>;
type Row = { kind: 'agentMessage' | 'commandExecution' | 'fileChange'; title?: string; text: string; status?: string };

const clean = (value: string) => stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
const tail = (text: string, limit: number) => text.length > limit ? `…${text.slice(1 - limit)}` : text;

export class CodexStream {
  private readonly rows = new Map<string, Row>();
  private revision = 0;

  update(event: StreamEvent): void {
    if ('deltaType' in event) {
      const previous = this.rows.get(event.itemId);
      this.set(event.itemId, {
        ...previous, kind: event.deltaType,
        text: tail((previous?.text ?? '') + clean(event.delta), event.deltaType === 'agentMessage' ? 12_000 : 1_500),
      });
      return;
    }
    const entry = event.item;
    if (entry.type === 'agentMessage') {
      if (entry.text) this.set(entry.id, { kind: entry.type, text: tail(clean(entry.text), 12_000) });
    } else if (entry.type === 'commandExecution') {
      this.set(entry.id, {
        kind: entry.type, title: tail(clean(entry.command), 250),
        status: entry.exitCode == null ? entry.status : `exit ${entry.exitCode}`,
        text: tail(clean(entry.aggregatedOutput ?? this.rows.get(entry.id)?.text ?? ''), 1_500),
      });
    } else {
      this.set(entry.id, { kind: entry.type, status: entry.status, text: tail(clean(entry.changes.map(({ path }) => path).join('\n')), 1_500) });
    }
  }

  snapshot() {
    const rows = Array.from(this.rows.values());
    let length = 0;
    let first = rows.length;
    while (first > 0 && length < 14_000) {
      const row = rows[--first]!;
      length += row.text.length + (row.title?.length ?? 0);
    }
    return { revision: this.revision, rows: rows.slice(first) };
  }

  private set(id: string, row: Row): void {
    this.rows.set(id, row);
    if (this.rows.size > 30) this.rows.delete(this.rows.keys().next().value!);
    this.revision++;
  }
}
