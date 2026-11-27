import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { CodexAgents } from '../src/codex-agents.js';
import type { CodexEvents } from '../src/codex-app-server.js';

function setup() {
  let events: CodexEvents;
  let nextThread = 0;
  let nextTurn = 0;
  const turns = new Map<string, string>();
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'thread/start') return { thread: { id: `thread-${++nextThread}` }, model: 'demo' };
    if (method === 'turn/start') {
      const id = `turn-${++nextTurn}`;
      turns.set(params.threadId as string, id);
      const turn = { id, status: 'inProgress' };
      events.notification('turn/started', { threadId: params.threadId, turn });
      return { turn };
    }
    return {};
  });
  const agents = new CodexAgents(os.tmpdir(), 'test', (callbacks) => {
    events = callbacks;
    return { request, close: (error = new Error('disconnected')) => events.closed(error) };
  });
  return {
    agents, request,
    post(threadId: string, text: string, phase = 'commentary', itemId = text) {
      events.notification('item/completed', { threadId, turnId: turns.get(threadId), item: { type: 'agentMessage', id: itemId, text, phase } });
    },
    complete(threadId: string, status = 'completed') {
      events.notification('turn/completed', { threadId, turn: { id: turns.get(threadId), status } });
    },
    usage(threadId: string, totalTokens: number) {
      events.notification('thread/tokenUsage/updated', { threadId, tokenUsage: { total: {
        totalTokens, inputTokens: totalTokens - 100, cachedInputTokens: 20, outputTokens: 100,
      } } });
    },
    item(threadId: string, method: string, data: object) {
      events.notification(`item/${method}`, { threadId, turnId: turns.get(threadId), ...data });
    },
  };
}

it('routes commentary and final replies by worker and preserves each conversation across follow-ups', async () => {
  const { agents, request, post, complete } = setup();
  const [review, edit] = await Promise.all([
    agents.spawn({ name: 'review', prompt: 'Review the project' }),
    agents.spawn({ name: 'edit', prompt: 'Edit the project', sandbox: 'workspace-write' }),
  ]);
  expect(review).toMatchObject({ status: 'running', sandbox: 'read-only', turn: 1 });
  expect(edit).toMatchObject({ status: 'running', sandbox: 'workspace-write' });
  expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ ephemeral: true, approvalPolicy: 'never' }));

  const updates = agents.wait(review.agent_id, 0, 30_000);
  post(edit.agent_id, 'Editing');
  post(review.agent_id, 'Reviewing');
  post(review.agent_id, 'Reviewing');
  expect(await updates).toMatchObject({ messages: [{ phase: 'commentary', text: 'Reviewing' }], next_cursor: 1 });
  expect(await agents.send(review.agent_id, 'Focus on errors')).toMatchObject({ delivery: 'steered' });
  expect(request).toHaveBeenCalledWith('turn/steer', {
    threadId: review.agent_id, expectedTurnId: expect.any(String), input: [{ type: 'text', text: 'Focus on errors' }],
  });
  post(review.agent_id, 'Found one issue', 'final_answer');
  complete(review.agent_id);
  expect(await agents.wait(review.agent_id, 1, 0)).toMatchObject({ status: 'completed', messages: [{ turn: 1, text: 'Found one issue' }], next_cursor: 2 });
  expect(await agents.send(review.agent_id, 'Explain the issue')).toMatchObject({ delivery: 'new_turn', turn: 2 });
  post(review.agent_id, 'Here is the explanation', 'final_answer');
  expect(await agents.wait(review.agent_id, 2, 0)).toMatchObject({ messages: [{ turn: 2, text: 'Here is the explanation' }] });
  expect(await agents.wait(edit.agent_id, 0, 0)).toMatchObject({ messages: [{ text: 'Editing' }] });
});

it('keeps the final message and terminal status when events arrive before the start response', async () => {
  const { agents, request, post, complete } = setup();
  const worker = await agents.spawn({ prompt: 'Review' });
  complete(worker.agent_id);
  const original = request.getMockImplementation()!;
  request.mockImplementationOnce(async (method, params) => {
    const result = await original(method, params);
    post(worker.agent_id, 'Immediate reply', 'final_answer');
    complete(worker.agent_id);
    return result;
  });
  expect(await agents.send(worker.agent_id, 'Follow up')).toMatchObject({ status: 'completed', turn: 2 });
  expect(await agents.wait(worker.agent_id, 0, 0)).toMatchObject({ messages: [{ turn: 2, text: 'Immediate reply' }] });
});

it('sends a follow-up if steering loses the race with turn completion', async () => {
  const { agents, request, complete } = setup();
  const worker = await agents.spawn({ prompt: 'Review' });
  request.mockImplementationOnce(async () => {
    complete(worker.agent_id);
    throw new Error('No active turn');
  });
  expect(await agents.send(worker.agent_id, 'Follow up')).toMatchObject({ delivery: 'new_turn', turn: 2, status: 'running' });
});

it('leaves a completed turn for the relay to resume when asked to steer only', async () => {
  const { agents, request, complete } = setup();
  const worker = await agents.spawn({ prompt: 'Review' });
  request.mockImplementationOnce(async () => {
    complete(worker.agent_id);
    throw new Error('No active turn');
  });
  expect(await agents.send(worker.agent_id, 'One more thing', true)).toMatchObject({ delivery: 'not_active', turn: 1 });
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('streams partial text and activity while a single final wait is pending', async () => {
  const { agents, post, complete, item } = setup();
  const worker = await agents.spawn({ prompt: 'Review' });
  const peer = await agents.spawn({ prompt: 'Other work' });
  const id = worker.agent_id;
  let resolved = false;
  const result = agents.wait(id, 0, undefined, { untilComplete: true }).then((output) => { resolved = true; return output; });
  item(id, 'agentMessage/delta', { itemId: 'message-1', delta: 'Looking' });
  item(id, 'agentMessage/delta', { itemId: 'message-1', delta: ' closely' });
  item(id, 'started', { item: { type: 'commandExecution', id: 'cmd', command: 'git status', status: 'inProgress' } });
  item(id, 'commandExecution/outputDelta', { itemId: 'cmd', delta: '\u001b[31mchanged\u001b[0m' });
  item(id, 'completed', { item: { type: 'commandExecution', id: 'cmd', command: 'git status', status: 'completed', exitCode: 0 } });
  item(id, 'completed', { item: { type: 'fileChange', id: 'file', status: 'completed', changes: [{ path: 'demo.ts' }] } });
  expect(agents.stream(id).rows).toEqual([
    { kind: 'agentMessage', text: 'Looking closely' },
    { kind: 'commandExecution', title: 'git status', text: 'changed', status: 'exit 0' },
    { kind: 'fileChange', text: 'demo.ts', status: 'completed' },
  ]);
  expect(agents.stream(peer.agent_id).rows).toEqual([]);
  post(id, 'Looked closely', 'commentary', 'message-1');
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(agents.stream(id).rows[0]?.text).toBe('Looked closely');
  complete(id);
  expect(await result).toMatchObject({ status: 'completed', messages: [{ text: 'Looked closely' }], next_cursor: 1 });
  await agents.send(id, 'Follow up');
  expect(agents.stream(id)).toMatchObject({ turn: 2, rows: [] });
});

it('combines current account allowance with the latest per-worker token totals', async () => {
  const { agents, request, usage } = setup();
  const worker = await agents.spawn({ prompt: 'Review', name: 'Review' });
  const other = await agents.spawn({ prompt: 'Test', name: 'Test' });
  usage(worker.agent_id, 500);
  usage(worker.agent_id, 1_000);
  request.mockResolvedValueOnce({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1795806000 } },
  });
  const report = await agents.usage();
  expect(request).toHaveBeenLastCalledWith('account/rateLimits/read', {});
  expect(report).toContain('5h · 75% remaining · resets');
  expect(report).toContain(`Review (${worker.agent_id}) · 1,000 total · 900 input (20 cached) · 100 output`);
  expect(report).toContain(`Test (${other.agent_id}) · tokens pending`);
  request.mockRejectedValueOnce(new Error('Sign-in required'));
  expect(await agents.usage()).toContain('Unavailable (Sign-in required)');
  expect(agents.list().map(({ status }) => status)).toEqual(['running', 'running']);
});

it('wakes readers on interruption and disconnect, and keeps interrupted threads resumable', async () => {
  const { agents, request, complete } = setup();
  const worker = await agents.spawn({ prompt: 'Work' });
  const waiting = agents.wait(worker.agent_id, 0, 30_000);
  expect(await agents.stop(worker.agent_id)).toMatchObject({ status: 'stopping' });
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: worker.agent_id, turnId: expect.any(String) });
  complete(worker.agent_id, 'interrupted');
  expect(await waiting).toMatchObject({ status: 'interrupted', messages: [] });
  await agents.send(worker.agent_id, 'Resume');
  const resumed = agents.wait(worker.agent_id, 0, 30_000);
  agents.close();
  expect(await resumed).toMatchObject({ status: 'failed', error: 'disconnected' });
});

it('interrupts on cancellation only for a wait that opts in', async () => {
  const { agents, request } = setup();
  const worker = await agents.spawn({ prompt: 'Work' });
  const controller = new AbortController();
  const wait = agents.wait(worker.agent_id, 0, 30_000, { signal: controller.signal });
  controller.abort();
  expect(await wait).toMatchObject({ status: 'running' });
  expect(request).not.toHaveBeenCalledWith('turn/interrupt', expect.anything());

  const relay = new AbortController();
  const relayWait = agents.wait(worker.agent_id, 0, undefined, { signal: relay.signal, interruptOnCancel: true, untilComplete: true });
  relay.abort();
  expect(await relayWait).toMatchObject({ status: 'stopping' });
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: worker.agent_id, turnId: expect.any(String) });
});
