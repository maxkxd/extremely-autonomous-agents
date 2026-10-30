import { useEffect, useState } from 'react';
import { isAdmin } from './account';
import { getAvailableModels } from './builder';
import type { SettingsSection } from './Settings';

// Settings, at a section, from anywhere (App shows it).
// focus: something in that section to bring into view (Tools: a tool id).
export const openSettings = (section: SettingsSection, focus?: string) => window.dispatchEvent(new CustomEvent('eaa:settings', { detail: { section, focus } }));

// Whether any AI model is connected: null until known. Checked again while there
// are none (a connection made in Settings lifts what was waiting on it).
export function useHasModels() {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => getAvailableModels().then(a => live && setHas(a.some(c => c.models.length > 0)), () => {});
    check();
    const t = window.setInterval(() => has !== true && check(), 3000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [has]);
  return has;
}

// What to do about having none: connect one (Settings > Connectors), or, for an
// organisation's member, ask whoever can.
export function ConnectModel({ title, onGo }: { title: string; onGo?: () => void }) {
  return (
    <div className="no-models">
      <p className="no-models-title">{title}</p>
      {isAdmin() ? (
        <button
          className="sbtn primary no-models-go"
          onClick={() => {
            onGo?.();
            openSettings('connectors');
          }}
        >
          Connect a model
        </button>
      ) : (
        <p className="no-models-sub">Ask the owner or an admin to connect one.</p>
      )}
    </div>
  );
}
