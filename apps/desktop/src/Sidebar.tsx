import { useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Check,
  LayoutDashboard,
  CircleCheckBig,
  Wrench,
  Plus,
  Code,
  Megaphone,
  TrendingUp,
  Calculator,
  Search,
  Settings2,
  Hammer,
  Settings,
  Plug,
  Gauge,
  LogOut,
  UserRound,
} from 'lucide-react';
import { ACCOUNT, AGENTS, type Department } from './data';
import { currentOrg, isAdmin, myAccountId, myName, onMyName, ownOrg, state, switchAgency, teamOrgs } from './account';
import { openSignIn } from './SignIn';
import { useDismiss } from './useDismiss';
import { usePhoto } from './photo';
import type { SettingsSection } from './Settings';

export type View = 'dashboard' | 'approvals' | 'requests' | 'new-agent' | `agent:${string}`;

// The only per-agent symbol: a small monochrome icon for the agent's department.
export const DEPARTMENT_ICON: Record<Department, typeof Code> = {
  engineering: Code,
  marketing: Megaphone,
  sales: TrendingUp,
  finance: Calculator,
  research: Search,
  operations: Settings2,
  agency: Hammer,
};

const NAV: { view: View; label: string; Icon: typeof LayoutDashboard; badge?: number }[] = [
  { view: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { view: 'approvals', label: 'Approvals', Icon: CircleCheckBig }, // badge comes from live pending approvals
  { view: 'requests', label: 'Requests', Icon: Wrench }, // badge comes from live pending requests
];

// personal: your own agency, shown as a little person rather than a letter.
function Avatar({ label, size = 28, personal = false }: { label: string; size?: number; personal?: boolean }) {
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {personal ? <UserRound size={Math.round(size * 0.55)} strokeWidth={2} /> : label.charAt(0)}
    </span>
  );
}

// Your own avatar: your profile photo once you've set one (Settings > Account).
function MyAvatar({ size }: { size: number }) {
  const photo = usePhoto();
  if (!photo) return <Avatar label={ACCOUNT.name} size={size} />;
  return <img className="avatar" src={photo} alt="" style={{ width: size, height: size, objectFit: 'cover' }} />;
}

// Your own agency and each organisation you're in; picking one starts the app
// in it. "New organization" (or joining one) opens Settings.
function OrgPicker({ onNew }: { onNew: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  // Your own agency goes by your display name (Settings > Account), kept in step as it changes.
  const personal = `${useSyncExternalStore(onMyName, myName)}'s agency`;
  const choices = [{ id: 'personal', name: personal }, ...teamOrgs().map(o => ({ id: o.id, name: o.name }))];
  const current = choices.find(c => c.id === state.agency)?.name ?? personal;

  return (
    <div className={`org-picker${open ? ' open' : ''}`} ref={ref}>
      <button
        className="switcher org-switcher"
        title="Switch organization"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Avatar label={current} size={34} personal={state.agency === 'personal'} />
        <span className="switcher-text">
          <span className="switcher-title">{current}</span>
          <span className="switcher-sub">{state.agency === 'personal' ? 'Personal' : 'Organization'}</span>
        </span>
        <ChevronsUpDown size={16} className="muted" />
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {choices.map(c => (
            <li key={c.id}>
              <button
                role="option"
                aria-selected={c.id === state.agency}
                className="dropdown-option"
                onClick={() => {
                  setOpen(false);
                  if (c.id !== state.agency) switchAgency(c.id);
                }}
              >
                <span className="option-with-avatar">
                  <Avatar label={c.name} size={22} personal={c.id === 'personal'} />
                  {c.name}
                </span>
                {c.id === state.agency && <Check size={15} />}
              </button>
            </li>
          ))}
          <li className="dropdown-sep" role="separator" />
          <li>
            <button
              className="dropdown-option"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
            >
              <span className="option-with-avatar">
                <Plus size={15} className="option-icon" />
                {ownOrg() ? 'Join an organization' : 'New organization'}
              </span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

export function Sidebar({
  view,
  onSelect,
  width,
  onResizeStart,
  approvalsBadge,
  requestsBadge,
  onOpenSettings,
  onLogOut,
}: {
  view: View;
  onSelect: (v: View) => void;
  width: number;
  onResizeStart: (e: React.PointerEvent) => void;
  approvalsBadge: number; // pending approvals waiting on this person
  requestsBadge: number; // pending requests waiting on this person
  onOpenSettings: (s: SettingsSection) => void;
  onLogOut: () => void;
}) {
  const [dmsOpen, setDmsOpen] = useState(true);
  // Clicking the already-selected nav button replays its icon animation: a new
  // key remounts the icon, which restarts the CSS animation.
  const [replay, setReplay] = useState<Record<string, number>>({});

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="resize-handle" title="Drag to resize" onPointerDown={onResizeStart} />
      {/* Organizations are optional: signed out, or in none, there's no switcher. */}
      {teamOrgs().length > 0 && <OrgPicker onNew={() => onOpenSettings('organization')} />}

      <nav className="nav-squares">
        {NAV.map(({ view: v, label, Icon, badge: fixedBadge }) => {
          const badge = v === 'approvals' ? approvalsBadge : v === 'requests' ? requestsBadge : fixedBadge;
          return (
            <button
              key={v}
              className={`nav-square${view === v ? ' active' : ''}`}
              onClick={() => {
                if (view === v) setReplay(r => ({ ...r, [v]: (r[v] ?? 0) + 1 }));
                onSelect(v);
              }}
            >
              <Icon key={replay[v] ?? 0} size={32} strokeWidth={1.75} />
              <span>{label}</span>
              {badge ? <span className="square-badge">{badge}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="dms">
        <div className="section-row">
          <button className="section-toggle" onClick={() => setDmsOpen(o => !o)}>
            {dmsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Agent DMs</span>
          </button>
          {/* Opens the New agent page (agent packs + build your own). */}
          <button
            className={`icon-btn${view === 'new-agent' ? ' on' : ''}`}
            title="Add agent"
            onClick={() => onSelect('new-agent')}
          >
            <Plus size={16} />
          </button>
        </div>

        {dmsOpen && (
          <ul className="dm-list">
            {/* In an organisation, a member's own agents; the owner and admins see every one (the host checks too). */}
            {AGENTS.filter(a => !currentOrg() || isAdmin() || (!!a.ownerId && a.ownerId === myAccountId())).map(a => {
              const v: View = `agent:${a.id}`;
              const DeptIcon = DEPARTMENT_ICON[a.department];
              return (
                <li key={a.id}>
                  <button
                    className={`dm-item${view === v ? ' active' : ''}`}
                    onClick={() => onSelect(v)}
                  >
                    <DeptIcon size={15} strokeWidth={1.75} className="dept-icon" aria-label={a.department} />
                    <span className="dm-name">{a.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AccountMenu onOpenSettings={onOpenSettings} onLogOut={onLogOut} />
    </aside>
  );
}

// Each opens Settings at its section.
const ACCOUNT_ITEMS: { label: string; Icon: typeof Settings; section: SettingsSection }[] = [
  { label: 'Settings', Icon: Settings, section: 'account' },
  { label: 'Connectors', Icon: Plug, section: 'connectors' },
  { label: 'Usage', Icon: Gauge, section: 'usage' },
];

// Same joined dropdown as the org picker, opening upward from the sidebar foot.
function AccountMenu({ onOpenSettings, onLogOut }: { onOpenSettings: (s: SettingsSection) => void; onLogOut: () => void }) {
  const [open, setOpen] = useState(false);
  // The name you go by (Settings > Account), kept in step as it changes.
  const name = useSyncExternalStore(onMyName, myName);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className={`account-picker${open ? ' open' : ''}`} ref={ref}>
      {open && (
        <ul className="dropdown-menu" role="menu">
          {ACCOUNT_ITEMS.map(({ label, Icon, section }) => (
            <li key={label}>
              <button
                role="menuitem"
                className="dropdown-option"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings(section);
                }}
              >
                <span className="option-with-avatar">
                  <Icon size={15} className="option-icon" />
                  {label}
                </span>
              </button>
            </li>
          ))}
          <li className="dropdown-sep" role="separator" />
          <li>
            <button
              role="menuitem"
              className="dropdown-option"
              onClick={() => {
                setOpen(false);
                onLogOut();
              }}
            >
              <span className="option-with-avatar">
                <LogOut size={15} className="option-icon" />
                {state.me ? 'Log out' : 'Sign in'}
              </span>
            </button>
          </li>
        </ul>
      )}
      <button
        className="switcher account-switcher"
        title="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <MyAvatar size={34} />
        <span className="switcher-text">
          <span className="switcher-title">{name}</span>
          <span className="switcher-sub">{ACCOUNT.org ? `${{ owner: 'Owner', admin: 'Admin', member: 'Member' }[currentOrg()?.role ?? 'member']} of ${ACCOUNT.org.name}` : (state.me?.user.email ?? 'Not signed in')}</span>
        </span>
        {state.me && <ChevronsUpDown size={16} className="muted" />}
      </button>
      {/* No account needed for your own agency; one is for organisations. */}
      {!state.me && (
        <button className="sbtn account-signup" onClick={e => openSignIn('up', e.currentTarget)}>
          SIGN UP
        </button>
      )}
    </div>
  );
}

export function viewLabel(view: View): string {
  if (view === 'new-agent') return 'New agent';
  if (view.startsWith('agent:')) {
    const a = AGENTS.find(x => `agent:${x.id}` === view);
    return a ? a.name : 'Agent';
  }
  return NAV.find(n => n.view === view)?.label ?? '';
}
