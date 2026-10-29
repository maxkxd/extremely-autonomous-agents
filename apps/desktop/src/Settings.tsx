import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Gauge, LogOut, Plug, Plus, Trash2, User, X } from 'lucide-react';
import { ACCOUNT, AGENTS } from './data';
import {
  createInvite,
  createOrganisation,
  deleteOrganisation,
  invites as listInvites,
  joinWithCode,
  leaveOrganisation,
  members as listMembers,
  ownOrg,
  previewInvite,
  removeMember,
  revokeInvite,
  setRole,
  state,
  switchAgency,
  teamOrgs,
  type Invite,
  type Member,
} from './account';
import { openSignIn } from './SignIn';
import { DEPARTMENT_ICON } from './Sidebar';
import { AI_IDES, IdeLogo, setYourIde, yourIde, type IdeId } from './Requests';
import { useProfileChat } from './ProfileChat';
import { ModelConnectors } from './ModelConnectors';
import { Integrations } from './Integrations';
import { useDismiss } from './useDismiss';
import { ACCEPT, removePhoto, setPhoto, usePhoto } from './photo';
import {
  getCatalog,
  getPerson,
  getProfile,
  getUsage,
  linkKeyPeople,
  savePerson,
  saveProfile,
  setAgentRunner,
  setOrgCap,
  type KeyPerson,
  type Person,
  type Profile,
  type Usage,
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
  onOpenApproval,
  focusIntegration,
  onFocused,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onOpenApproval: (id: string) => void; // a draft's Approve: to its approval
  focusIntegration?: string | null; // Connectors: the integration to bring into view and glow
  onFocused?: () => void;
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
              {state.me ? 'Log out' : 'Sign in'}
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
          {section === 'connectors' && <ConnectorsSection onOpenApproval={onOpenApproval} focus={focusIntegration} onFocused={onFocused} />}
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

// Load, edit and save one server-side record.
// How long after you stop typing a change is saved.
const SAVE_AFTER_MS = 600;

// Load one server-side record and save it as you edit: a moment after you
// stop typing, and straight away if Settings closes first.
function useRecord<T>(load: () => Promise<T>, store: (v: T) => Promise<unknown>) {
  const [value, setValue] = useState<T | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<T | null>(null);
  const dirty = useRef(false);
  useEffect(() => {
    load().then(v => {
      latest.current = v;
      setValue(v);
    }, e => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = useSerialSave(async () => {
    if (!dirty.current || !latest.current) return;
    dirty.current = false;
    setStatus('saving');
    setError(null);
    try {
      await store(latest.current);
      setStatus('saved');
    } catch (e) {
      dirty.current = true;
      setError((e as Error).message);
      setStatus('idle');
    }
  });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const edit = (patch: Partial<T>) => {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...patch };
    dirty.current = true;
    setValue(latest.current);
    clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_AFTER_MS);
  };
  // Closing Settings: save whatever hasn't been yet.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      save();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Save now rather than after the pause.
  const flush = () => {
    clearTimeout(timer.current);
    return save();
  };
  // Take in what the server worked out, without it counting as an edit.
  const sync = (fn: (v: T) => T) => {
    if (!latest.current) return;
    latest.current = fn(latest.current);
    setValue(latest.current);
  };
  return { value, edit, flush, sync, status, error };
}

// Run saves one after another, so a later save can't land before an earlier one.
function useSerialSave(run: () => Promise<void>) {
  const chain = useRef(Promise.resolve());
  const fn = useRef(run);
  fn.current = run;
  return () => {
    chain.current = chain.current.then(() => fn.current());
    return chain.current;
  };
}

function SaveStatus({ status, error }: { status: 'idle' | 'saving' | 'saved'; error: string | null }) {
  if (error) return <span className="custom-error">{error}</span>;
  if (status === 'idle') return null;
  return (
    <span className="ssaved">
      {status === 'saving' ? (
        'Saving...'
      ) : (
        <>
          <Check size={14} /> Saved
        </>
      )}
    </span>
  );
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
  // Saves a moment after you stop typing, when you leave the field, and if
  // Settings closes while you're still in it.
  const latest = useRef({ text, value, onSave });
  latest.current = { text, value, onSave };
  const flush = () => {
    const l = latest.current;
    if (l.text.trim() !== l.value) l.onSave(l.text.trim());
  };
  useEffect(() => {
    if (text.trim() === value) return;
    const t = setTimeout(flush, SAVE_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flush(), []);
  return (
    <input
      className="srow2-input"
      value={text}
      placeholder={placeholder}
      onChange={e => setText(e.target.value)}
      onBlur={flush}
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
  // Several fields can save at once (e.g. on close), so each merges into the
  // latest copy rather than the one it rendered with, and saves run in order.
  const latest = useRef<Person | null>(null);
  latest.current ??= p;
  const save = useSerialSave(async () => {
    try {
      await savePerson(latest.current!);
    } catch (e) {
      setError((e as Error).message);
    }
  });
  const update = (patch: Partial<Person>) => {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...patch };
    setP(latest.current);
    setError(null);
    save();
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
            {/* One name for people and agents alike; clearing call_me retires the old separate field. */}
            <Row label="Display name">
              <SavedInput
                value={p.full_name || p.call_me || ''}
                placeholder={p.name}
                onSave={full_name => update({ full_name, call_me: '' })}
              />
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
  // Settings closing mid-memory: keep what you typed.
  const latest = useRef({ text, notes, onChange });
  latest.current = { text, notes, onChange };
  useEffect(
    () => () => {
      const l = latest.current;
      if (l.text.trim()) l.onChange([...l.notes, l.text.trim()]);
    },
    [],
  );
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
  const startBtn = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (org) return <OrganizationProfile name={org.name} />;
  if (!state.me)
    return (
      <section className="ssection">
        <h2>Organization</h2>
        <div className="sorg-center">
          <p className="sorg-convert">Sign in to create or join an organization</p>
          <button className="sbtn primary" onClick={openSignIn}>
            Sign in
          </button>
        </div>
      </section>
    );

  // The chat asks for the name along with everything else; then it's made, hosted here.
  const start = () =>
    chat.start('', startBtn.current, async name => {
      setError(null);
      try {
        const made = await createOrganisation(name, setStep);
        onOrgChange();
        switchAgency(made.id);
      } catch (e) {
        setStep(null);
        setError((e as Error).message);
      }
    });
  const mine = ownOrg();
  const others = teamOrgs().filter(o => o !== mine);
  return (
    <section className="ssection">
      <h2>Organization</h2>
      {mine ? (
        <div className="sorg-row">
          <span>
            You host <strong>{mine.name}</strong>
          </span>
          <button className="sbtn" onClick={() => switchAgency(mine.id)}>
            Open
          </button>
        </div>
      ) : step ? (
        <p className="snotes-empty">{step}...</p>
      ) : (
        <div className="sorg-row">
          <span>Create an organization, hosted on this computer</span>
          <button className="sbtn primary" ref={startBtn} onClick={start}>
            Get started
          </button>
        </div>
      )}
      {error && <p className="custom-error">{error}</p>}
      {others.map(o => (
        <div className="sorg-row" key={o.id}>
          <span>
            <strong>{o.name}</strong> <span className="muted">{o.role === 'admin' ? 'Admin' : 'Member'}</span>
          </span>
          <button className="sbtn" onClick={() => switchAgency(o.id)}>
            Open
          </button>
        </div>
      ))}
      <JoinWithCode />
      {chat.element}
    </section>
  );
}

function JoinWithCode() {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<{ org: string; invitedBy: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!preview) setPreview(await previewInvite(code.trim()));
      else switchAgency((await joinWithCode(code.trim())).orgId);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="sfield">
      <span className="sfield-label">Join with a code</span>
      <div className="sinline">
        <input
          value={code}
          spellCheck={false}
          placeholder="Invite code"
          onChange={e => {
            setCode(e.target.value);
            setPreview(null);
          }}
          onKeyDown={e => e.key === 'Enter' && code.trim() && go()}
        />
        <button className={`sbtn${preview ? ' primary' : ''}`} disabled={!code.trim() || busy} onClick={go}>
          {preview ? `Join ${preview.org}` : 'Continue'}
        </button>
      </div>
      {preview && (
        <span className="sfield-hint">
          {preview.invitedBy} invited you as {preview.role === 'admin' ? 'an admin' : 'a member'}.
        </span>
      )}
      {error && <span className="custom-error">{error}</span>}
    </div>
  );
}

// The people in it (our backend), its invites, and leaving or deleting it.
function OrgPeople() {
  const org = teamOrgs().find(o => o.id === state.agency)!;
  const [people, setPeople] = useState<Member[]>(state.members);
  const [pending, setPending] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRoleChoice] = useState<'member' | 'admin'>('member');
  const [made, setMade] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const manage = org.role !== 'member';
  const load = () => {
    listMembers(org.id).then(setPeople, () => {});
    if (manage) listInvites(org.id).then(setPending, () => {});
  };
  useEffect(load, [org.id, manage]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const me = state.me?.user.id;
  const label = (r: string) => (r === 'owner' ? 'Owner' : r === 'admin' ? 'Admin' : 'Member');
  return (
    <>
      <h3>Members</h3>
      <ul className="smembers">
        {people.map(m => (
          <li key={m.userId}>
            <MemberAvatar member={m.userId === me ? ACCOUNT.name : m.name} size={26} />
            <span className="smember-name">
              {m.userId === me ? ACCOUNT.name : m.name}
              {m.userId === me && <span className="muted"> (you)</span>}
            </span>
            {org.role === 'owner' && m.role !== 'owner' ? (
              <select className="srole" value={m.role} onChange={e => act(() => setRole(org.id, m.userId, e.target.value as 'admin' | 'member'))}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            ) : (
              <span className="muted">{label(m.role)}</span>
            )}
            {(org.role === 'owner' ? m.role !== 'owner' : org.role === 'admin' && m.role === 'member') && m.userId !== me && (
              <button className="sicon" aria-label={`Remove ${m.name}`} onClick={() => act(() => removeMember(org.id, m.userId))}>
                <X size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {manage && (
        <div className="sfield">
          <span className="sfield-label">Invite someone</span>
          <div className="sinline">
            <input type="email" value={email} placeholder="Email (optional)" onChange={e => setEmail(e.target.value)} />
            {org.role === 'owner' && (
              <select className="srole" value={role} onChange={e => setRoleChoice(e.target.value as 'member' | 'admin')}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
            <button
              className="sbtn"
              onClick={() =>
                act(async () => {
                  setMade(await createInvite(org.id, email.trim(), role));
                  setEmail('');
                })
              }
            >
              <Plus size={14} /> Invite
            </button>
          </div>
          {made && (
            <span className="sfield-hint">
              Their code: <code className="scode">{made.code}</code>
              {made.email ? ` Only ${made.email} can use it.` : ''} It lasts 14 days.
            </span>
          )}
          {pending.length > 0 && (
            <ul className="sinvites">
              {pending.map(i => (
                <li key={i.code}>
                  <code className="scode">{i.code}</code>
                  <span className="muted">{i.email ?? 'Anyone with the code'}</span>
                  <button className="sicon" aria-label="Revoke" onClick={() => act(() => revokeInvite(i.code))}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="custom-error">{error}</p>}
      <div className="sorg-leave">
        <button className="sbtn" onClick={() => switchAgency('personal')}>
          Back to your agency
        </button>
        {org.role === 'owner' ? (
          <button className="sbtn danger" onClick={() => setConfirming(true)}>
            Delete organization
          </button>
        ) : (
          <button className="sbtn danger" onClick={() => act(async () => (await leaveOrganisation(org.id), switchAgency('personal')))}>
            Leave
          </button>
        )}
      </div>
      {confirming && <DeleteOrgDialog name={org.name} onCancel={() => setConfirming(false)} onConfirm={async () => (await deleteOrganisation(org.id), switchAgency('personal'))} />}
    </>
  );
}

function DeleteOrgDialog({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed.trim() === name;
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm" role="alertdialog" aria-labelledby="delorg-title">
        <h2 id="delorg-title">Delete {name}?</h2>
        <p>Everyone loses access, and its agency stops on this computer. Its files stay here.</p>
        <label className="confirm-label">
          <span>
            Type <strong>{name}</strong> to confirm
          </span>
          <input autoFocus value={typed} disabled={busy} spellCheck={false} onChange={e => setTyped(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
        </label>
        {error && <div className="custom-error">{error}</div>}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="confirm-delete" onClick={go} disabled={!ok || busy}>
            <Trash2 size={14} strokeWidth={2} />
            {busy ? 'Deleting...' : 'Delete organization'}
          </button>
        </div>
      </div>
    </div>
  );
}

const BLANK_PROFILE = (name: string): Profile => ({ name, what_it_does: '', customers: '', offering: '', voice: '', people: [], notes: [] });

// A member's picture: your own photo, or their initial (only yours is kept for now).
function MemberAvatar({ member, size }: { member: string; size: number }) {
  const photo = usePhoto();
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {member === ACCOUNT.name && photo ? <img src={photo} alt="" /> : member.charAt(0)}
    </span>
  );
}

const samePerson = (a: KeyPerson, b: KeyPerson) => a.name.trim() === b.name.trim() && a.role.trim() === b.role.trim();

function OrganizationProfile({ name }: { name: string }) {
  const rec = useRecord<Profile>(
    () => getProfile(name).then(p => p ?? BLANK_PROFILE(name)),
    p => saveProfile(name, p),
  );
  const p = rec.value;

  // Which key people are members: the server checks anyone new or edited (once
  // their row is finished, and on opening, for people the builder added) and
  // says who's linked. Failing is silent - they just show no picture.
  const relink = async () => {
    await rec.flush();
    try {
      const links = await linkKeyPeople(name);
      rec.sync(v => ({ ...v, people: v.people.map(x => ({ ...x, member: links.find(l => samePerson(l, x))?.member ?? x.member })) }));
    } catch {
      // Not linked this time; the next check tries again.
    }
  };
  const loaded = !!p;
  // Members read it; the owner and admins change it (access.ts on the host).
  const readOnly = ACCOUNT.role === 'member';
  useEffect(() => {
    if (loaded && !readOnly) relink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  // Editing a person undoes their link until the server checks them again.
  const editPerson = (i: number, patch: Partial<KeyPerson>) =>
    p && rec.edit({ people: p.people.map((x, j) => (j === i ? { ...x, ...patch, member: undefined } : x)) });
  return (
    <section className="ssection">
      <h2>{name}</h2>
      {!p ? (
        rec.error ? <p className="custom-error">{rec.error}</p> : <p className="snotes-empty">Loading...</p>
      ) : (
        <fieldset className="sreadonly" disabled={readOnly}>
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
          <Field label="Voice">
            <input value={p.voice} onChange={e => rec.edit({ voice: e.target.value })} />
          </Field>
          <div className="sfield">
            <span className="sfield-label">Key people</span>
            <ul className="speople">
              {p.people.map((person, i) => (
                // Leaving the row (not moving between its own fields) finishes the person.
                <li key={i} onBlur={e => !e.currentTarget.contains(e.relatedTarget as Node | null) && relink()}>
                  {person.member ? (
                    <span className="speople-member" title={`${person.member}${person.member === ACCOUNT.name ? ' (you)' : ''} - a member here`}>
                      <MemberAvatar member={person.member} size={26} />
                    </span>
                  ) : (
                    <span className="speople-member" />
                  )}
                  <input value={person.name} placeholder="Name" onChange={e => editPerson(i, { name: e.target.value })} />
                  <input value={person.role} placeholder="Role" onChange={e => editPerson(i, { role: e.target.value })} />
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
          <div className="ssave">
            <SaveStatus status={rec.status} error={rec.error} />
          </div>
        </fieldset>
      )}
      <OrgPeople />
    </section>
  );
}

// --- Usage -------------------------------------------------------------------

const money = (n: number) => `$${n.toFixed(2)}`;

function UsageSection() {
  // This calendar month, from the runner: what each agent's runs cost.
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    getUsage().then(setUsage, () => {});
  }, []);
  const rows = (usage?.agents ?? []).map(a => ({ a, spend: a.monthUsd })).sort((x, y) => y.spend - x.spend || y.a.monthRuns - x.a.monthRuns);
  const total = rows.reduce((s, r) => s + r.spend, 0);
  const runs = rows.reduce((s, r) => s + r.a.monthRuns, 0);
  const unknown = rows.reduce((s, r) => s + r.a.monthUnknownRuns, 0);
  const top = Math.max(...rows.map(r => r.spend), 0.01);
  return (
    <section className="ssection">
      <h2>Usage</h2>
      <p className="slead">This month. Runs on your AI plans and on this computer cost nothing here.</p>
      <div className="stiles">
        <div className="stile">
          <span className="stile-label">Spend</span>
          <span className="stile-value">
            {money(total)}
            {unknown > 0 && <span title={`${unknown} run${unknown === 1 ? '' : 's'} on a model with no known price aren't in this`}>*</span>}
          </span>
        </div>
        <div className="stile">
          <span className="stile-label">Runs</span>
          <span className="stile-value">{runs.toLocaleString()}</span>
        </div>
        <div className="stile">
          <span className="stile-label">Agents</span>
          <span className="stile-value">{rows.length}</span>
        </div>
      </div>
      <SpendLimits />
      <h3>By agent</h3>
      <ul className="susage">
        {rows.map(({ a, spend }) => {
          const Icon = DEPARTMENT_ICON[a.department as keyof typeof DEPARTMENT_ICON] ?? DEPARTMENT_ICON.agency;
          return (
            <li key={a.id} title={`${a.name}: ${money(spend)} over ${a.monthRuns} runs this month${a.monthUnknownRuns ? ` (${a.monthUnknownRuns} at an unknown price)` : ''}`}>
              <span className="susage-name">
                <Icon size={14} strokeWidth={1.75} />
                {a.name}
              </span>
              <span className="susage-bar">
                <span style={{ width: `${(spend / top) * 100}%` }} />
              </span>
              <span className="susage-runs">{a.monthRuns.toLocaleString()} runs</span>
              <span className="susage-spend">
                {money(spend)}
                {a.monthUnknownRuns > 0 && '*'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Daily spending limits (docs/runner.md, "Money and limits"): one for the
// whole organisation and one per agent. Hitting one pauses pay-per-use models
// until tomorrow; plans and local models carry on. Blank = no limit.
function SpendLimits() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    getUsage().then(setUsage, () => {});
  }, []);
  if (!usage) return null;
  const parse = (v: string) => {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
  };
  return (
    <div className="sgroup">
      <h3>Daily spending limits</h3>
      <p className="slead">
        When a limit is reached, agents stop using pay-per-use keys until tomorrow. Plans and local models aren't affected. Leave blank for no limit.
      </p>
      <ul className="slimits">
        <li>
          <span className="slimit-name">Whole organisation</span>
          <span className="slimit-spent">{money(usage.spentTodayUsd)} today</span>
          <CapInput value={usage.orgCapUsd} onSave={v => setOrgCap(parse(v)).catch(() => {})} label="Daily limit for the whole organisation" />
        </li>
        {usage.agents.map(a => (
          <li key={a.id}>
            <span className="slimit-name">{a.name}</span>
            <span className="slimit-spent">{money(a.spentTodayUsd)} today</span>
            <CapInput value={a.capUsd} onSave={v => setAgentRunner(a.id, { spendCapUsd: parse(v) }).catch(() => {})} label={`Daily limit for ${a.name}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// A dollar amount that saves when you leave it (or press Enter).
function CapInput({ value, onSave, label }: { value: number | null; onSave: (v: string) => void; label: string }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const saved = useRef(text);
  const save = () => {
    if (text === saved.current) return;
    saved.current = text;
    onSave(text);
  };
  return (
    <label className="slimit-input">
      <span>$</span>
      <input
        inputMode="decimal"
        placeholder="No limit"
        aria-label={label}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={save}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

// --- Connectors --------------------------------------------------------------

function ConnectorsSection({ onOpenApproval, focus, onFocused }: { onOpenApproval: (id: string) => void; focus?: string | null; onFocused?: () => void }) {
  return (
    <section className="ssection">
      <h2>Connectors</h2>
      <p className="slead">Keys and sign-ins go here - never in a chat with an agent.</p>
      <ModelConnectors />
      <Integrations onOpenApproval={onOpenApproval} focus={focus} onFocused={onFocused} />
    </section>
  );
}
