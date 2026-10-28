import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Gauge, LogOut, Plug, Plus, Sparkles, Trash2, User, X } from 'lucide-react';
import { ACCOUNT, AGENTS, createOrganization } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { AI_IDES, IdeLogo, setYourIde, yourIde, type IdeId } from './Requests';
import { useProfileChat } from './ProfileChat';
import { useDismiss } from './useDismiss';
import { ACCEPT, removePhoto, setPhoto, usePhoto } from './photo';
import {
  getCatalog,
  getHealth,
  getPerson,
  getProfile,
  savePerson,
  saveProfile,
  type Person,
  type Profile,
} from './builder';

export type SettingsSection = 'account' | 'organization' | 'usage' | 'connectors';

const SECTIONS: { id: SettingsSection; label: string; Icon: typeof User }[] = [
  { id: 'account', label: 'Account', Icon: User },
  { id: 'organization', label: 'Organization', Icon: Building2 },
  { id: 'usage', label: 'Usage', Icon: Gauge },
  { id: 'connectors', label: 'Connectors', Icon: Plug },
];

// Settings: a pop-up over the app, sections down the left, Log out at the foot.
export function Settings({
  section,
  onSection,
  onClose,
  onOrgChange,
  onLogOut,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onOrgChange: () => void; // the account just became an organization
  onLogOut: () => void;
}) {
  // The organization chat sits above Settings; Escape closes it first.
  const chatOpen = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !chatOpen.current && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="settings-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map(({ id, label, Icon }) => (
            <button key={id} className={`settings-nav-item${section === id ? ' on' : ''}`} onClick={() => onSection(id)}>
              <Icon size={16} strokeWidth={1.8} />
              {label}
            </button>
          ))}
          <div className="settings-nav-foot">
            <button className="settings-nav-item" onClick={onLogOut}>
              <LogOut size={16} strokeWidth={1.8} />
              Log out
            </button>
          </div>
        </nav>
        <div className="settings-body">
          <button className="settings-close" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
          {section === 'account' && <AccountSection />}
          {section === 'organization' && <OrganizationSection onOrgChange={onOrgChange} chatOpen={chatOpen} />}
          {section === 'usage' && <UsageSection />}
          {section === 'connectors' && <ConnectorsSection />}
        </div>
      </div>
    </div>
  );
}

// --- Small form pieces -------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="sfield">
      <span className="sfield-label">{label}</span>
      {children}
      {hint && <span className="sfield-hint">{hint}</span>}
    </label>
  );
}

// What the builder has learned over time: shown so you can remove anything wrong.
function Notes({ notes, onChange, empty }: { notes: string[]; onChange: (n: string[]) => void; empty: string }) {
  if (!notes.length) return <p className="snotes-empty">{empty}</p>;
  return (
    <ul className="snotes">
      {notes.map((n, i) => (
        <li key={i}>
          <span>{n}</span>
          <button aria-label="Forget this" title="Forget this" onClick={() => onChange(notes.filter((_, j) => j !== i))}>
            <Trash2 size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SaveBar({ dirty, saving, saved, error, onSave }: { dirty: boolean; saving: boolean; saved: boolean; error: string | null; onSave: () => void }) {
  return (
    <div className="ssave">
      {error && <span className="custom-error">{error}</span>}
      {saved && !dirty && (
        <span className="ssaved">
          <Check size={14} /> Saved
        </span>
      )}
      <button className="sbtn primary" disabled={!dirty || saving} onClick={onSave}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

// Load, edit and save one server-side record.
function useRecord<T>(load: () => Promise<T>, store: (v: T) => Promise<unknown>) {
  const [value, setValue] = useState<T | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setValue, e => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const edit = (patch: Partial<T>) => {
    setValue(v => (v ? { ...v, ...patch } : v));
    setDirty(true);
    setSaved(false);
  };
  const save = async () => {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      await store(value);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return { value, edit, dirty, saving, saved, error, save };
}

// --- Account -----------------------------------------------------------------

// One setting: what it is on the left, its control on the right.
// The same joined dropdown as the dashboard's range picker.
function IdePicker({ value, onChange }: { value: IdeId; onChange: (id: IdeId) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className={`ide-picker${open ? ' open' : ''}`} ref={ref}>
      <button className="range-btn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <IdeLogo logo={AI_IDES[value].logo} />
        {AI_IDES[value].name}
        <ChevronDown size={15} className="muted chev" />
      </button>
      {open && (
        // Near the foot of Settings: scroll so the whole menu shows.
        <ul className="dropdown-menu" role="listbox" ref={el => el?.scrollIntoView({ block: 'nearest' })}>
          {(Object.keys(AI_IDES) as IdeId[]).map(id => (
            <li key={id}>
              <button
                role="option"
                aria-selected={id === value}
                className="dropdown-option"
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
              >
                <span className="option-with-avatar">
                  <IdeLogo logo={AI_IDES[id].logo} />
                  {AI_IDES[id].name}
                </span>
                {id === value && <Check size={15} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="srow2">
      <div className="srow2-text">
        <span className="srow2-label">{label}</span>
        {sub && <span className="srow2-sub">{sub}</span>}
      </div>
      <div className="srow2-control">{children}</div>
    </div>
  );
}

// A text field that saves when you leave it.
function SavedInput({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="srow2-input"
      value={text}
      placeholder={placeholder}
      onChange={e => setText(e.target.value)}
      onBlur={() => text.trim() !== value && onSave(text.trim())}
      onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function AccountSection() {
  const [p, setP] = useState<Person | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ide, setIde] = useState<IdeId>(yourIde);
  const photo = usePhoto();
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    getPerson().then(setP, e => setError((e as Error).message));
  }, []);
  // Everything here saves as you go - there's no Save button to forget.
  const update = async (patch: Partial<Person>) => {
    if (!p) return;
    const next = { ...p, ...patch };
    setP(next);
    setError(null);
    try {
      await savePerson(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      await setPhoto(file);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="ssection">
      <h2>Account</h2>
      {error && <p className="custom-error">{error}</p>}
      {!p ? (
        !error && <p className="snotes-empty">Loading...</p>
      ) : (
        <>
          <div className="sgroup">
            <h3>Profile</h3>
            <Row label="Profile photo" sub="PNG, JPEG or WebP, up to 10MB.">
              <button
                className="sphoto"
                onClick={() => fileInput.current?.click()}
                title={photo ? 'Change photo' : 'Upload a photo'}
                aria-label={photo ? 'Change photo' : 'Upload a photo'}
              >
                {photo ? <img src={photo} alt="" /> : (p.full_name || p.name).charAt(0)}
              </button>
              {photo && (
                <button className="slink" onClick={removePhoto}>
                  Remove
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={e => {
                  pickPhoto(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </Row>
            <Row label="Full name">
              <SavedInput value={p.full_name ?? ''} placeholder={p.name} onSave={full_name => update({ full_name })} />
            </Row>
            <Row label="What should agents call you?">
              <SavedInput value={p.call_me ?? ''} placeholder={p.name} onSave={call_me => update({ call_me })} />
            </Row>
          </div>

          <div className="sgroup">
            <h3>Sign-in</h3>
            <Row label="Username">
              <input className="srow2-input" value={p.name} disabled />
            </Row>
            <Row label="Email">
              <SavedInput value={p.email} placeholder="you@company.com" onSave={email => update({ email })} />
            </Row>
            {/* Sign-in isn't built yet: these come with it. */}
            <Row label="Password" sub="Change it, or get a reset link by email.">
              <button className="sbtn" disabled title="Comes with sign-in">
                Change
              </button>
              <button className="sbtn" disabled title="Comes with sign-in">
                Send reset link
              </button>
            </Row>
          </div>

          <div className="sgroup">
            <Memories notes={p.notes} onChange={notes => update({ notes })} />
          </div>
        </>
      )}

      <div className="sgroup">
        <h3>Preferences</h3>
        <Row label="AI IDE" sub='Where "Send to" on a request opens it.'>
          <IdePicker
            value={ide}
            onChange={id => {
              setIde(id);
              setYourIde(id);
            }}
          />
        </Row>
      </div>

      <div className="sgroup sgroup-delete">
        <button className="sbtn danger" disabled title="Comes with sign-in">
          Delete account
        </button>
      </div>
    </section>
  );
}

// What your agents know about you. They add to it over time (only lasting
// things); you can add your own with + and forget anything with the bin.
function Memories({ notes, onChange }: { notes: string[]; onChange: (n: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t) onChange([...notes, t]);
    setText('');
    setAdding(false);
  };
  return (
    <div className="sfield">
      <div className="smem-head">
        <h3>Memories</h3>
        <button className="smem-add" onClick={() => setAdding(true)} aria-label="Add a memory" title="Add a memory">
          <Plus size={15} />
        </button>
      </div>
      {adding && (
        <input
          className="smem-input"
          autoFocus
          value={text}
          placeholder="Something every agent should know about you"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') add();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setText('');
              setAdding(false);
            }
          }}
          onBlur={add}
        />
      )}
      <Notes notes={notes} onChange={onChange} empty={adding ? '' : 'Nothing yet. Your agents add lasting things they learn about you here.'} />
    </div>
  );
}

// --- Organization ------------------------------------------------------------

function OrganizationSection({ onOrgChange, chatOpen }: { onOrgChange: () => void; chatOpen: React.MutableRefObject<boolean> }) {
  const org = ACCOUNT.org;
  const chat = useProfileChat();
  chatOpen.current = !!chat.element;
  const [name, setName] = useState('');
  const startBtn = useRef<HTMLButtonElement>(null);

  if (!org) {
    const create = async () => {
      const n = name.trim();
      if (!n) return;
      const made = () => {
        createOrganization(n);
        onOrgChange();
      };
      // Already described (e.g. set up before): no need to ask again.
      if (await getProfile(n).catch(() => null)) return made();
      chat.start(n, startBtn.current, made);
    };
    return (
      <section className="ssection">
        <h2>Organization</h2>
        <div className="sorg-empty">
          <div className="custom-mark">
            <Building2 size={22} strokeWidth={1.6} />
          </div>
          <h3>Make this into an organization</h3>
          <p>
            Your account is personal, so your agents start general and get tailored to you over time. Make it an
            organization and every agent is written for your company from the start - what it does, who it sells to,
            how it sounds and who's who - and you can add people later.
          </p>
          <Field label="Organization name">
            <input value={name} placeholder="e.g. Acme Ventures" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
          </Field>
          <button className="sbtn primary" ref={startBtn} disabled={!name.trim()} onClick={create}>
            <Sparkles size={15} strokeWidth={2} />
            Get started
          </button>
        </div>
        {chat.element}
      </section>
    );
  }
  return <OrganizationProfile name={org.name} members={org.members} />;
}

const BLANK_PROFILE = (name: string): Profile => ({ name, what_it_does: '', customers: '', offering: '', voice: '', people: [], notes: [] });

function OrganizationProfile({ name, members }: { name: string; members: string[] }) {
  const rec = useRecord<Profile>(
    () => getProfile(name).then(p => p ?? BLANK_PROFILE(name)),
    p => saveProfile(name, p),
  );
  const p = rec.value;
  return (
    <section className="ssection">
      <h2>{name}</h2>
      <p className="slead">Every agent's brief is written from this. The builder adds to it as it learns.</p>
      {!p ? (
        rec.error ? <p className="custom-error">{rec.error}</p> : <p className="snotes-empty">Loading...</p>
      ) : (
        <>
          <Field label="What it does">
            <textarea rows={2} value={p.what_it_does} onChange={e => rec.edit({ what_it_does: e.target.value })} />
          </Field>
          <div className="sgrid">
            <Field label="Customers">
              <textarea rows={2} value={p.customers} onChange={e => rec.edit({ customers: e.target.value })} />
            </Field>
            <Field label="What it sells">
              <textarea rows={2} value={p.offering} onChange={e => rec.edit({ offering: e.target.value })} />
            </Field>
          </div>
          <Field label="Voice" hint="How it sounds when it writes to people.">
            <input value={p.voice} onChange={e => rec.edit({ voice: e.target.value })} />
          </Field>
          <div className="sfield">
            <span className="sfield-label">Key people</span>
            <ul className="speople">
              {p.people.map((person, i) => (
                <li key={i}>
                  <input
                    value={person.name}
                    placeholder="Name"
                    onChange={e => rec.edit({ people: p.people.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                  />
                  <input
                    value={person.role}
                    placeholder="Role"
                    onChange={e => rec.edit({ people: p.people.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })}
                  />
                  <button aria-label="Remove" onClick={() => rec.edit({ people: p.people.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
            <button className="sbtn" onClick={() => rec.edit({ people: [...p.people, { name: '', role: '' }] })}>
              <Plus size={14} /> Add person
            </button>
          </div>
          <div className="sfield">
            <span className="sfield-label">What agents have learned</span>
            <Notes notes={p.notes} onChange={notes => rec.edit({ notes })} empty="Nothing yet." />
          </div>
          <SaveBar dirty={rec.dirty} saving={rec.saving} saved={rec.saved} error={rec.error} onSave={rec.save} />
        </>
      )}
      <h3>Members</h3>
      <ul className="smembers">
        {members.map(m => (
          <li key={m}>
            <span className="avatar" style={{ width: 26, height: 26 }}>
              {m.charAt(0)}
            </span>
            {m}
            {m === ACCOUNT.name && <span className="muted"> (you)</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Usage -------------------------------------------------------------------

const money = (n: number) => `$${n.toFixed(2)}`;

function UsageSection() {
  // PLACEHOLDER figures until agents run for real: each agent's month so far.
  const rows = AGENTS.map(a => ({ a, spend: a.cost.reduce((s, c) => s + c.value, 0) })).sort((x, y) => y.spend - x.spend);
  const total = rows.reduce((s, r) => s + r.spend, 0);
  const runs = AGENTS.reduce((s, a) => s + a.runs, 0);
  const top = Math.max(...rows.map(r => r.spend), 1);
  return (
    <section className="ssection">
      <h2>Usage</h2>
      <div className="stiles">
        <div className="stile">
          <span className="stile-label">Spend</span>
          <span className="stile-value">{money(total)}</span>
        </div>
        <div className="stile">
          <span className="stile-label">Runs</span>
          <span className="stile-value">{runs.toLocaleString()}</span>
        </div>
        <div className="stile">
          <span className="stile-label">Agents</span>
          <span className="stile-value">{AGENTS.length}</span>
        </div>
      </div>
      <h3>By agent</h3>
      <ul className="susage">
        {rows.map(({ a, spend }) => {
          const Icon = DEPARTMENT_ICON[a.department];
          return (
            <li key={a.id} title={`${a.name}: ${money(spend)} over ${a.runs} runs`}>
              <span className="susage-name">
                <Icon size={14} strokeWidth={1.75} />
                {a.name}
              </span>
              <span className="susage-bar">
                <span style={{ width: `${(spend / top) * 100}%` }} />
              </span>
              <span className="susage-runs">{a.runs.toLocaleString()} runs</span>
              <span className="susage-spend">{money(spend)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Connectors --------------------------------------------------------------

function ConnectorsSection() {
  const [catalog, setCatalog] = useState<{ server: string; what: string; tools: number }[] | null>(null);
  const [key, setKey] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getCatalog().then(setCatalog, e => setError((e as Error).message));
    getHealth().then(h => setKey(h.anthropicKey), () => setKey(null));
  }, []);
  return (
    <section className="ssection">
      <h2>Connectors</h2>
      <p className="slead">The accounts your agents work in. Keys and sign-ins go here - never in a chat with an agent.</p>
      <ul className="sconnectors">
        <li>
          <span className="sconn-name">Claude API</span>
          <span className="sconn-what">Runs the agent builder and your agents</span>
          {key === null ? (
            <span className="sconn-state muted">Unknown</span>
          ) : key ? (
            <span className="sconn-state ok">
              <Check size={13} /> Connected
            </span>
          ) : (
            <span className="sconn-state warn">Not set - add ANTHROPIC_API_KEY to apps/server/.env</span>
          )}
        </li>
      </ul>
      <h3>Integrations</h3>
      {error && <p className="custom-error">{error}</p>}
      <ul className="sconnectors">
        {(catalog ?? []).map(c => (
          <li key={c.server}>
            <span className="sconn-name">{c.what}</span>
            <span className="sconn-what">
              {c.server} · {c.tools} tools
            </span>
            <button className="sbtn" disabled title="Coming soon">
              Connect
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
