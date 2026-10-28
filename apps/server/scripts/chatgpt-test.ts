// Debug: the models the connected ChatGPT plan offers, and one tiny test prompt.
//   npx tsx scripts/chatgpt-test.ts [model]
import { readFile } from 'node:fs/promises';
import { chatGptAccessToken } from '../src/models/connections.js';

const token = await chatGptAccessToken();
const state = JSON.parse(await readFile(new URL('../data/connections.json', import.meta.url), 'utf8'));
const models: string[] = state.connections.chatgpt?.models ?? [];
console.log('models:', models.join(', '));
const model = process.argv[2] ?? models[0];

// Plan usage requires store: false and stream: true.
const res = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with the single word: ok' }] }], store: false, stream: true }),
});
console.log('status:', res.status);
const text = await res.text();
const done = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(l => l && l !== '[DONE]').map(l => JSON.parse(l));
const final = done.find(e => e.type === 'response.completed' || e.type === 'response.failed');
if (!final) console.log(text.slice(0, 400));
else if (final.type === 'response.failed') console.log('failed:', JSON.stringify(final.response?.error));
else console.log('reply:', JSON.stringify(final.response.output?.flatMap((o: { content?: { text?: string }[] }) => o.content ?? []).map((c: { text?: string }) => c.text).join('')));
