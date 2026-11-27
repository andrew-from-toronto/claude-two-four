import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { CodexAgents } from './codex-agents.js';

const agentId = z.string().min(1).describe('ID returned by codex_spawn');
const nonempty = z.string().refine((value) => value.trim().length > 0, 'Must contain text');

async function response(action: () => unknown) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

export function registerCodexTools(server: McpServer, agents: CodexAgents): void {
  server.registerTool('codex_spawn', {
    description: 'Delegate a task to a background Codex subagent. Returns its ID as soon as the first turn starts. Include the task, relevant context, and the expected result. Use codex_send to steer it and codex_wait to read replies while it works.',
    inputSchema: z.object({
      prompt: nonempty.describe('Task and context to send to Codex'),
      name: z.string().min(1).optional().describe('Display label for this subagent'),
      cwd: z.string().min(1).optional().describe('Working directory, absolute or relative to the Claude project. Defaults to the project directory.'),
      model: z.string().min(1).optional().describe('Codex model override. Defaults to the configured Codex model.'),
      sandbox: z.enum(['read-only', 'workspace-write']).optional().describe('Defaults to read-only. Choose workspace-write for tasks that need file edits.'),
    }),
  }, (spec) => response(() => agents.spawn(spec)));

  server.registerTool('codex_send', {
    description: 'Send a message to a Codex subagent. Steers a running turn or starts a follow-up in the same conversation after it finishes. Use codex_wait with the last next_cursor to read the reply.',
    inputSchema: z.object({ agent_id: agentId, message: nonempty }),
  }, ({ agent_id, message }) => response(() => agents.send(agent_id, message)));

  server.registerTool('codex_wait', {
    description: 'Read Codex commentary and replies. Returns when there are unread messages, the turn finishes, or the wait expires. Reuse next_cursor for subsequent reads, including follow-ups. If has_more is true, read the next page before considering the result complete.',
    inputSchema: z.object({
      agent_id: agentId,
      cursor: z.number().int().nonnegative().optional().describe('Use 0 on the first read, then the previous next_cursor'),
      timeout_seconds: z.number().int().min(0).max(60).optional().describe('Default 25 seconds. Use 0 to check immediately.'),
      interrupt_on_cancel: z.boolean().optional().describe('Interrupt the current Codex turn if Claude Code cancels this wait. Defaults to false.'),
    }),
  }, ({ agent_id, cursor = 0, timeout_seconds = 25, interrupt_on_cancel }, ctx) => response(
    () => agents.wait(agent_id, cursor, timeout_seconds * 1000, { signal: ctx.mcpReq.signal, interruptOnCancel: interrupt_on_cancel }),
  ));

  server.registerTool('codex_list', {
    description: 'List the Codex subagents started in this Claude session and their current turn status.',
    inputSchema: z.object({}),
  }, () => response(() => agents.list()));

  server.registerTool('codex_stop', {
    description: 'Interrupt a running Codex subagent turn. Read its status with codex_wait. A stopped subagent can receive a follow-up with codex_send after interruption completes.',
    inputSchema: z.object({ agent_id: agentId }),
  }, ({ agent_id }) => response(() => agents.stop(agent_id)));
}
