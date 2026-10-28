import { useRef, useState } from 'react';
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
} from 'lucide-react';
import { ACCOUNT, AGENTS, ORGANIZATIONS, type Department } from './data';
import { useDismiss } from './useDismiss';

export type View = 'dashboard' | 'approvals' | 'requests' | `agent:${string}`;

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

function Avatar({ label, size = 28 }: { label: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {label.charAt(0)}
    </span>
  );
}

// Switching orgs and creating one are UI only for now.
function OrgPicker({ initial }: { initial: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className={`org-picker${open ? ' open' : ''}`} ref={ref}>
      <button
        className="switcher org-switcher"
        title="Switch organization"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Avatar label={current} size={34} />
        <span className="switcher-text">
          <span className="switcher-title">{current}</span>
          <span className="switcher-sub">Organization</span>
        </span>
        <ChevronsUpDown size={16} className="muted" />
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {ORGANIZATIONS.map(name => (
            <li key={name}>
              <button
                role="option"
                aria-selected={name === current}
                className="dropdown-option"
                onClick={() => {
                  setCurrent(name);
                  setOpen(false);
                }}
              >
                <span className="option-with-avatar">
                  <Avatar label={name} size={22} />
                  {name}
                </span>
                {name === current && <Check size={15} />}
              </button>
            </li>
          ))}
          <li className="dropdown-sep" role="separator" />
          <li>
            <button className="dropdown-option" onClick={() => setOpen(false)}>
              <span className="option-with-avatar">
                <Plus size={15} className="option-icon" />
                New organization
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
}: {
  view: View;
  onSelect: (v: View) => void;
  width: number;
  onResizeStart: (e: React.PointerEvent) => void;
  approvalsBadge: number; // pending approvals waiting on this person
  requestsBadge: number; // pending requests waiting on this person
}) {
  const [dmsOpen, setDmsOpen] = useState(true);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="resize-handle" title="Drag to resize" onPointerDown={onResizeStart} />
      {/* Organizations are optional; solo accounts get no org switcher. */}
      {ACCOUNT.org && <OrgPicker initial={ACCOUNT.org.name} />}

      <nav className="nav-squares">
        {NAV.map(({ view: v, label, Icon, badge: fixedBadge }) => {
          const badge = v === 'approvals' ? approvalsBadge : v === 'requests' ? requestsBadge : fixedBadge;
          return (
            <button
              key={v}
              className={`nav-square${view === v ? ' active' : ''}`}
              onClick={() => onSelect(v)}
            >
              <Icon size={32} strokeWidth={1.75} />
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
          {/* Add-agent flow not built yet - UI only. */}
          <button className="icon-btn" title="Add agent">
            <Plus size={16} />
          </button>
        </div>

        {dmsOpen && (
          <ul className="dm-list">
            {AGENTS.map(a => {
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

      <button className="switcher account-switcher" title="Switch account">
        <Avatar label={ACCOUNT.name} size={34} />
        <span className="switcher-text">
          <span className="switcher-title">{ACCOUNT.name}</span>
          <span className="switcher-sub">{ACCOUNT.org ? `Member of ${ACCOUNT.org.name}` : 'Personal account'}</span>
        </span>
        <ChevronsUpDown size={16} className="muted" />
      </button>
    </aside>
  );
}

export function viewLabel(view: View): string {
  if (view.startsWith('agent:')) {
    const a = AGENTS.find(x => `agent:${x.id}` === view);
    return a ? a.name : 'Agent';
  }
  return NAV.find(n => n.view === view)?.label ?? '';
}
