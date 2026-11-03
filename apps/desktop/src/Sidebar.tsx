import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { checkWaitingInvites, currentOrg, myAccountId, myName, onMyName, onWaitingInvites, ownOrg, state, switchAgency, teamOrgs, waitingInvites } from './account';
import { openSignIn } from './SignIn';
import { useDismiss } from './useDismiss';
import { usePhoto } from './photo';
import { useOffline } from './offline';
import { useMoreBelow } from './moreBelow';
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
  // The live name, as beside it: ACCOUNT.name kept the last person's initial after signing in as someone else.
  const name = useSyncExternalStore(onMyName, myName);
  if (!photo) return <Avatar label={name} size={size} />;
  return <img className="avatar" src={photo} alt="" style={{ width: size, height: size, objectFit: 'cover' }} />;
}

// The agency you're in now, by name: your own goes by your display name.
const currentOrgName = () => teamOrgs().find(o => o.id === state.agency)?.name ?? `${myName()}'s agency`;

// Your own agency and each organization you're in; picking one starts the app
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
          <span className="switcher-title" title={current}>{current}</span>
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
                  <span className="option-name" title={c.name}>{c.name}</span>
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

// Agent DMs: yours first, then teammates', newest first in each, the built-ins last
// (the Dashboard keeps its own drag order).
const BUILT_IN_ORDER = ['fleet', 'conductor', 'doctor', 'reviewer'];
function dmOrder(agents: typeof AGENTS) {
  const me = myAccountId();
  const mine = (a: (typeof AGENTS)[number]) => !currentOrg() || !a.ownerId || a.ownerId === me;
  const newest = (x: (typeof AGENTS)[number], y: (typeof AGENTS)[number]) => (y.createdAt ?? 0) - (x.createdAt ?? 0);
  const own = agents.filter(a => !a.builtIn);
  const builtIns = agents.filter(a => a.builtIn).sort((x, y) => (BUILT_IN_ORDER.indexOf(x.id) + 99) % 99 - (BUILT_IN_ORDER.indexOf(y.id) + 99) % 99);
  return [...own.filter(mine).sort(newest), ...own.filter(a => !mine(a)).sort(newest), ...builtIns];
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
  compact = false,
  overlay = false,
  onExpand,
}: {
  view: View;
  onSelect: (v: View) => void;
  width: number;
  onResizeStart: (e: React.PointerEvent) => void;
  approvalsBadge: number | null; // pending approvals waiting on this person (null: not known yet)
  requestsBadge: number | null; // pending requests waiting on this person
  onOpenSettings: (s: SettingsSection) => void;
  onLogOut: () => void;
  // A narrow window: just the icons. The org and account buttons open the full sidebar over the page.
  compact?: boolean;
  overlay?: boolean; // the full sidebar opened over the page from the icons
  onExpand?: () => void;
}) {
  const [dmsOpen, setDmsOpen] = useState(true);
  const off = useOffline();
  const dmList = useRef<HTMLUListElement>(null);
  const moreBelow = useMoreBelow(dmList);
  // Clicking the already-selected nav button replays its icon animation: a new
  // key remounts the icon, which restarts the CSS animation.
  const [replay, setReplay] = useState<Record<string, number>>({});
  const invited = useSyncExternalStore(onWaitingInvites, waitingInvites) > 0;

  return (
    <aside className={`sidebar${compact ? ' compact' : ''}${overlay ? ' overlay' : ''}`} style={{ width }}>
      {!compact && !overlay && <div className="resize-handle" title="Drag to resize" onPointerDown={onResizeStart} />}
      {/* Organizations are optional: signed out, or in none, there's no switcher. */}
      {teamOrgs().length > 0 &&
        (compact ? (
          <button className="switcher org-switcher" title={`${currentOrgName()} - open the sidebar`} onClick={onExpand}>
            <Avatar label={currentOrgName()} size={34} personal={state.agency === 'personal'} />
          </button>
        ) : (
          <OrgPicker onNew={() => onOpenSettings('organization')} />
        ))}

      <nav className="nav-squares">
        {NAV.map(({ view: v, label, Icon, badge: fixedBadge }) => {
          const badge = v === 'approvals' ? approvalsBadge : v === 'requests' ? requestsBadge : fixedBadge;
          return (
            <button
              key={v}
              className={`nav-square${view === v ? ' active' : ''}`}
              title={compact ? label : undefined}
              onClick={() => {
                if (view === v) setReplay(r => ({ ...r, [v]: (r[v] ?? 0) + 1 }));
                onSelect(v);
              }}
            >
              <Icon key={replay[v] ?? 0} size={32} strokeWidth={1.75} />
              <span>{label}</span>
              {badge === null ? <span className="square-badge skel" aria-hidden /> : badge ? <span className="square-badge">{badge}</span> : null}
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
            title={off ?? 'Add agent'}
            disabled={!!off}
            onClick={() => onSelect('new-agent')}
          >
            <Plus size={16} />
          </button>
        </div>

        {dmsOpen && (
          <ul className={`dm-list${moreBelow ? ' more-below' : ''}`} ref={dmList}>
            {/* Everyone in an organization sees every agent (and can talk to the Agency Engineer);
                only an agent's owner or an admin changes it (Dashboard). */}
            {dmOrder(AGENTS).map(a => {
              const v: View = `agent:${a.id}`;
              const DeptIcon = DEPARTMENT_ICON[a.department];
              return (
                <li key={a.id}>
                  <button
                    className={`dm-item${view === v ? ' active' : ''}`}
                    title={compact ? a.name : undefined}
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

      {compact ? (
        <button className="switcher account-switcher" title={`${myName()} - open the sidebar`} onClick={onExpand}>
          <span className="avatar-with-dot">
            <MyAvatar size={34} />
            {invited && <span className="notify-dot on-avatar" aria-label="An invitation is waiting" />}
          </span>
        </button>
      ) : (
        <AccountMenu onOpenSettings={onOpenSettings} onLogOut={onLogOut} />
      )}
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
  const invited = useSyncExternalStore(onWaitingInvites, waitingInvites) > 0;
  useEffect(() => void checkWaitingInvites(), [state.me?.user.email]);
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
                  // An invite waiting: Settings opens where it is.
                  onOpenSettings(invited && section === 'account' ? 'organization' : section);
                }}
              >
                <span className="option-with-avatar">
                  <Icon size={15} className="option-icon" />
                  {label}
                  {invited && section === 'account' && <span className="notify-dot" aria-label="An invitation is waiting" />}
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
                {state.me ? 'Log out' : 'SIGN IN'}
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
        <span className="avatar-with-dot">
          <MyAvatar size={34} />
          {invited && <span className="notify-dot on-avatar" aria-label="An invitation is waiting" title="An invitation is waiting - open Settings" />}
        </span>
        <span className="switcher-text">
          <span className="switcher-title" title={name}>{name}</span>
          <span className="switcher-sub">{ACCOUNT.org ? `${{ owner: 'Owner', admin: 'Admin', member: 'Member' }[currentOrg()?.role ?? 'member']} of ${ACCOUNT.org.name}` : (state.me?.user.email ?? 'Not signed in')}</span>
        </span>
        {state.me && <ChevronsUpDown size={16} className="muted" />}
      </button>
      {/* No account needed for your own agency; one is for organizations. */}
      {!state.me && (
        <button className="sbtn signup-btn account-signup" onClick={e => openSignIn('up', e.currentTarget)}>
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
