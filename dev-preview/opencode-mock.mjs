// OpenAI-compatible mock: plain text / 'slow' (4s) / 'tool' (bash tool call) modes.
import http from 'node:http';

http.createServer((req, res) => {
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let userText = '';
      let lastRole = '';
      try {
        const j = JSON.parse(body);
        const msgs = j.messages || [];
        const last = msgs[msgs.length - 1] || {};
        lastRole = last.role || '';
        const c = last.content;
        userText = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join(' ') : '';
      } catch {}
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const id = 'chatcmpl-' + Date.now();
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const delta = (d, finish = null) => send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] });

      if (lastRole === 'user' && userText.includes('tool')) {
        // leg 1: ask for a bash tool call
        const tc = { id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi-from-tool', description: 'say hi' }) } };
        delta({ role: 'assistant', tool_calls: [{ index: 0, ...tc }] });
        delta({}, 'tool_calls');
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }
      if (lastRole === 'tool') {
        // leg 2: after tool result, final text
        const parts = ['工具', '跑完了', '，输出是 hi-from-tool', '。'];
        let i = 0;
        const t = setInterval(() => {
          if (i < parts.length) { delta({ content: parts[i++] }); }
          else { delta({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); clearInterval(t); }
        }, 50);
        return;
      }
      if (lastRole === 'user' && userText.includes('slow')) {
        const parts = Array.from({ length: 12 }, (_, i) => `慢块${i} `);
        let i = 0;
        const t = setInterval(() => {
          if (i < parts.length) { delta({ content: parts[i++] }); }
          else { delta({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); clearInterval(t); }
        }, 300);
        return;
      }
      const parts = ['你好', '，这里是 ', 'opencode', ' 联调', '回复', '。'];
      let i = 0;
      const t = setInterval(() => {
        if (i < parts.length) { delta({ content: parts[i++] }); }
        else { delta({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); clearInterval(t); }
      }, 60);
    });
    return;
  }
  res.writeHead(404).end();
}).listen(8787, '127.0.0.1', () => console.log('mock up on 8787'));
