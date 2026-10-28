// Pre-builds every pack agent with the agent builder (docs/agent-creation.md)
// and saves the results to packs/<pack>.json, which are reviewed by hand and
// committed. Adding a pack then just composes these - no wait, no API cost.
//
// Each agent is written with the closest real agent from the WAR agency runner
// as a reference: those Charters are hard, real and tested in production, so
// the builder borrows their discipline (order of work, guardrails, failure
// handling, what a good run is) without their company-specific details.
//
//   AGENCY_REFERENCE=<path to AssetRegister/agency> npm run build-packs
//   ... npm run build-packs -- sales    only the named packs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PACKS } from '../../desktop/src/packs.js';
import { build, type Build } from '../src/builder.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const CONCURRENCY = 4;

const REF_DIR = process.env.AGENCY_REFERENCE;
if (!REF_DIR) throw new Error('Set AGENCY_REFERENCE to the WAR agency folder (AssetRegister/agency).');

// Pack agent -> the WAR agent doing the closest real job.
const REFERENCE: Record<string, string> = {
  'Lead Research': 'sales/lead-research',
  Outreach: 'sales/outreach',
  'Paid Ads': 'marketing/demand-gen',
  'Social Media': 'marketing/social',
  SEO: 'marketing/content-seo',
  'Bug Triage': 'support/bug-triage',
  'Infrastructure Monitor': 'operations/infrastructure-sre',
  'Support Desk': 'support/tier1-support',
  'Customer Success': 'onboarding/customer-success',
  Bookkeeper: 'finance/financial-controller',
  'Accounts Receivable': 'finance/revops-billing',
  'Market Research': 'executive/strategy-research',
  'Competitor Watch': 'marketing/competitor-watch',
  'Content Writer': 'marketing/content-seo',
  Newsletter: 'marketing/social',
  'Inbox Triage': 'executive/chief-of-staff',
  Scheduler: 'executive/chief-of-staff',
  'Code Reviewer': 'agent-ops/merge-agent',
  'Docs Writer': 'product/documentation',
  Sourcer: 'sales/lead-research',
  Screener: 'support/tier1-support',
};

async function reference(agentName: string): Promise<string> {
  const ref = REFERENCE[agentName];
  if (!ref) throw new Error(`No WAR reference for ${agentName}`);
  const [charter, tools] = await Promise.all(
    ['CHARTER.md', 'TOOLS.yaml'].map(f => readFile(join(REF_DIR!, ref, f), 'utf8')),
  );
  return `<reference_agent path="${ref}">
<charter>
${charter}
</charter>
<tools_yaml>
${tools}
</tools_yaml>
</reference_agent>`;
}

const only = process.argv.slice(2);
const packs = AGENT_PACKS.filter(p => !only.length || only.includes(p.id));

type Job = { packId: string; index: number; run: () => Promise<Build> };
const jobs: Job[] = packs.flatMap(p =>
  p.agents.map((a, index) => ({
    packId: p.id,
    index,
    run: async () => {
      const others = p.agents.filter(o => o !== a).map(o => `- ${o.name}: ${o.does}`).join('\n');
      const brief = `This is a ready-made agent in the "${p.name}" pack (${p.tagline}), added by many different small businesses, so you can't interview anyone. Write it for a typical small business and make sensible, safe defaults instead of asking.

The agent: ${a.name} - ${a.does}
${others ? `The other agents in the pack, which it works alongside (hand work to them rather than doing their job):\n${others}` : ''}

Below is a reference: the real Charter and TOOLS.yaml of the closest agent in a production agent fleet (a company called World Asset Register). They are hard-won and tested. Learn from how they work: the order of work in a run, checking before acting, deduping, never doing the same thing twice, what to do when blocked or rate-limited, what it must never do, how it measures a good run, how each tool is tiered and why. Bring that rigour into this agent. Do NOT copy that company's specifics: its people (Max, Troy), its product, its markets, its systems and tool names, its Slack channels and DM rules. In this app a person is reached only through Requests and Approvals. Only use tools from the catalogue or ones you define. Keep the Charter focused - about 120 to 250 lines.

${await reference(a.name)}

Use the catalogue's tools wherever they fit. Anything that reaches people outside the organisation, spends money or can't be undone waits for approval, unless a narrower tool can make a specific case safe. Where a business's choice matters (e.g. which email or accounting system), the catalogue's servers already cover the common products.`;
      // Generic on purpose: no organisation, no fleet. They're customized when added.
      const nobody = { name: 'the owner', email: '', role: '', about: '', notes: [] };
      const b = await build({ person: nobody, profile: null, fleet: { agents: [], tools: [] }, models: [] }, [{ role: 'person', text: brief }]);
      return { ...b, name: a.name, department: a.department as Build['department'] };
    },
  })),
);

const results = new Map<string, Build[]>();
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const t0 = Date.now();
    try {
      const b = await job.run();
      (results.get(job.packId) ?? results.set(job.packId, []).get(job.packId)!)[job.index] = b;
      console.log(`ok   ${job.packId}/${b.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      console.error(`FAIL ${job.packId}#${job.index}: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await mkdir(OUT, { recursive: true });
for (const [packId, builds] of results) {
  if (builds.some(b => !b)) continue; // a failed agent: rerun this pack
  await writeFile(join(OUT, `${packId}.json`), JSON.stringify(builds, null, 2) + '\n');
}
console.log(`wrote ${[...results.keys()].join(', ')}`);
