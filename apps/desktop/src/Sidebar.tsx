import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  LayoutDashboard,
  CircleCheckBig,
  Inbox,
  Plus,
} from 'lucide-react';

export type View = 'dashboard' | 'approvals' | 'requests' | `agent:${string}`;

type AgentStatus = 'running' | 'idle' | 'needs-you';

// Placeholder agents for the UI only - not the real agency roster.
const EXAMPLE_AGENTS: { id: string; name: string; color: string; status: AgentStatus }[] = [
  { id: 'research', name: 'Research Assistant', color: '#7c6cf2', status: 'running' },
  { id: 'inbox', name: 'Inbox Triage', color: '#2fb383', status: 'needs-you' },
  { id: 'writer', name: 'Content Writer', color: '#e0864a', status: 'idle' },
  { id: 'books', name: 'Bookkeeper', color: '#3b9ee0', status: 'idle' },
  { id: 'reviewer', name: 'Code Reviewer', color: '#d65b8a', status: 'running' },
];

const NAV: { view: View; label: string; Icon: typeof LayoutDashboard; badge?: number }[] = [
  { view: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { view: 'approvals', label: 'Approvals', Icon: CircleCheckBig, badge: 3 },
  { view: 'requests', label: 'Requests', Icon: Inbox },
];

function Avatar({ label, color, size = 28 }: { label: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size }}>
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
        <Avatar label="Acme Ventures" color="#7c6cf2" size={34} />
        <span className="switcher-text">
          <span className="switcher-title">Acme Ventures</span>
          <span className="switcher-sub">Organization</span>
        </span>
        <ChevronsUpDown size={16} className="muted" />
      </button>

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
              return (
                <li key={a.id}>
                  <button
                    className={`dm-item${view === v ? ' active' : ''}`}
                    onClick={() => onSelect(v)}
                  >
                    <span className="dm-avatar">
                      <Avatar label={a.name} color={a.color} size={24} />
                      <span className={`status-dot ${a.status}`} />
                    </span>
                    <span className="dm-name">{a.name}</span>
                    {a.status === 'needs-you' && <span className="pill">1</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <nav className="nav-squares">
        {NAV.map(({ view: v, label, Icon, badge }) => (
          <button
            key={v}
            className={`nav-square${view === v ? ' active' : ''}`}
            onClick={() => onSelect(v)}
          >
            <Icon size={30} strokeWidth={1.75} />
            <span>{label}</span>
            {badge ? <span className="square-badge">{badge}</span> : null}
          </button>
        ))}
      </nav>

      <button className="switcher account-switcher" title="Switch account">
        <Avatar label="Max" color="#3b9ee0" size={34} />
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
