import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { CodexAppServer, type CodexConnection, type ConnectCodex } from './codex-app-server.js';

const threadResponse = z.object({ thread: z.object({ id: z.string() }), model: z.string() });
const turn = z.object({
  id: z.string(),
  status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
  error: z.object({ message: z.string() }).nullish(),
});
const turnResponse = z.object({ turn });
const turnEvent = turnResponse.extend({ threadId: z.string() });
const itemEvent = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string(), phase: z.string().nullish() }),
});

type Status = 'running' | 'stopping' | 'completed' | 'interrupted' | 'failed';
type Message = { turn: number; phase: string | null; text: string };
type AgentTurn = { number: number; id?: string; status: Status; error?: string; seenItems: Set<string> };
type Agent = {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write';
  connection: CodexConnection;
  connectionError?: string;
  turn: AgentTurn;
  messages: Message[];
  waiters: Set<() => void>;
};

export interface SpawnCodexSpec {
  prompt: string;
  name?: string;
  cwd?: string;
  model?: string;
  sandbox?: Agent['sandbox'];
}

const active = (turn: AgentTurn) => turn.status === 'running' || turn.status === 'stopping';
const input = (text: string) => [{ type: 'text', text }];
const newTurn = (number: number): AgentTurn => ({ number, status: 'running', seenItems: new Set() });

function describe(agent: Agent) {
  return {
    agent_id: agent.id,
    name: agent.name,
    cwd: agent.cwd,
    model: agent.model,
    sandbox: agent.sandbox,
    turn: agent.turn.number,
    status: agent.connectionError ? 'failed' : agent.turn.status,
    error: agent.connectionError ?? agent.turn.error,
  };
}

function wake(agent: Agent): void {
  for (const waiter of agent.waiters) waiter();
}

export class CodexAgents {
  private readonly agents = new Map<string, Agent>();
  private connection?: CodexConnection;
  private closed = false;

  constructor(
    private readonly baseDir: string,
    version: string,
    private readonly connect: ConnectCodex = (events) => new CodexAppServer(baseDir, version, events),
  ) {}

  async spawn(spec: SpawnCodexSpec) {
    const cwd = path.resolve(this.baseDir, spec.cwd ?? '.');
    if (!(await stat(cwd).then((entry) => entry.isDirectory(), () => false))) throw new Error(`cwd not found: ${cwd}`);
    const connection = this.getConnection();
    const sandbox = spec.sandbox ?? 'read-only';
    const { thread, model } = threadResponse.parse(await connection.request('thread/start', {
      cwd,
      model: spec.model,
      sandbox,
      approvalPolicy: 'never',
      ephemeral: true,
      developerInstructions: 'You are a Codex subagent reporting to a parent Claude agent. Treat user messages as messages from that parent. Send important mid-task updates as commentary, and use your final answer to report results or ask the parent for information needed to continue. The parent can send follow-up messages in this same thread.',
    }));
    const agent: Agent = {
      id: thread.id, name: spec.name, cwd, model, sandbox, connection,
      turn: newTurn(1), messages: [], waiters: new Set(),
    };
    this.agents.set(agent.id, agent);
    try {
      await this.startTurn(agent, spec.prompt, agent.turn);
      return describe(agent);
    } catch (error) {
      this.agents.delete(agent.id);
      void connection.request('thread/unsubscribe', { threadId: agent.id }).catch(() => {});
      throw error;
    }
  }

  async send(id: string, message: string) {
    const agent = this.getAgent(id);
    if (agent.connectionError) throw new Error(agent.connectionError);
    const current = agent.turn;
    if (current.status === 'stopping') throw new Error('Codex is stopping this turn. Wait for it to finish, then send the message again.');
    if (active(current)) {
      if (!current.id) throw new Error('Codex is starting a turn. Retry once it starts.');
      try {
        await agent.connection.request('turn/steer', { threadId: id, expectedTurnId: current.id, input: input(message) });
        return { ...describe(agent), delivery: 'steered' };
      } catch (error) {
        if (agent.connectionError || active(current) || agent.turn !== current) throw error;
      }
    }
    await this.startTurn(agent, message, newTurn(current.number + 1));
    return { ...describe(agent), delivery: 'new_turn' };
  }

  async stop(id: string) {
    const agent = this.getAgent(id);
    const current = agent.turn;
    if (agent.connectionError || current.status !== 'running') return describe(agent);
    if (!current.id) throw new Error('Codex is starting a turn. Retry once it starts.');
    current.status = 'stopping';
    try {
      await agent.connection.request('turn/interrupt', { threadId: id, turnId: current.id });
    } catch (error) {
      if (current.status === 'stopping') {
        current.status = 'running';
        throw error;
      }
    }
    return describe(agent);
  }

  list() {
    return Array.from(this.agents.values(), describe);
  }

  async wait(id: string, cursor: number, timeoutMs: number, signal?: AbortSignal) {
    const agent = this.getAgent(id);
    if (cursor > agent.messages.length) throw new Error('cursor is ahead of this agent’s messages');
    if (cursor === agent.messages.length && active(agent.turn) && !agent.connectionError && timeoutMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          agent.waiters.delete(finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        agent.waiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
    const messages = agent.messages.slice(cursor, cursor + 20);
    const next_cursor = cursor + messages.length;
    return { ...describe(agent), messages, next_cursor, has_more: next_cursor < agent.messages.length };
  }

  close(): void {
    this.closed = true;
    this.connection?.close();
  }

  private getAgent(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown Codex agent: ${id}`);
    return agent;
  }

  private getConnection(): CodexConnection {
    if (this.closed) throw new Error('Codex session closed');
    if (this.connection) return this.connection;
    const connection = this.connect({
      notification: (method, params) => this.onNotification(connection, method, params),
      closed: (error) => {
        if (this.connection === connection) this.connection = undefined;
        for (const agent of this.agents.values()) {
          if (agent.connection !== connection) continue;
          agent.connectionError = error.message;
          wake(agent);
        }
      },
    });
    this.connection = connection;
    return connection;
  }

  private async startTurn(agent: Agent, message: string, current: AgentTurn): Promise<void> {
    agent.turn = current;
    try {
      const result = turnResponse.parse(await agent.connection.request('turn/start', { threadId: agent.id, input: input(message) }));
      this.updateTurn(agent, current, result.turn);
    } catch (error) {
      current.status = 'failed';
      current.error = error instanceof Error ? error.message : String(error);
      wake(agent);
      throw error;
    }
  }

  private updateTurn(agent: Agent, current: AgentTurn, update: z.infer<typeof turn>): void {
    if (!active(current) || (current.id && current.id !== update.id)) return;
    current.id = update.id;
    if (update.status === 'inProgress') return;
    current.status = update.status;
    current.error = update.error?.message;
    wake(agent);
  }

  private onNotification(connection: CodexConnection, method: string, params: unknown): void {
    if (method === 'turn/started' || method === 'turn/completed') {
      const event = turnEvent.safeParse(params);
      if (!event.success) return;
      const agent = this.agents.get(event.data.threadId);
      if (agent?.connection === connection) this.updateTurn(agent, agent.turn, event.data.turn);
    }
    if (method === 'item/completed') {
      const event = itemEvent.safeParse(params);
      if (!event.success) return;
      const { threadId, turnId, item } = event.data;
      const agent = this.agents.get(threadId);
      if (agent?.connection !== connection || !active(agent.turn) || agent.turn.id !== turnId || agent.turn.seenItems.has(item.id)) return;
      agent.turn.seenItems.add(item.id);
      agent.messages.push({ turn: agent.turn.number, phase: item.phase ?? null, text: item.text });
      wake(agent);
    }
  }
}
