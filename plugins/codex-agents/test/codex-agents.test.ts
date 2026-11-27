import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { CodexAgents } from '../src/codex-agents.js';
import type { CodexEvents } from '../src/codex-app-server.js';

function setup() {
  let events: CodexEvents;
  let nextThread = 0;
  let nextTurn = 0;
  const turns = new Map<string, string>();
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
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
  const relayWait = agents.wait(worker.agent_id, 0, 30_000, { signal: relay.signal, interruptOnCancel: true });
  relay.abort();
  expect(await relayWait).toMatchObject({ status: 'stopping' });
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: worker.agent_id, turnId: expect.any(String) });
});
