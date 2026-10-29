import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe, Plus } from 'lucide-react';
import { SpinButton } from './ModelConnectors';
import {
  addMcpIntegration,
  connectIntegration,
  disconnectIntegration,
  getAgencyMcp,
  getEvents,
  getCodePlugins,
  getIntegrations,
  openAgentBrowser,
  setCodePlugins,
  removeIntegration,
  setTunnel,
  setWebhookSecret,
  startIntegrationSignIn,
  type EventInfo,
  type IntegrationsView,
  type IntegrationView,
  type TunnelState,
} from './builder';

// Settings -> Connectors -> Integrations (docs/integrations.md): the services
// agents' tools run on. Web search is one service among several (agents use
// whichever is connected); anything else is added as an MCP server by its
// address, or later by the Agency Engineer. Keys go here, never in a chat.
export function Integrations({ onOpenApproval, focus, onFocused }: { onOpenApproval: (id: string) => void; focus?: string | null; onFocused?: () => void }) {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Events' webhook addresses and the tunnel (docs/events.md), kept in step with the list.
  const [events, setEvents] = useState<{ tunnel: TunnelState; events: EventInfo[] }>({ tunnel: { status: 'off', url: null, error: null }, events: [] });
  const refresh = () => {
    getEvents().then(setEvents, () => {});
    return getIntegrations().then(setView, e => setError((e as Error).message));
  };
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, []);
  // Arriving for one integration (a request's "Open ... in Settings"): scrolled to, glowing blue.
  useEffect(() => {
    if (!focus || !view) return;
    const row = document.querySelector<HTMLElement>(`[data-integration="${CSS.escape(focus)}"]`);
    onFocused?.();
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('spotlit');
    window.setTimeout(() => row.classList.remove('spotlit'), 2600);
  }, [focus, !!view]);
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
            <IntegrationRow key={i.id} i={i} refresh={refresh} open={openId === i.id} setOpen={o => setOpenId(o ? i.id : null)} onOpenApproval={onOpenApproval} events={events.events} />
          ))}
        </ul>
      </div>
      <div className="sgroup">
        <h3>Integrations</h3>
        <p className="slead">Other services agents can use. Add any service that has an MCP server by its address.</p>
        <ul className="sconnectors">
          <CodePlugins />
          <AgencyMcp />
          {view.integrations.some(i => i.events.some(e => e.webhook)) && <WebhookTunnel tunnel={events.tunnel} onChange={t => setEvents(v => ({ ...v, tunnel: t }))} />}
          {others.map(i => (
            <IntegrationRow key={i.id} i={i} refresh={refresh} open={openId === i.id} setOpen={o => setOpenId(o ? i.id : null)} onOpenApproval={onOpenApproval} events={events.events} />
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

type RowProps = { i: IntegrationView; refresh: () => void; open: boolean; setOpen: (o: boolean) => void; onOpenApproval: (id: string) => void; events: EventInfo[] };

// A service you sign in to, or one that takes a key.
const IntegrationRow = (p: RowProps) => (p.i.signIn ? <SignInRow {...p} /> : <KeyRow {...p} />);

function KeyRow({ i, refresh, open, setOpen, onOpenApproval, events }: RowProps) {
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
  const tools = i.kind !== 'mcp' && i.tools.length && !i.draft ? `${i.tools.length} tool${i.tools.length === 1 ? '' : 's'}` : '';
  const sub = i.connected
    ? i.draft
      ? i.approvalId ? 'Tested · waiting for your approval' : 'The Agency Engineer is testing it'
      : [i.test?.message, tools].filter(Boolean).join(' · ')
    : i.test && !i.test.ok
      ? i.test.message
      : '';
  return (
    <li className={open || error ? 'with-form' : undefined} data-integration={i.id}>
      <span className="sconn-name">
        {i.name}
        {i.kind === 'mcp' && <span className="sint-kind">MCP</span>}
      </span>
      {sub && <span className={`sconn-what${i.test && !i.test.ok ? ' sint-bad' : ''}`}>{sub}</span>}
      <span className="sint-actions">
        {i.connected ? (
          <>
            <ApproveButton i={i} onOpenApproval={onOpenApproval} />
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
              {i.keyHelp && <p className="sint-help">{i.keyHelp}</p>}
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
      <EventHooks i={i} events={events} refresh={refresh} />
    </li>
  );
}

// A service you sign in to (OAuth, e.g. Gmail): your own OAuth client (made
// once in the service's console, steps shown), then its sign-in page in a
// window. The server tests it the moment it lands; this waits for that.
function SignInRow({ i, refresh, open, setOpen, onOpenApproval, events }: RowProps) {
  const signIn = i.signIn!;
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null); // when the sign-in window opened
  const popup = useRef<Window | null>(null);
  const [error, setError] = useState<string | null>(null);
  // While its window is open, look often; it's done once a test newer than the start lands.
  useEffect(() => {
    if (waiting === null) return;
    if (i.test && i.test.at >= waiting) {
      setWaiting(null);
      if (!i.test.ok) {
        setError(i.test.message);
        setOpen(true);
      }
      return;
    }
    // The window closes itself after landing; closed with no new test means it
    // was cancelled or the service refused it - stop waiting (one last look first).
    let closedAt: number | null = null;
    const t = window.setInterval(() => {
      refresh();
      if (popup.current?.closed) closedAt ??= Date.now();
      if (closedAt && Date.now() - closedAt > 4000) setWaiting(null);
    }, 1500);
    const give = window.setTimeout(() => setWaiting(null), 5 * 60_000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(give);
    };
  }, [waiting, i.test?.at]);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startIntegrationSignIn(i.id, { clientId: clientId.trim() || undefined, clientSecret: clientSecret.trim() || undefined });
      popup.current = window.open(url, '_blank', 'popup,width=520,height=720');
      setWaiting(Date.now());
      setClientId('');
      setClientSecret('');
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const tools = i.tools.length ? `${i.tools.length} tools` : '';
  const sub = waiting
    ? 'Waiting for you to sign in, in the window that opened'
    : i.connected
      ? i.draft
        ? i.approvalId ? 'Tested · waiting for your approval' : 'The Agency Engineer is testing it'
        : [i.test?.message, tools].filter(Boolean).join(' · ')
      : i.test && !i.test.ok
        ? i.test.message
        : '';
  const bad = !waiting && !!i.test && !i.test.ok;
  return (
    <li className={open || error ? 'with-form' : undefined} data-integration={i.id}>
      <span className="sconn-name">
        {i.name}
      </span>
      {sub && <span className={`sconn-what${bad ? ' sint-bad' : ''}`}>{sub}</span>}
      <span className="sint-actions">
        {i.connected ? (
          <>
            <ApproveButton i={i} onOpenApproval={onOpenApproval} />
            <SpinButton spinning={false} onClick={() => act(() => disconnectIntegration(i.id))}>
              Disconnect
            </SpinButton>
          </>
        ) : open ? null : (
          <>
            {signIn.hasClient && (
              <button className="sbtn" onClick={() => setOpen(true)} disabled={busy}>
                Change client
              </button>
            )}
            <SpinButton spinning={busy || waiting !== null} onClick={() => (signIn.hasClient ? start() : setOpen(true))}>
              Sign in
            </SpinButton>
          </>
        )}
      </span>
      {(open || error) && (
        <div className="mform sint-form">
          {open && (
            <>
              {signIn.help && (
                <ol className="sint-steps">
                  {signIn.help
                    .trim()
                    .split('\n')
                    .map(l => (
                      <li key={l}>{l.replace(/^\d+\.\s*/, '')}</li>
                    ))}
                </ol>
              )}
              <input
                className="srow2-input mwide"
                autoFocus
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                spellCheck={false}
                value={clientId}
                placeholder={signIn.hasClient ? 'New OAuth client ID' : 'OAuth client ID'}
                onChange={e => setClientId(e.target.value)}
              />
              {/* Masked text, not a password field: browsers would offer to save the client as a login. */}
              <input
                className="srow2-input mwide masked"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                spellCheck={false}
                value={clientSecret}
                placeholder="Client secret"
                onChange={e => setClientSecret(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && clientId.trim()) start();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
              <div className="mform-actions">
                {signIn.clientUrl && (
                  <a className="slink" href={signIn.clientUrl} target="_blank" rel="noreferrer">
                    Open the console <ExternalLink size={12} />
                  </a>
                )}
                <button className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
                <SpinButton className="sbtn primary" spinning={busy} onClick={start} disabled={!clientId.trim()}>
                  Sign in
                </SpinButton>
              </div>
            </>
          )}
          {error && <span className="custom-error">{error}</span>}
        </div>
      )}
      <EventHooks i={i} events={events} refresh={refresh} />
    </li>
  );
}

// A draft the Agency Engineer has tested: its go-live waits on you. Takes you
// to that approval (centred, glowing) - approving it there makes it live.
const ApproveButton = ({ i, onOpenApproval }: { i: IntegrationView; onOpenApproval: (id: string) => void }) =>
  i.approvalId ? (
    <button className="sbtn primary" onClick={() => onOpenApproval(i.approvalId!)}>
      Approve
    </button>
  ) : null;

// Whether the Agency Engineer may write code plugins: code that runs on this
// computer, for what an HTTP or MCP integration can't do. Off unless turned on.
function CodePlugins() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => void getCodePlugins().then(r => setAllowed(r.allowed), () => {}), []);
  if (allowed === null) return null;
  const flip = () => {
    setAllowed(!allowed); // at once; put back if the server says otherwise
    setCodePlugins(!allowed).then(r => setAllowed(r.allowed), () => setAllowed(allowed));
  };
  return (
    <li>
      <span className="sconn-name">Code plugins</span>
      <span className="sconn-what">Lets the Agency Engineer write code that runs on this computer, after your approval</span>
      <span className="sint-actions">
        <button className={`switch${allowed ? ' on' : ''}`} role="switch" aria-checked={allowed} aria-label="Code plugins" onClick={flip} />
      </span>
    </li>
  );
}

// The agency in the person's AI IDE (Claude Code, Cursor...): its MCP server,
// as Claude Code's add command or the bare address for any other.
function AgencyMcp() {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => void getAgencyMcp().then(r => setUrl(r.url), () => {}), []);
  if (!url) return null;
  const copy = (what: string, text: string) =>
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1600);
    }, () => {});
  return (
    <li>
      <span className="sconn-name">Your IDE</span>
      <span className="sconn-what">Run the whole agency from Claude Code, Cursor or any MCP client</span>
      <span className="sint-actions">
        <button className="sbtn" onClick={() => copy('claude', `claude mcp add --transport http agency ${url}`)}>
          {copied === 'claude' ? 'Copied' : 'Copy for Claude Code'}
        </button>
        <button className="sbtn" onClick={() => copy('url', url)}>
          {copied === 'url' ? 'Copied' : 'Copy address'}
        </button>
      </span>
    </li>
  );
}

// An integration's events that a service posts (docs/events.md): the address to
// paste into the service for each, and the signing secret it gives, if it signs.
function EventHooks({ i, events, refresh }: { i: IntegrationView; events: EventInfo[]; refresh: () => void }) {
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hooks = i.events.filter(e => e.webhook);
  if (!hooks.length) return null;
  const signed = hooks.find(e => e.signed);
  const copy = (id: string, url: string) =>
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1600);
    }, () => {});
  const save = () =>
    setWebhookSecret(i.id, secret).then(
      () => {
        setSecret('');
        refresh();
      },
      e => setError((e as Error).message),
    );
  return (
    <div className="sint-events">
      {hooks.map(e => {
        const url = events.find(x => x.id === e.id)?.webhook;
        return (
          <div className="sint-event" key={e.id}>
            <span className="sint-event-name">{e.description}</span>
            {url && (
              <button className="sbtn" onClick={() => copy(e.id, url)} title={url}>
                {copied === e.id ? 'Copied' : 'Copy webhook address'}
              </button>
            )}
          </div>
        );
      })}
      {signed &&
        (i.webhookSecretSet ? (
          <span className="sint-help">Signing secret saved.</span>
        ) : (
          <div className="sint-event">
            <input
              className="srow2-input mwide"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              placeholder={signed.secretHelp ?? 'Signing secret'}
              onChange={e => {
                setSecret(e.target.value);
                setError(null);
              }}
              onKeyDown={e => e.key === 'Enter' && secret.trim() && save()}
            />
            <button className="sbtn" onClick={save} disabled={!secret.trim()}>
              Save
            </button>
          </div>
        ))}
      {error && <span className="custom-error">{error}</span>}
    </div>
  );
}

// The public address services post events to: a tunnel to this computer's
// webhook server only (never the app itself), while it's on.
function WebhookTunnel({ tunnel, onChange }: { tunnel: TunnelState; onChange: (t: TunnelState) => void }) {
  const on = tunnel.status !== 'off';
  const flip = () => setTunnel(!on).then(r => onChange(r.tunnel), () => {});
  const what =
    tunnel.status === 'on'
      ? tunnel.url
      : tunnel.status === 'starting'
        ? 'Starting...'
        : tunnel.status === 'missing'
          ? "Needs Cloudflare's cloudflared: winget install Cloudflare.cloudflared"
          : tunnel.status === 'error'
            ? tunnel.error
            : 'Lets services post events to this computer';
  return (
    <li>
      <span className="sconn-name">Public webhook address</span>
      <span className={`sconn-what${tunnel.status === 'error' || tunnel.status === 'missing' ? ' sint-bad' : ''}`}>{what}</span>
      <span className="sint-actions">
        <button className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label="Public webhook address" onClick={flip} />
      </span>
    </li>
  );
}

// A command, or an address on this computer or its network.
const onThisComputer = (s: string) => {
  const v = s.trim();
  if (!v) return false;
  if (!/^https?:\/\//i.test(v)) return true;
  try {
    const h = new URL(v).hostname;
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(h) || h.endsWith('.local');
  } catch {
    return false;
  }
};

// Adding an MCP server: its address, or a command for one on this computer, and how it signs in.
function AddMcp({ refresh, open, setOpen }: { refresh: () => void; open: boolean; setOpen: (o: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'signin'>('none');
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
        // One that signs in: its sign-in opens now; the row waits for it to land.
        if (r.signIn) window.open(r.signIn, '_blank', 'popup,width=520,height=720');
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
        <input
          className="srow2-input mwide"
          autoFocus
          value={url}
          placeholder="Its address (https://mcp.example.com/mcp), or a command that starts one on this computer (npx -y ...)"
          onChange={e => setUrl(e.target.value)}
        />
        {onThisComputer(url) && (
          <p className="sint-help sint-bad">
            This one runs on this computer, with your permissions - agents using it can do what it can. Only add servers you trust.
          </p>
        )}
        <input className="srow2-input mwide" value={name} placeholder="Name (optional)" onChange={e => setName(e.target.value)} />
        <div className="sint-auth">
          <label>
            <input type="radio" checked={auth === 'none'} onChange={() => setAuth('none')} /> No sign-in
          </label>
          <label>
            <input type="radio" checked={auth === 'bearer'} onChange={() => setAuth('bearer')} /> API key / token
          </label>
          <label>
            <input type="radio" checked={auth === 'signin'} onChange={() => setAuth('signin')} /> Sign in
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
