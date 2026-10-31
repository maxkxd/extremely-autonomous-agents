// The big pictures in the help window: small, still mock-ups of the real UI,
// arranged into a diagram, with labels. One per help section (topics.ts).
// They're drawn in the app's palette from a few pieces below, not images, so
// they stay crisp and match the app.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  Clock,
  Hammer,
  Hand,
  SendHorizontal,
  TrendingUp,
  X,
  ChevronRight,
  CircleCheck,
  EyeOff,
  Megaphone,
  Sparkles,
} from 'lucide-react';
import { FEROCITY, type Agent } from '../data';
import { renderApproval } from '../approvalTools';
import { AI_IDES, IdeLogo } from '../Requests';
import { RunPostView, type StampedEntry } from '../AgentDM';
import type { RunPost as RunPostType } from '../dms';
import { AgentCard as RealAgentCard, Donut as RealDonut } from '../Dashboard';
import { ModelPanel } from '../ModelPicker';
import type { AvailableModels, ModelChoice } from '../builder';

// ---- Pieces ----------------------------------------------------------------

function Stage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`hd-stage ${className}`}>{children}</div>;
}

function Donut({ value, label, slices }: { value: string; label: string; slices: number[] }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((a, b) => a + b, 0);
  let at = 0;
  const shades = ['#3f7bd6', '#7aa3e4', '#b4cbf0'];
  return (
    <div className="hd-donut">
      <svg viewBox="0 0 100 100" width="104" height="104">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#262626" strokeWidth="16" />
        {slices.map((s, i) => {
          const len = (s / total) * c;
          const el = (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={shades[i % shades.length]}
              strokeWidth="16"
              strokeDasharray={`${len - 1.5} ${c - len + 1.5}`}
              strokeDashoffset={-at}
              transform="rotate(-90 50 50)"
            />
          );
          at += len;
          return el;
        })}
      </svg>
      <div className="hd-donut-mid">
        <b>{value}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

// A callout: a short label with a line pointing at something.
function Callout({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`hd-callout ${className}`}>{children}</div>;
}

function MiniApproval({ tone }: { tone?: 'approved' | 'rejected' }) {
  return (
    <div className={`hd-approval${tone ? ` ${tone}` : ''}`}>
      <div className="hd-approval-line">
        <b>Outreach</b> wants to send a LinkedIn connection request
      </div>
      <div className="hd-approval-field">
        <span>To</span> Priyanka Rao
      </div>
      <div className="hd-approval-buttons">
        <span className="hd-btn blue">
          <Check size={12} strokeWidth={2.5} /> Approve
        </span>
        <span className="hd-btn">
          <X size={12} strokeWidth={2.5} /> Reject
        </span>
        <span className="hd-approval-clock">
          <Clock size={11} /> 3:59:41
        </span>
      </div>
    </div>
  );
}

// ---- The diagrams ----------------------------------------------------------

// A sample outreach agent: easy to picture what its output and cost are.
const OUTREACH: Agent = {
  id: 'help-outreach',
  name: 'Outreach',
  department: 'sales',
  owner: 'Max',
  output: [
    { label: 'LinkedIn DMs sent', value: 184 },
    { label: 'Cold emails sent', value: 126 },
    { label: 'Follow-ups sent', value: 58 },
    { label: 'Meetings booked', value: 9 },
  ],
  cost: [
    { label: 'Model usage', value: 11.4 },
    { label: 'Email sending', value: 2.1 },
  ],
  runs: 212,
  lastRun: { minutesAgo: 6, outcome: 'succeeded' },
  decisions: { approved: 41, rejected: 6, expired: 1 },
  ferocity: 2,
};
// The same agent a few minutes into its very first run.
const OUTREACH_FIRST_RUN: Agent = {
  ...OUTREACH,
  id: 'help-outreach-first',
  output: [
    { label: 'LinkedIn DMs sent', value: 7 },
    { label: 'Cold emails sent', value: 4 },
  ],
  cost: [{ label: 'Model usage', value: 0.38 }],
  runs: 1,
  lastRun: { minutesAgo: 0, outcome: 'running' },
  decisions: { approved: 0, rejected: 0, expired: 0 },
  ferocity: 0,
};
const count = (n: number) => n.toLocaleString();
const dollars = (n: number) => `$${n.toFixed(2)}`;

// The real dashboard card at its usual width, scaled to fill the help
// window's column, and not clickable.
const CARD_WIDTH = 1160;
function AgentCard({ agent = OUTREACH, openApprovals = 2 }: { agent?: Agent; openApprovals?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.6);
  useLayoutEffect(() => {
    const el = box.current!;
    const fit = () => setZoom(el.clientWidth / CARD_WIDTH);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="hd-real" ref={box}>
      <div className="hd-real-card" style={{ width: CARD_WIDTH, zoom }} {...{ inert: '' }}>
        <RealAgentCard
          agent={agent}
          range="month"
          state="active"
          setState={() => {}}
          onNavigate={() => {}}
          openApprovals={openApprovals}
          openRequests={0}
          decisions={agent.decisions}
          dragging={false}
          onGripDown={() => {}}
          preview
          models={SAMPLE_CHOICES}
          available={SAMPLE_MODELS}
        />
      </div>
    </div>
  );
}

// Its two charts, big, with one slice shown as hovered.
function OutputCost() {
  return (
    <Stage className="hd-charts">
      <div className="hd-chart">
        <RealDonut caption="output" slices={OUTREACH.output} format={count} pin={0} />
      </div>
      <div className="hd-chart">
        <RealDonut caption="cost" slices={OUTREACH.cost} format={dollars} />
      </div>
    </Stage>
  );
}

// Sample model connections for the pictures: one of each big provider, so
// the help doesn't read as Anthropic-only.
const SAMPLE_MODELS: AvailableModels[] = [
  {
    connection: 'anthropic',
    name: 'Anthropic',
    kind: 'key',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    efforts: {
      'claude-opus-5-5': ['low', 'medium', 'high', 'max'],
      'claude-sonnet-5-5': ['low', 'medium', 'high', 'max'],
      'claude-haiku-5-5': [],
    },
  },
  {
    connection: 'openai',
    name: 'OpenAI',
    kind: 'key',
    models: ['gpt-6.1-terra', 'gpt-6.1-sol'],
    efforts: { 'gpt-6.1-terra': ['low', 'medium', 'high'], 'gpt-6.1-sol': ['low', 'medium', 'high'] },
  },
  {
    connection: 'google',
    name: 'Google',
    kind: 'key',
    models: ['gemini-3.1-pro'],
    efforts: { 'gemini-3.1-pro': ['low', 'high'] },
  },
];
const SAMPLE_CHOICES: ModelChoice[] = [
  { connection: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  { connection: 'openai', model: 'gpt-6.1-terra', effort: 'medium' },
  { connection: 'google', model: 'gemini-3.1-pro', effort: 'high' },
];

// The card's right-hand column on its own (the real card with its pies
// hidden), numbered, with what each part is.
const SIDE_PARTS = [
  ['Runs', 'How many times it has run in the time range.'],
  ['Last run', 'When it last ran, and how that went.'],
  ['Standby and Stop', 'Standby lets the run in progress finish, then starts nothing new on its own. Stop cuts it off now.'],
  ['Ferocity', 'How hard it works. Est. Output is what that should get done in the time range.'],
  ['Model', 'The AI it runs on. Click to choose.'],
];
function CardSide() {
  return (
    <Stage className="hd-side-stage">
      <div className="hd-side" {...{ inert: '' }}>
        <RealAgentCard
          agent={OUTREACH}
          range="month"
          state="active"
          setState={() => {}}
          onNavigate={() => {}}
          openApprovals={2}
          openRequests={0}
          decisions={OUTREACH.decisions}
          dragging={false}
          onGripDown={() => {}}
          preview
          models={SAMPLE_CHOICES}
          available={SAMPLE_MODELS}
        />
      </div>
      <ol className="hd-legend">
        {SIDE_PARTS.map(([name, what]) => (
          <li key={name}>
            <b>{name}</b>
            <span>{what}</span>
          </li>
        ))}
      </ol>
    </Stage>
  );
}

// The real model picker, working, with a sample connection.
function Models() {
  const [choices, setChoices] = useState(SAMPLE_CHOICES);
  return (
    <Stage className="hd-models">
      <ModelPanel choices={choices} available={SAMPLE_MODELS} onChange={setChoices} startSlot={0} />
    </Stage>
  );
}

// What each level is like, Chill to Apocalyptic: a title, then what it means.
const FEROCITY_TAGLINES: [string, string?][] = [
  ['The Default', 'will get the job done'],
  ['Needle Mover', 'will go above expectations'],
  ['Intensely Overworked', 'will never leave output on the table'],
  ['Inhuman', 'will never rest'],
  ['The Paperclip Maximizer'],
];

// Drawn like the card's ferocity slider: a track with a stop for each level,
// and what each level means under its stop.
function Ferocity() {
  return (
    <Stage className="hd-ferocity">
      <div className="hd-fero-slider">
        <div className="hd-fero-track" />
        {FEROCITY.map((f, i) => (
          <div key={f.name} className={`hd-fero-stop fero-${i}`}>
            <div className="hd-fero-dot" />
          </div>
        ))}
      </div>
      <div className="hd-fero-levels">
        {FEROCITY.map((f, i) => {
          const [title, line] = FEROCITY_TAGLINES[i] ?? [];
          return (
            <div key={f.name} className={`hd-fero fero-${i}`}>
              <div className="hd-fero-name">{f.name}</div>
              {title && <div className="hd-fero-title">{title}</div>}
              {line && <div className="hd-fero-line">{line}</div>}
            </div>
          );
        })}
      </div>
    </Stage>
  );
}

// The three levels a tool can be set to, each with what you see of it.
function Tiers() {
  return (
    <Stage className="hd-tiers">
      <div className="hd-tier">
        <div className="hd-tier-badge t0">Silent</div>
        <b>Just does it</b>
        <span className="hd-tier-eg">e.g. searching the web, reading a profile</span>
        <div className="hd-tier-shows quiet">
          <EyeOff size={16} /> Nothing to see
        </div>
      </div>
      <div className="hd-tier">
        <div className="hd-tier-badge t1">Logged</div>
        <b>Does it, and tells you</b>
        <span className="hd-tier-eg">e.g. saving a draft, adding a label</span>
        <div className="hd-tier-shows">
          <div className="hd-tier-dm">
            <CircleCheck size={12} /> scheduled · 2 actions · $0.04
          </div>
          <div className="hd-tier-tool">gmail · create_draft</div>
          <em>in its DMs</em>
        </div>
      </div>
      <div className="hd-tier">
        <div className="hd-tier-badge t2">Approval</div>
        <b>Asks you first</b>
        <span className="hd-tier-eg">e.g. sending a message, publishing a post</span>
        <div className="hd-tier-shows">
          <div className="hd-tier-approval">
            <span className="hd-btn blue">
              <Check size={11} strokeWidth={2.5} /> Approve
            </span>
            <span className="hd-btn">
              <X size={11} strokeWidth={2.5} /> Reject
            </span>
          </div>
          <em>becomes an approval</em>
        </div>
      </div>
    </Stage>
  );
}

// An approval card as it appears on the Approvals page, drawn with the page's
// own styles (the real card looks its agent up in the org, and Outreach is
// only a sample).
function ApprovalCardPicture() {
  const card = renderApproval('linkedin.connect', {
    name: 'Priyanka Rao',
    headline: 'Head of Operations, Tidewater Freight',
    note: 'Hi Priyanka - saw your post on consolidating depot reporting. We help ops teams do exactly that without the spreadsheet shuffle. Would be good to connect.',
  });
  return (
    <div className="hd-approval-real" {...{ inert: '' }}>
      <div className="approvals">
        <article className="approval">
          <div className="approval-avatar" aria-hidden>
            <TrendingUp size={18} strokeWidth={1.75} />
          </div>
          <div className="approval-main">
            <header className="approval-head">
              <p className="approval-line">
                <span className="approval-agent">Outreach</span> <span className="approval-action">{card.action}</span>{' '}
                <span className="approval-time">4m ago</span>
              </p>
            </header>
            <dl className="approval-fields">
              {card.fields.map(f => (
                <div key={f.label} className="approval-field">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {card.body !== null && (
              <div className="approval-body-wrap">
                <blockquote className="approval-body">{card.body}</blockquote>
              </div>
            )}
            <footer className="approval-foot">
              <div className="approval-buttons">
                <button className="ap-btn approve">
                  <Check size={15} strokeWidth={2.25} />
                  Approve
                </button>
                <button className="ap-btn reject">
                  <X size={15} strokeWidth={2.25} />
                  Reject
                </button>
              </div>
              <span className="approval-expiry">
                <Clock size={12} strokeWidth={1.75} />
                3:55:12
              </span>
            </footer>
          </div>
        </article>
      </div>
    </div>
  );
}

function ApproveReject() {
  return (
    <Stage className="hd-decide">
      <div className="hd-decide-side red">
        <div className="hd-decide-card left">
          <MiniApproval tone="rejected" />
        </div>
        <b>
          <X size={15} strokeWidth={2.5} /> Rejected
        </b>
        <span>doesn't happen; the agent sees why</span>
      </div>
      <div className="hd-decide-arrow left">
        <ArrowRight size={22} strokeWidth={1.75} />
      </div>
      <MiniApproval />
      <div className="hd-decide-arrow">
        <ArrowRight size={22} strokeWidth={1.75} />
      </div>
      <div className="hd-decide-side green">
        <div className="hd-decide-card right">
          <MiniApproval tone="approved" />
        </div>
        <b>
          <Check size={15} strokeWidth={2.5} /> Approved
        </b>
        <span>the agent goes ahead</span>
      </div>
    </Stage>
  );
}

// A request as it appears on the Requests page, opened, drawn with the page's
// own styles (the real row looks its agent up in the org; Outreach is a sample).
const SAMPLE_REQUEST = {
  summary: 'Needs access to the company LinkedIn Sales Navigator account',
  detail:
    "I'm finding people through LinkedIn's public search, which caps at about 30 useful profiles a day. With a Sales Navigator seat I could filter by role, company size and region and reach far more of the right people. Read-only search is enough.",
  plan:
    "I can build a read-only Sales Navigator search tool for Outreach. Here's what I need from you:\n1. Buy a Sales Navigator seat (Core is enough).\n2. In Sales Navigator, go to Settings > Integrations and create an API key.\n3. Reply here when that's done. I'll build the tool, and you'll paste the key into Settings > Connections (not here).",
};

function RequestActions({ numbered = false }: { numbered?: boolean }) {
  return (
    <div className={`request-actions${numbered ? ' hd-numbered' : ''}`}>
      <button className="rq-btn ide" disabled>
        <IdeLogo logo={AI_IDES.cursor.logo} />
        Send to your IDE
      </button>
      <div className="request-own">
        <button className="rq-btn diy">
          <Hand size={14} strokeWidth={1.9} />
          DIY
        </button>
        <button className="rq-btn reject">
          <X size={14} strokeWidth={2.25} />
          Reject
        </button>
      </div>
    </div>
  );
}

// The reply box under the Agency Engineer's message.
function ReplyBox({ numbered = false }: { numbered?: boolean }) {
  return (
    <div className={`eng-composer${numbered ? ' hd-numbered-box' : ''}`}>
      <textarea
        className="reject-reason"
        rows={2}
        placeholder={'Reply to the Agency Engineer, e.g. "I\'ll get a seat - what do you need?" or "done"'}
        readOnly
      />
      <div className="reject-actions">
        <span className="drawer-hint">Don't paste API keys or passwords here - you'll add those in settings.</span>
        <button className="ap-btn confirm-engineer" disabled>
          <SendHorizontal size={14} strokeWidth={1.9} />
          Send
        </button>
      </div>
    </div>
  );
}

function RequestPicture() {
  return (
    <div className="hd-request-real" {...{ inert: '' }}>
      <div className="requests">
        <article className="request open">
          <div className="request-row">
            <ChevronRight size={15} className="request-chevron" />
            <TrendingUp size={15} strokeWidth={1.75} className="request-dept" />
            <span className="request-agent">Outreach</span>
            <span className="request-summary">{SAMPLE_REQUEST.summary}</span>
            <span className="request-time">2h ago</span>
          </div>
          <div className="request-expand">
            <div className="request-clip">
              <div className="request-body">
                <p className="request-detail">{SAMPLE_REQUEST.detail}</p>
                <div className="eng-chat">
                  <div className="eng-msg engineer">
                    <span className="eng-by">
                      <Hammer size={12} strokeWidth={1.9} />
                      Agency Engineer
                    </span>
                    <div className="eng-text">{SAMPLE_REQUEST.plan}</div>
                  </div>
                  <ReplyBox />
                </div>
                <RequestActions />
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}

// The ways to answer a request: the reply box and the buttons, numbered,
// with what each does.
function RequestAnswer() {
  return (
    <Stage className="hd-answer">
      <div className="hd-answer-parts" {...{ inert: '' }}>
        <ReplyBox numbered />
        <RequestActions numbered />
      </div>
      <ol className="hd-legend hd-answer-legend">
        <li>
          <b>Reply</b>
          <span>Work with the agent to fulfill the request.</span>
        </li>
        <li>
          <b>Send to your IDE</b>
          <span>Opens your AI IDE on the request, with the agency's tools.</span>
        </li>
        <li>
          <b>DIY</b>
          <span>Sort it out yourself and tell it what you did.</span>
        </li>
        <li>
          <b>Reject</b>
          <span>Your reason goes back to the agent.</span>
        </li>
      </ol>
    </Stage>
  );
}

// The Outreach agent's DM, drawn with the DM page's own pieces: a real run
// post, your message, its reply and the compose box.
const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();
const OUTREACH_RUN: StampedEntry & RunPostType = {
  kind: 'run',
  id: 'a41f',
  minutesAgo: 0,
  at: at(9, 41),
  trigger: 'scheduled',
  outcome: 'succeeded',
  cost: 0.21,
  seconds: 48,
  text: 'Found 14 ops leads at freight companies, drafted 3 intro emails, and asked to connect with Priyanka Rao on LinkedIn.',
  tools: [
    { server: 'web', tool: 'search', fields: ['query'], status: 'ok' },
    { server: 'gmail', tool: 'create_draft', fields: ['to', 'subject', 'body'], status: 'ok' },
    { server: 'linkedin', tool: 'connect', fields: ['name', 'note'], status: 'ok', approvalId: 'help-sample' },
  ],
};
const OUTREACH_REPLY: StampedEntry & RunPostType = {
  kind: 'run',
  id: 'a420',
  minutesAgo: 0,
  at: at(10, 3),
  trigger: 'your message',
  outcome: 'succeeded',
  cost: 0.02,
  seconds: 4,
  text: "Will do - Kestrel Logistics goes to the top of tomorrow's list.",
  tools: [],
};

function RunPost() {
  return (
    <div className="hd-dm-real" {...{ inert: '' }}>
      <div className="dm-log">
        <RunPostView post={OUTREACH_RUN} agentName="Outreach" Icon={TrendingUp} outcomes={{}} />
      </div>
    </div>
  );
}

function Talk() {
  return (
    <div className="hd-dm-real" {...{ inert: '' }}>
      <div className="dm-log">
        <div className="dm-post">
          <div className="dm-avatar you">M</div>
          <div className="dm-post-main">
            <div className="dm-post-head">
              <span className="dm-author">Max</span>
              <span className="dm-time">10:02 AM</span>
            </div>
            <p className="dm-text">Can you put Kestrel Logistics first this week?</p>
          </div>
        </div>
        <RunPostView post={OUTREACH_REPLY} agentName="Outreach" Icon={TrendingUp} outcomes={{}} />
      </div>
      <div className="dm-composer">
        <textarea rows={1} placeholder="Message Outreach" readOnly />
        <button className="dm-send" disabled aria-label="Send">
          <SendHorizontal size={16} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
}

// ---- Getting started -------------------------------------------------------

const AMBITION = [
  {
    Icon: TrendingUp,
    who: 'Sales',
    small: 'Sorts the sales inquiries in your inbox',
    big: 'Works so many leads its blocker is inbox storage',
  },
  {
    Icon: Megaphone,
    who: 'Marketing',
    small: 'Sends a daily strategic marketing report',
    big: 'Launches campaigns overnight, faster than you can review them',
  },
];

function ThinkBigger() {
  return (
    <Stage className="hd-ambition">
      <div className="hd-ambition-col small">
        <div className="hd-ambition-head">Not this</div>
        {AMBITION.map(({ Icon, who, small }) => (
          <div key={who} className="hd-ambition-agent">
            <Icon size={18} strokeWidth={1.75} />
            <div>
              <b>{who}</b>
              <span>{small}</span>
            </div>
          </div>
        ))}
      </div>
      <ArrowRight size={22} className="hd-decide-arrow" />
      <div className="hd-ambition-col big">
        <div className="hd-ambition-head">This</div>
        {AMBITION.map(({ Icon, who, big }) => (
          <div key={who} className="hd-ambition-agent">
            <Icon size={18} strokeWidth={1.75} />
            <div>
              <b>{who}</b>
              <span>{big}</span>
            </div>
          </div>
        ))}
      </div>
    </Stage>
  );
}

// The New agent page, sketched: a few packs and the custom card.
const SKETCH_PACKS = ['Sales', 'Marketing', 'Support'];
function FirstAgent() {
  return (
    <Stage className="hd-first">
      {SKETCH_PACKS.map(name => (
        <div key={name} className="hd-first-pack">
          <b>{name}</b>
          <i style={{ width: '90%' }} />
          <i style={{ width: '60%' }} />
          <div className="hd-first-rows">
            <i />
            <i />
          </div>
        </div>
      ))}
      <div className="hd-first-pack custom">
        <Sparkles size={26} strokeWidth={1.5} />
      </div>
    </Stage>
  );
}

const FirstRun = () => <AgentCard agent={OUTREACH_FIRST_RUN} openApprovals={0} />;

export const DIAGRAMS = {
  'think-bigger': ThinkBigger,
  'first-agent': FirstAgent,
  'first-run': FirstRun,
  'agent-card': () => <AgentCard />,
  'output-cost': OutputCost,
  ferocity: Ferocity,
  'card-side': CardSide,
  models: Models,
  tiers: Tiers,
  'approval-card': ApprovalCardPicture,
  'approve-reject': ApproveReject,
  request: RequestPicture,
  'request-answer': RequestAnswer,
  'run-post': RunPost,
  talk: Talk,
} satisfies Record<string, () => JSX.Element>;

export type DiagramId = keyof typeof DIAGRAMS;
