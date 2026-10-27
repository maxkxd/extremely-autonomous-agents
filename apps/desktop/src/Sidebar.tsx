import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  LayoutDashboard,
  CircleCheckBig,
  Inbox,
  Plus,
  Code,
  Megaphone,
  TrendingUp,
  Calculator,
  Search,
  Settings2,
} from 'lucide-react';
import { ACCOUNT, AGENTS, totalOpenApprovals, totalOpenRequests, type Department } from './data';

export type View = 'dashboard' | 'approvals' | 'requests' | `agent:${string}`;

// The only per-agent symbol: a small monochrome icon for the agent's department.
export const DEPARTMENT_ICON: Record<Department, typeof Code> = {
  engineering: Code,
  marketing: Megaphone,
  sales: TrendingUp,
  finance: Calculator,
  research: Search,
  operations: Settings2,
};

const NAV: { view: View; label: string; Icon: typeof LayoutDashboard; badge?: number }[] = [
  { view: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { view: 'approvals', label: 'Approvals', Icon: CircleCheckBig, badge: totalOpenApprovals },
  { view: 'requests', label: 'Requests', Icon: Inbox, badge: totalOpenRequests },
];

function Avatar({ label, size = 28 }: { label: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {label.charAt(0)}
    </span>
  );
}

export function Sidebar({
  view,
  onSelect,
  width,
  onResizeStart,
}: {
  view: View;
  onSelect: (v: View) => void;
  width: number;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const [dmsOpen, setDmsOpen] = useState(true);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="resize-handle" title="Drag to resize" onPointerDown={onResizeStart} />
      {/* Organizations are optional; solo accounts get no org switcher. */}
      {ACCOUNT.org && (
        <button className="switcher org-switcher" title="Switch organization">
          <Avatar label={ACCOUNT.org.name} size={34} />
          <span className="switcher-text">
            <span className="switcher-title">{ACCOUNT.org.name}</span>
            <span className="switcher-sub">Organization</span>
          </span>
          <ChevronsUpDown size={16} className="muted" />
        </button>
      )}

      <nav className="nav-squares">
        {NAV.map(({ view: v, label, Icon, badge }) => (
          <button
            key={v}
            className={`nav-square${view === v ? ' active' : ''}`}
            onClick={() => onSelect(v)}
          >
            <Icon size={32} strokeWidth={1.75} />
            <span>{label}</span>
            {badge ? <span className="square-badge">{badge}</span> : null}
          </button>
        ))}
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
