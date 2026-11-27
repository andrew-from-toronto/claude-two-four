export function register(on) {
  const workers = new Map();

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({ name: 'codex-usage', description: 'Show Codex allowance, reset times and worker token totals', immediate: true });
    } catch {
      // A reloaded mod can already own the command.
    }
    return next(event);
  });

  on('session.end', ($, event, next) => {
    workers.clear();
    return next(event);
  });

  on('command.run', { command: 'codex-usage' }, async ($) => {
    try {
      const connection = await $.mcp.connect('codex-agents');
      if (!connection.isConnected) return { text: connection.message || 'Codex Agents MCP server is unavailable.' };
      const result = await $.mcp.call(connection.server, 'codex_usage', {});
      return { text: result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') };
    } catch (error) {
      return { text: `Could not read Codex usage: ${error.message}` };
    }
  });

  on('tool.run', { tool: 'mcp__plugin_codex-agents_codex-agents__codex_spawn' }, async ($, event, next) => {
    const result = await next(event);
    if (event.agentId && result.text && !result.isError) {
      const relay = (await $.agent.list()).some((agent) => agent.id === event.agentId && agent.type === 'codex-agents:codex');
      if (relay) {
        try {
          const worker = JSON.parse(result.text).agent_id;
          if (typeof worker === 'string') {
            workers.set(event.agentId, { id: worker, submission: 0 });
            $.ui.invalidate('ui.render');
          }
        } catch {
          // The relay can keep its worker ID even when another hook changes the result format.
        }
      }
    }
    return result;
  }).catch(($, event, next) => next(event));

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    const worker = workers.get(event.props.view?.agentId);
    if (event.surface !== 'terminal' || event.props.hasSurvey || !worker) return next(event);
    const { Input } = await $.ui.resolve(event);
    return Input({
      key: `codex-steer-${worker.submission}`,
      label: 'Steer Codex',
      placeholder: 'Send a message to the running turn',
      submitLabel: 'send',
      autoFocus: true,
      async onSubmit(value) {
        if (!value.trim()) return;
        try {
          const connection = await $.mcp.connect('codex-agents');
          if (!connection.isConnected) throw new Error(connection.message || 'Codex Agents MCP server is unavailable.');
          const result = await $.mcp.call(connection.server, 'codex_send', { agent_id: worker.id, message: value, active_only: true });
          const text = result.content.find((block) => block.type === 'text')?.text;
          if (result.isError || !text) throw new Error(text || 'Codex did not acknowledge the message.');
          if (JSON.parse(text).delivery === 'steered') {
            worker.submission++;
            $.ui.invalidate('ui.render');
            $.ui.toast('Sent to Codex');
          } else $.ui.toast('Codex finished this turn. Use the transcript prompt to follow up.');
        } catch (error) {
          $.ui.toast(`Could not steer Codex: ${error.message}`);
        }
      },
    });
  });
}
