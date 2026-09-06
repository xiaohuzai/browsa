// E2E probe: REAL `opencode serve` + the real lib/opencode-client.js —
// validates the wire contract this integration was built against. Run:
//   1. node dev-preview/opencode-mock.mjs                (OpenAI-compatible mock provider)
//   2. ~/.config/opencode/opencode.json → provider "mock" with baseURL
//      http://127.0.0.1:8787/v1 + permission { bash:'ask', edit:'ask' }
//   3. opencode serve --port 4096
//   4. node dev-preview/opencode-e2e.mjs
// Streaming turn + tool-call turn with a live permission round trip.
import { createOpencodeSession, opencodeStream, respondOpencodePermission, pingOpencode } from '../lib/opencode-client.js';

const base = 'http://127.0.0.1:4096';

console.log('ping:', JSON.stringify(await pingOpencode({ baseUrl: base })));

const ses = await createOpencodeSession({ baseUrl: base, title: 'browsa e2e' });
console.log('session:', ses);

// Turn 1: plain streaming text
const t1 = await opencodeStream({
  baseUrl: base, sessionId: ses, text: '你好',
  onDelta: (d) => process.stdout.write(d),
  onToolProgress: (t) => console.log('\n[tool]', t),
  signal: new AbortController().signal,
});
console.log('\n--- turn1 full:', JSON.stringify(t1.full), 'usage:', JSON.stringify(t1.usage), 'finish:', t1.finishReason);

// Turn 2: tool call → permission.v2.asked → reply 'once' → continuation.
// The reply happens from OUTSIDE the stream (like browsa's approval card):
// run the stream in parallel and answer when the approval arrives.
const ac = new AbortController();
const t2Promise = opencodeStream({
  baseUrl: base, sessionId: ses, text: 'please run the tool',
  onDelta: (d) => process.stdout.write(d),
  onToolProgress: (t) => console.log('\n[tool]', t),
  onApproval: async (d) => {
    console.log('\n[approval asked]', JSON.stringify(d));
    const r = await respondOpencodePermission({ baseUrl: base, sessionId: ses, requestId: d.requestId, reply: 'once' });
    console.log('[approval replied]', JSON.stringify(r));
  },
  signal: ac.signal,
});
const t2 = await t2Promise;
console.log('\n--- turn2 full:', JSON.stringify(t2.full), 'finish:', t2.finishReason);

console.log('\nE2E PASS');
