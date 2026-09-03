#!/usr/bin/env node
// Fake CodeBuddy CLI speaking the official headless stream-json protocol.
// Echoes its argv inside the init event so tests can assert flag injection.
let input = '';
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fake-1', argv: process.argv.slice(2), model: 'fake-model', version: '9.9.9' }) + '\n');
process.stdin.on('data', (d) => {
  input += d;
  let idx;
  while ((idx = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, idx); input = input.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'user') {
      const text = (msg.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la /very/long/path/that/should/get/truncated/because/it/is/way/too/long/for/one/single/line/indeed' } }] }, session_id: 'sess-fake-1' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'task_progress', task_id: 't1', description: 'reading files' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + text }] }, session_id: 'sess-fake-1' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'echo:' + text, session_id: 'sess-fake-1', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n');
    }
  }
});
