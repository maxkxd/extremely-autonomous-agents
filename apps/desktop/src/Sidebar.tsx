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

export type View = 'dashboard' | 'approvals' | 'requests' | `agent:${string}`;

type Department = 'engineering' | 'marketing' | 'sales' | 'finance' | 'research' | 'operations';

// The only per-agent symbol: a small monochrome icon for the agent's department.
const DEPARTMENT_ICON: Record<Department, typeof Code> = {
  engineering: Code,
  marketing: Megaphone,
  sales: TrendingUp,
  finance: Calculator,
  research: Search,
  operations: Settings2,
};

// Placeholder agents for the UI only - not the real agency roster.
const EXAMPLE_AGENTS: { id: string; name: string; department: Department; unread?: number }[] = [
  { id: 'research', name: 'Research Assistant', department: 'research' },
  { id: 'inbox', name: 'Inbox Triage', department: 'operations', unread: 1 },
  { id: 'writer', name: 'Content Writer', department: 'marketing' },
  { id: 'leads', name: 'Lead Finder', department: 'sales' },
  { id: 'books', name: 'Bookkeeper', department: 'finance' },
  { id: 'reviewer', name: 'Code Reviewer', department: 'engineering' },
];

const NAV: { view: View; label: string; Icon: typeof LayoutDashboard; badge?: number }[] = [
  { view: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { view: 'approvals', label: 'Approvals', Icon: CircleCheckBig, badge: 3 },
  { view: 'requests', label: 'Requests', Icon: Inbox },
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
      <button className="switcher org-switcher" title="Switch organization">
        <Avatar label="Acme Ventures" size={34} />
        <span className="switcher-text">
          <span className="switcher-title">Acme Ventures</span>
          <span className="switcher-sub">Organization</span>
        </span>
        <ChevronsUpDown size={16} className="muted" />
      </button>

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
            {EXAMPLE_AGENTS.map(a => {
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
                    {a.unread ? <span className="pill">{a.unread}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <button className="switcher account-switcher" title="Switch account">
        <Avatar label="Max" size={34} />
        <span className="switcher-text">
          <span className="switcher-title">Max</span>
          <span className="switcher-sub">Personal account</span>
        </span>
        <ChevronsUpDown size={16} className="muted" />
      </button>
    </aside>
  );
}

export function viewLabel(view: View): string {
  if (view.startsWith('agent:')) {
    const a = EXAMPLE_AGENTS.find(x => `agent:${x.id}` === view);
    return a ? a.name : 'Agent';
  }
  return NAV.find(n => n.view === view)?.label ?? '';
}
