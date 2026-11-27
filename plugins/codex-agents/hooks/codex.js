async function followCodex($, worker, feed) {
  try {
    const connection = await $.mcp.connect('codex-agents');
    if (!connection.isConnected) return;
    do {
      const result = await $.mcp.call(connection.server, 'codex_stream', { agent_id: worker.id });
      if (result.isError) return;
      const text = result.content.find((block) => block.type === 'text')?.text;
      if (!text) return;
      const stream = JSON.parse(text);
      if (feed.turn !== undefined && stream.turn !== feed.turn) return;
      if (feed.revision !== stream.revision || feed.status !== stream.status) {
        Object.assign(feed, stream);
        $.ui.invalidate('ui.render');
      }
      if (!feed.running || (stream.status !== 'running' && stream.status !== 'stopping')) return;
      await $.clock.sleep(350);
    } while (worker.feed === feed);
  } catch {
    // The relay's wait still delivers the final result if the live view is unavailable.
  }
}

function streamText(feed) {
  return feed.rows.map((row) => {
    if (row.kind === 'agentMessage') return row.text;
    const title = row.kind === 'commandExecution' ? `$ ${row.title ?? 'Command'}` : 'Files changed';
    return `${title} · ${row.status ?? 'running'}${row.text ? `\n${row.text}` : ''}`;
  }).join('\n\n');
}

export function register(on) {
  const workers = new Map();
  const feeds = new Map();

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({ name: 'codex-usage', description: 'Show Codex allowance, reset times and worker token totals', immediate: true });
    } catch {
      // A reloaded mod can already own the command.
    }
    return next(event);
  });

  on('session.end', ($, event, next) => {
    for (const worker of workers.values()) if (worker.feed) worker.feed.running = false;
    workers.clear();
    feeds.clear();
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

  on('tool.run', { tool: 'mcp__plugin_codex-agents_codex-agents__codex_wait' }, async ($, event, next) => {
    const worker = workers.get(event.agentId);
    if (!worker || event.agent_id !== worker.id || !event.until_complete || event.timeout_seconds === 0) return next(event);
    const feed = { running: true, rows: [] };
    worker.feed = feed;
    feeds.set(event.tool_use_id, feed);
    const result = next(event);
    void followCodex($, worker, feed);
    try {
      return await result;
    } finally {
      feed.running = false;
      $.ui.invalidate('ui.render');
    }
  }).catch(($, event, next) => next(event));

  on('ui.render', { component: 'ToolUse' }, async ($, event, next) => {
    const feed = feeds.get(event.requestId);
    if (event.surface !== 'terminal' || !feed?.rows.length) return next(event);
    const { Text } = await $.ui.resolve(event);
    feed.inline = true;
    return Text({ children: [streamText(feed)] });
  });

  on('ui.render', { component: 'ToolGroup' }, async ($, event, next) => {
    if (event.surface !== 'terminal' || event.props.isExpanded || !event.props.isCallsOnly) return next(event);
    const group = event.props.calls.map((call) => feeds.get(call.tool_use_id)).filter((feed) => feed?.rows.length);
    if (!group.length) return next(event);
    if (event.props.calls.some((call) => !call.tool.startsWith('mcp__plugin_codex-agents_codex-agents__'))) return next(event);
    const { Text } = await $.ui.resolve(event);
    for (const feed of group) feed.inline = true;
    return Text({ children: [group.map(streamText).join('\n\n')] });
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    const worker = workers.get(event.props.view?.agentId);
    if (event.surface !== 'terminal' || event.props.hasSurvey || !worker) return next(event);
    const { Box, Input, Text } = await $.ui.resolve(event);
    const input = Input({
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
    if (!worker.feed?.running || worker.feed.inline || !worker.feed.rows.length) return input;
    const preview = streamText(worker.feed).split('\n').filter(Boolean).slice(-2).join('\n').slice(-240);
    return Box({ flexDirection: 'column', children: [Text({ children: [preview] }), input] });
  });
}
