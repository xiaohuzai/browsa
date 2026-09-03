#!/usr/bin/env node
// Conformance fake engine: JSON-RPC-stdio family (codex app-server shape).
// Speaks the documented surface minimally: initialize -> result,
// thread/start -> thread id, turn/start -> item/completed + turn/completed.
// Echoes its argv inside the thread object so tests can assert flag/argv
// injection end-to-end.

let input = '';
process.stdout.write(JSON.stringify({
  method: 'remoteControl/status/changed',
  params: { status: 'disabled' },
}) + '\n');

process.stdin.on('data', (d) => {
  input += d;
  let idx;
  while ((idx = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, idx);
    input = input.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.method === 'initialize' && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { userAgent: `fake-codex/${process.version}`, codexHome: '/fake', argv: process.argv.slice(2) },
      }) + '\n');
    } else if (msg.method === 'thread/start' && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { thread: { id: 'th-fake-1', argv: process.argv.slice(2) } },
      }) + '\n');
    } else if (msg.method === 'turn/start' && msg.id !== undefined) {
      const text = (msg.params?.input || []).filter((i) => i.type === 'text').map((i) => i.text).join('');
      const sandbox = JSON.stringify(msg.params?.sandboxPolicy ?? null);
      process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'tn-1', status: 'inProgress' } } }) + '\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          method: 'item/completed',
          params: { item: { type: 'agentMessage', id: 'm1', text: `echo:${text}|sandbox:${sandbox}` } },
        }) + '\n');
        process.stdout.write(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'th-fake-1', turn: { id: 'tn-1', status: 'completed', error: null } },
        }) + '\n');
      }, 10);
    }
  }
});
