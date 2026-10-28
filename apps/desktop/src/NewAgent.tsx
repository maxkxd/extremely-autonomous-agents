import { Plus, Sparkles } from 'lucide-react';
import { AGENT_PACKS, type AgentPack } from './packs';
import { DEPARTMENT_ICON } from './Sidebar';

// "Customize your own agent" always takes the last slot of the top row (the
// 4th card), or follows the packs straight away if there are fewer than three.
const CUSTOM_SLOT = 3;

function PackCard({ pack }: { pack: AgentPack }) {
  return (
    <article className={`pack${pack.featured ? ' featured' : ''}`}>
      {pack.featured && <div className="pack-ribbon">{pack.featured}</div>}
      <div className="pack-body">
        <h2 className="pack-name">{pack.name}</h2>
        <p className="pack-tagline">{pack.tagline}</p>
        <div className="pack-count">
          {pack.agents.length} agent{pack.agents.length === 1 ? '' : 's'}
        </div>
        <div className="pack-divider" />
        <ul className="pack-agents">
          {pack.agents.map(a => {
            const Icon = DEPARTMENT_ICON[a.department];
            return (
              <li key={a.name}>
                <Icon size={16} strokeWidth={1.75} className="pack-agent-icon" />
                <div>
                  <div className="pack-agent-name">{a.name}</div>
                  <div className="pack-agent-does">{a.does}</div>
                </div>
              </li>
            );
          })}
        </ul>
        {/* Not wired yet: adding a pack is the next step. */}
        <button className="pack-add" disabled title="Coming next">
          <Plus size={15} strokeWidth={2} />
          Add {pack.name.toLowerCase()} pack
        </button>
      </div>
    </article>
  );
}

function CustomCard() {
  return (
    <article className="pack custom">
      <div className="pack-body">
        <div className="custom-mark">
          <Sparkles size={22} strokeWidth={1.6} />
        </div>
        <h2 className="pack-name">Customize your own agent</h2>
        <p className="pack-tagline">
          Describe the job in your own words and build an agent for exactly that - its tools, its schedule, how hard it
          works.
        </p>
        <button className="pack-add custom-add" disabled title="Coming next">
          <Plus size={15} strokeWidth={2} />
          Build your own
        </button>
      </div>
    </article>
  );
}

export function NewAgent() {
  const at = Math.min(CUSTOM_SLOT, AGENT_PACKS.length);
  const cards = [
    ...AGENT_PACKS.slice(0, at).map(p => <PackCard key={p.id} pack={p} />),
    <CustomCard key="custom" />,
    ...AGENT_PACKS.slice(at).map(p => <PackCard key={p.id} pack={p} />),
  ];
  return (
    <div className="packs-wrap">
      <div className="packs">{cards}</div>
    </div>
  );
}
