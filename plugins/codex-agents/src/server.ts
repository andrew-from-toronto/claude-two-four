import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CodexAgents } from './codex-agents.js';
import { registerCodexTools } from './codex-tools.js';

const version = '0.4.0';
const baseDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const codex = new CodexAgents(baseDir, version);

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'codex-agents', version });
  registerCodexTools(server, codex);
  return server;
});

process.stdin.once('end', () => codex.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    codex.close();
    void handle.close();
  });
}
