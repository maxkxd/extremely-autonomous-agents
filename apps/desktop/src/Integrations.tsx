import { useEffect, useState } from 'react';
import { ExternalLink, Globe, Plus } from 'lucide-react';
import { SpinButton } from './ModelConnectors';
import {
  addMcpIntegration,
  connectIntegration,
  disconnectIntegration,
  getIntegrations,
  openAgentBrowser,
  removeIntegration,
  type IntegrationsView,
  type IntegrationView,
} from './builder';

// Settings -> Connectors -> Integrations (docs/integrations.md): the services
// agents' tools run on. Web search is one service among several (agents use
// whichever is connected); anything else is added as an MCP server by its
// address, or later by the Fleet Engineer. Keys go here, never in a chat.
export function Integrations() {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => getIntegrations().then(setView, e => setError((e as Error).message));
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, []);
  if (error && !view) return <p className="custom-error">{error}</p>;
  if (!view) return null;
  const search = view.integrations.filter(i => i.tools.some(t => t.id === 'web.web_search'));
  const others = view.integrations.filter(i => !search.includes(i));
  return (
    <>
      <div className="sgroup">
        <h3>Web search</h3>
        <p className="slead">Agents search the web through one of these. Connect any one; they all work the same way.</p>
        <ul className="sconnectors">
          {search.map(i => (
            <IntegrationRow key={i.id} i={i} refresh={refresh} open={openId === i.id} setOpen={o => setOpenId(o ? i.id : null)} />
          ))}
        </ul>
      </div>
      <div className="sgroup">
        <h3>Integrations</h3>
        <p className="slead">Other services agents can use. Add any service that has an MCP server by its address.</p>
        <ul className="sconnectors">
          {others.map(i => (
            <IntegrationRow key={i.id} i={i} refresh={refresh} open={openId === i.id} setOpen={o => setOpenId(o ? i.id : null)} />
          ))}
          <AddMcp refresh={refresh} open={openId === 'add'} setOpen={o => setOpenId(o ? 'add' : null)} />
        </ul>
        {view.problems.map(p => (
          <p key={p.file} className="custom-error">
            {p.file} couldn't be loaded: {p.error}
          </p>
        ))}
      </div>
      <AgentBrowser status={view.profile} />
    </>
  );
}

function IntegrationRow({ i, refresh, open, setOpen }: { i: IntegrationView; refresh: () => void; open: boolean; setOpen: (o: boolean) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const connect = async () => {
    if (i.needsKey && !key.trim()) return;
    if (await run(() => connectIntegration(i.id, key))) {
      setKey('');
      setOpen(false);
    }
  };
  // An MCP server's test already says how many tools it found.
  const tools = i.kind === 'http' && i.tools.length ? `${i.tools.length} tool${i.tools.length === 1 ? '' : 's'}` : '';
  const sub = i.connected
    ? [i.test?.message, tools].filter(Boolean).join(' · ')
    : i.test && !i.test.ok
      ? i.test.message
      : i.what;
  return (
    <li className={open || error ? 'with-form' : undefined}>
      <span className="sconn-name">
        {i.name}
        {i.kind === 'mcp' && <span className="sint-kind">MCP</span>}
      </span>
      <span className={`sconn-what${!i.connected && i.test && !i.test.ok ? ' sint-bad' : ''}`}>{sub}</span>
      <span className="sint-actions">
        {i.connected ? (
          <>
            <SpinButton spinning={busy} onClick={() => run(() => connectIntegration(i.id))} title="Check it still works">
              Test
            </SpinButton>
            <SpinButton spinning={false} onClick={() => run(() => disconnectIntegration(i.id))}>
              Disconnect
            </SpinButton>
          </>
        ) : open ? null : i.needsKey ? (
          <button className="sbtn" onClick={() => setOpen(true)}>
            Connect
          </button>
        ) : (
          <SpinButton spinning={busy} onClick={() => run(() => connectIntegration(i.id))}>
            Connect
          </SpinButton>
        )}
        {!i.shipped && !open && (
          <button className="sbtn danger" onClick={() => run(() => removeIntegration(i.id))} disabled={busy}>
            Remove
          </button>
        )}
      </span>
      {(open || error) && (
        <div className="mform sint-form">
          {open && (
            <>
              <input
                className="srow2-input mwide"
                type="password"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder="API key"
                onChange={e => {
                  setKey(e.target.value);
                  setError(null);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') connect();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
              <div className="mform-actions">
                {i.keyUrl && (
                  <a className="slink" href={i.keyUrl} target="_blank" rel="noreferrer">
                    Get a key <ExternalLink size={12} />
                  </a>
                )}
                <button className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
                <SpinButton className="sbtn primary" spinning={busy} onClick={connect} disabled={!key.trim()}>
                  Connect
                </SpinButton>
              </div>
            </>
          )}
          {error && <span className="custom-error">{error}</span>}
        </div>
      )}
    </li>
  );
}

// Adding a remote MCP server: its address, and how it signs in.
function AddMcp({ refresh, open, setOpen }: { refresh: () => void; open: boolean; setOpen: (o: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer'>('none');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await addMcpIntegration({ url: url.trim(), name: name.trim() || undefined, auth, key: auth === 'bearer' ? key : undefined });
      if (!r.ok) setError(r.message);
      else {
        setUrl('');
        setName('');
        setKey('');
        setOpen(false);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  if (!open)
    return (
      <li>
        <span className="sconn-name">Add an MCP server</span>
        <span className="sconn-what">Any service with a remote MCP server, by its address</span>
        <span className="sint-actions">
          <button className="sbtn" onClick={() => setOpen(true)}>
            <Plus size={14} /> Add
          </button>
        </span>
      </li>
    );
  return (
    <li className="with-form">
      <span className="sconn-name">Add an MCP server</span>
      <span className="sconn-what">Its tools are found when it connects</span>
      <span className="sint-actions" />
      <div className="mform sint-form">
        <input className="srow2-input mwide" autoFocus value={url} placeholder="Address, e.g. https://mcp.example.com/mcp" onChange={e => setUrl(e.target.value)} />
        <input className="srow2-input mwide" value={name} placeholder="Name (optional)" onChange={e => setName(e.target.value)} />
        <div className="sint-auth">
          <label>
            <input type="radio" checked={auth === 'none'} onChange={() => setAuth('none')} /> No sign-in
          </label>
          <label>
            <input type="radio" checked={auth === 'bearer'} onChange={() => setAuth('bearer')} /> API key / token
          </label>
        </div>
        {auth === 'bearer' && (
          <input className="srow2-input mwide" type="password" autoComplete="off" value={key} placeholder="Key or token" onChange={e => setKey(e.target.value)} />
        )}
        <div className="mform-actions">
          <button className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
          <SpinButton className="sbtn primary" spinning={busy} onClick={add} disabled={!url.trim() || (auth === 'bearer' && !key.trim())}>
            Add
          </SpinButton>
        </div>
        {error && <span className="custom-error">{error}</span>}
      </div>
    </li>
  );
}

// The agents' signed-in browser: a separate profile the person signs into.
function AgentBrowser({ status }: { status: IntegrationsView['profile'] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await openAgentBrowser();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sgroup">
      <h3>Signed-in browser for agents</h3>
      <p className="slead">
        A separate Edge or Chrome profile just for agents. Sign it in to the sites you want agents to use as you - your own browser, passwords
        and history stay out of it. Clicking and typing in it needs your approval unless an agent's job allows otherwise.
      </p>
      <ul className="sconnectors">
        <li>
          <span className="sconn-name">
            <Globe size={14} /> Agent profile
          </span>
          <span className="sconn-what">
            {status.open ? 'Open on your screen - sign in, then close the window' : status.inUse ? 'In use by an agent right now' : 'Opens in a window on this computer'}
          </span>
          <span className="sint-actions">
            <SpinButton spinning={busy} onClick={open} disabled={status.open || status.inUse}>
              Open to sign in
            </SpinButton>
          </span>
        </li>
      </ul>
      {error && <p className="custom-error">{error}</p>}
    </div>
  );
}
