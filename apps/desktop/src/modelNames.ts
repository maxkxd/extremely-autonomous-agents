// A model's name as people say it: claude-opus-5-5 -> Claude Opus 5.5,
// gpt-4o-mini -> GPT-4o mini, gemini-2.5-pro -> Gemini 2.5 Pro. Only for the
// families it knows; anything else (a local model, an odd id) stays its id.

const FAMILIES: Record<string, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  gemma: 'Gemma',
  grok: 'Grok',
  mistral: 'Mistral',
  codestral: 'Codestral',
  magistral: 'Magistral',
  ministral: 'Ministral',
  deepseek: 'DeepSeek',
  llama: 'Llama',
  qwen: 'Qwen',
  kimi: 'Kimi',
};
const WORDS: Record<string, string> = { r1: 'R1', vl: 'VL', it: 'IT' };

export function modelName(id: string): string {
  // OpenRouter's "anthropic/claude-sonnet-4.5", and its ":free" ones.
  const [path, tag] = id.split(':');
  const bare = path.split('/').pop() ?? path;
  const free = tag === 'free' ? ' (free)' : '';
  const parts = bare
    .toLowerCase()
    .split('-')
    .filter(p => p && p !== 'latest' && !/^\d{6,8}$/.test(p) && p !== 'preview');
  if (!parts.length) return id;
  const [family, ...rest] = parts;
  // GPT: the first part stays joined (GPT-4o, GPT-5.1), the rest are words.
  if (family === 'gpt') return rest.length ? `GPT-${rest[0]}${rest.slice(1).map(w => ` ${w}`).join('')}${free}` : id;
  const name = FAMILIES[family];
  if (!name) return id;
  // Versions written as separate numbers (5-5, 3-5) are one version: 5.5, 3.5.
  const out: string[] = [name];
  for (const p of rest) {
    const prev = out[out.length - 1];
    if (/^\d{1,2}$/.test(p) && /^\d+(\.\d+)*$/.test(prev)) out[out.length - 1] = `${prev}.${p}`;
    else if (/^\d+b$/.test(p)) out.push(p.toUpperCase()); // 70b -> 70B
    else if (/^\d/.test(p)) out.push(p);
    else out.push(WORDS[p] ?? p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ') + free;
}
