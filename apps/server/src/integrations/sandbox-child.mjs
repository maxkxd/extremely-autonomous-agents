// The process a code plugin runs in (sandbox.ts starts it). Node's permission
// model already stops it touching files outside what the plugin declared, and
// starting programs unless declared. Node doesn't limit the network, so here:
// no fetch or sockets of its own - kit.fetch asks the main server, which
// fetches through the safe fetcher (public addresses only).
import { registerHooks } from 'node:module';

const NETWORK = /^(node:)?(http|https|http2|net|tls|dgram|dns|dns\/promises|inspector|worker_threads|cluster)$|^undici/;
registerHooks({
  resolve(specifier, context, next) {
    if (NETWORK.test(specifier)) throw new Error(`Plugins can't use "${specifier}": reach the network with kit.fetch.`);
    return next(specifier, context);
  },
});
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  Object.defineProperty(globalThis, name, {
    get() {
      throw new Error(`Plugins can't use ${name}: reach the network with kit.fetch.`);
    },
  });
}

let seq = 0;
const waiting = new Map();
const kit = {
  fetch(url, init = {}) {
    const id = ++seq;
    process.send({ fetch: { id, url: String(url), init } });
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  },
};

process.on('message', async msg => {
  if (msg.fetched) {
    const w = waiting.get(msg.fetched.id);
    waiting.delete(msg.fetched.id);
    if (!w) return;
    if (msg.fetched.error) return w.reject(new Error(msg.fetched.error));
    const { status, headers, body } = msg.fetched;
    w.resolve(new Response(status === 204 || status === 304 ? null : Buffer.from(body, 'base64'), { status, headers }));
    return;
  }
  try {
    const mod = (await import(msg.file)).default;
    if (!mod || !Array.isArray(mod.tools)) throw new Error('The plugin must export default { tools: [...] }.');
    if (msg.op === 'describe') {
      process.send({ done: { tools: mod.tools.map(t => ({ id: t.id, tier: t.tier, description: t.description, input: t.input, run: typeof t.run })) } });
    } else {
      const tool = mod.tools.find(t => t.id === msg.tool);
      if (!tool) throw new Error(`No tool "${msg.tool}".`);
      const out = await tool.run(msg.args ?? {}, msg.token, kit);
      process.send({ done: { result: typeof out === 'string' ? out : JSON.stringify(out) } });
    }
  } catch (e) {
    process.send({ done: { error: String(e?.message ?? e).slice(0, 1000) } });
  }
});
