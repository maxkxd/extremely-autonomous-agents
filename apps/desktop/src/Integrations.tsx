import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe, Plug, Plus } from 'lucide-react';
import { siBrave, siGithub, siGmail, siGoogleanalytics, siGoogledrive, siGooglecalendar, siGooglesearchconsole, siHubspot, siNotion, siPosthog, siSentry, siShopify, siSquare, siStripe, siYoutube, siZoho, type SimpleIcon } from 'simple-icons';
import { SpinButton } from './ModelConnectors';
import { SkelRows } from './Skeleton';
import { connectAssistantTo, currentOrg, isAdmin, remoteAssistantUrl } from './account';
import { ACCOUNT } from './data';
import { AI_IDES, IdeLogo, type IdeId } from './Requests';
import { useOffline } from './offline';
import {
  addMcpIntegration,
  connectIntegration,
  disconnectIntegration,
  connectAssistant,
  getAgencyMcp,
  getEvents,
  getCodePlugins,
  getIntegrations,
  openAgentBrowser,
  getPasswords,
  revealPassword,
  addPassword,
  deletePassword,
  type SavedPassword,
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

// Settings > Connectors > Integrations (docs/integrations.md): the services
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
    onFocused?.();
    spotlight(focus);
  }, [focus, !!view]);
  if (error && !view) return <p className="custom-error">{error}</p>;
  if (!view) return <SkelRows n={4} h={54} what="integrations" />;
  const shown = view.integrations.filter(i => !i.unused);
  const search = shown.filter(i => i.tools.some(t => t.id === 'web.web_search'));
  const others = shown.filter(i => !search.includes(i));
  return (
    <>
      <div className="sgroup">
        <h3>Web search</h3>
        <ul className="sconnectors">
          {search.map(i => (
            <IntegrationRow key={i.id} i={i} refresh={refresh} open={openId === i.id} setOpen={o => setOpenId(o ? i.id : null)} onOpenApproval={onOpenApproval} events={events.events} />
          ))}
        </ul>
      </div>
      {/* Its own group: it's how you reach the agency, not a service agents use. No heading:
          its row already says "Your AI assistant". */}
      <div className="sgroup">
        <ul className="sconnectors">
          {/* Everyone's own: it acts as them (agency-mcp.ts on the host). */}
          <AgencyMcp />
        </ul>
      </div>
      <div className="sgroup">
        <h3>Integrations</h3>
        <p className="slead">Other services agents can use. Add any service that has an MCP server by its address.</p>
        <ul className="sconnectors">
          {/* What acts on the host's computer is the owner's and admins' (access.ts). */}
          {isAdmin() && <CodePlugins />}
          {isAdmin() && view.integrations.some(i => i.events.some(e => e.webhook)) && <WebhookTunnel tunnel={events.tunnel} onChange={t => setEvents(v => ({ ...v, tunnel: t }))} />}
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
      {isAdmin() && <AgentBrowser status={view.profile} />}
    </>
  );
}

// Scrolled to, glowing blue: an integration you're sent to.
function spotlight(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-integration="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('spotlit');
  window.setTimeout(() => row.classList.remove('spotlit'), 2600);
}

// Each service's mark, as the AI connections above have theirs (a plug for the rest).
const MARKS: [RegExp, SimpleIcon][] = [
  [/^brave/, siBrave], [/^github/, siGithub], [/^gmail/, siGmail], [/^drive/, siGoogledrive], [/calendar/, siGooglecalendar], [/^youtube/, siYoutube], [/^search-console/, siGooglesearchconsole], [/^google-analytics/, siGoogleanalytics],
  [/^hubspot/, siHubspot], [/^notion/, siNotion], [/^posthog/, siPosthog], [/^sentry/, siSentry], [/^shopify/, siShopify],
  [/^square/, siSquare], [/^stripe/, siStripe], [/^zoho/, siZoho],
];
function ServiceMark({ id }: { id: string }) {
  const mark = MARKS.find(([re]) => re.test(id))?.[1];
  return (
    <span className="mlogo">
      {mark ? (
        <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden fill="currentColor">
          <path d={mark.path} />
        </svg>
      ) : (
        <Plug size={16} strokeWidth={1.8} />
      )}
    </span>
  );
}

type RowProps = { i: IntegrationView; refresh: () => void; open: boolean; setOpen: (o: boolean) => void; onOpenApproval: (id: string) => void; events: EventInfo[] };

// Not connected and it failed: what it said, and that the Agency Engineer is on it -
// the person doesn't have to report it (a sign-in that never came back has no message).
const failedLine = (i: IntegrationView) =>
  i.test && !i.test.ok
    ? i.repairing ? `${i.test.message} · The Agency Engineer is looking at this` : i.test.message
    : i.repairing ? "It didn't connect · The Agency Engineer is looking at this" : null;

// A service you sign in to, or one that takes a key.
const IntegrationRow = (p: RowProps) => (p.i.signIn ? <SignInRow {...p} /> : <KeyRow {...p} />);

function KeyRow({ i, refresh, open, setOpen, onOpenApproval, events }: RowProps) {
  const [key, setKey] = useState('');
  // Disconnect and Remove take it away from every agent using it: a second click says so first.
  const [sure, setSure] = useState<'disconnect' | 'remove' | null>(null);
  // A fields sign-in: what's typed, by field (saved secrets start blank and are kept if left so).
  const [vals, setVals] = useState<Record<string, string>>({});
  const fieldsReady = !!i.fields?.every(f => f.optional || f.saved || (vals[f.name] ?? f.value ?? '').trim());
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
    if (i.fields) {
      if (!fieldsReady) return;
      const sent = Object.fromEntries(i.fields.map(f => [f.name, vals[f.name] ?? f.value ?? '']));
      if (await run(() => connectIntegration(i.id, undefined, sent))) {
        setVals({});
        setOpen(false);
      }
      return;
    }
    if (i.needsKey && !key.trim()) return;
    if (await run(() => connectIntegration(i.id, key))) {
      setKey('');
      setOpen(false);
    }
  };
  // An MCP server's test already says how many tools it found.
  const tools = i.kind !== 'mcp' && i.tools.length && !i.draft ? `${i.tools.length} tool${i.tools.length === 1 ? '' : 's'}` : '';
  // An extension uses another connection's key: nothing of its own to connect.
  const ext = i.keyFrom;
  const sub = ext
    ? i.connected
      ? [`Uses your ${ext.name} connection`, i.draft ? (i.approvalId ? 'Waiting for your approval' : 'The Agency Engineer is testing it') : tools].filter(Boolean).join(' · ')
      : (
        <>
          Uses your {ext.name} connection - connect{' '}
          <a className="text-link nowrap" href="#" onClick={e => (e.preventDefault(), spotlight(ext.id))}>
            {ext.name}
          </a>{' '}
          to use it
        </>
      )
    : i.connected
    ? i.draft
      ? i.approvalId ? 'Tested · waiting for your approval' : 'The Agency Engineer is testing it'
      : [i.test?.message, tools].filter(Boolean).join(' · ')
    : i.free
      ? 'Free, no key needed, up to an hourly limit · add a key for more searches'
      : failedLine(i) ?? i.what;
  return (
    <li className={open || error ? 'with-form' : undefined} data-integration={i.id}>
      <span className="sconn-name">
        <ServiceMark id={i.id} />
        {i.name}
        {i.kind === 'mcp' && <span className="sint-kind">MCP</span>}
      </span>
      {sub && <span className={`sconn-what${i.test && !i.test.ok ? ' sint-bad' : ''}`}>{sub}</span>}
      <span className="sint-actions">
        {ext ? (
          i.connected && <ApproveButton i={i} onOpenApproval={onOpenApproval} />
        ) : i.connected ? (
          <>
            <ApproveButton i={i} onOpenApproval={onOpenApproval} />
            <span onBlur={() => setSure(null)}>
              <SpinButton spinning={false} onClick={() => (sure === 'disconnect' ? (setSure(null), run(() => disconnectIntegration(i.id))) : setSure('disconnect'))}>
                {sure === 'disconnect' ? 'Disconnect for every agent?' : 'Disconnect'}
              </SpinButton>
            </span>
          </>
        ) : open ? null : i.needsKey || i.fields ? (
          <button className="sbtn" onClick={() => setOpen(true)}>
            Connect
          </button>
        ) : (
          <SpinButton spinning={busy} onClick={() => run(() => connectIntegration(i.id))}>
            Connect
          </SpinButton>
        )}
        {!i.shipped && !open && (
          <button
            className="sbtn danger"
            onClick={() => (sure === 'remove' ? (setSure(null), run(() => removeIntegration(i.id))) : setSure('remove'))}
            onBlur={() => setSure(null)}
            disabled={busy}
          >
            {sure === 'remove' ? 'Remove for everyone?' : 'Remove'}
          </button>
        )}
      </span>
      {(open || error) && (
        <div className="mform sint-form">
          {open && (
            <>
              {i.keyHelp && <p className="sint-help">{i.keyHelp}</p>}
              {i.fields ? (
                i.fields.map((f, n) => (
                  <label key={f.name} className="sint-field">
                    <span>
                      {f.label}
                      {f.optional && <span className="muted"> (optional)</span>}
                    </span>
                    {/* Masked text, not a password field: browsers would offer to save it as a login. */}
                    {f.options ? (
                      <select
                        className="srow2-input mwide"
                        autoFocus={n === 0}
                        value={vals[f.name] ?? f.value ?? ''}
                        onChange={e => {
                          setVals(v => ({ ...v, [f.name]: e.target.value }));
                          setError(null);
                        }}
                      >
                        {!(vals[f.name] ?? f.value) && <option value="">Choose...</option>}
                        {f.options.map(o => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                    <input
                      className={`srow2-input mwide${f.secret ? ' masked' : ''}`}
                      autoFocus={n === 0}
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      spellCheck={false}
                      value={vals[f.name] ?? f.value ?? ''}
                      placeholder={f.secret && f.saved ? 'Saved - leave blank to keep it' : (f.help ?? '')}
                      onChange={e => {
                        setVals(v => ({ ...v, [f.name]: e.target.value }));
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
                    )}
                    {f.help && (f.options || (f.secret && f.saved)) && <span className="sint-help">{f.help}</span>}
                  </label>
                ))
              ) : (
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
              )}
              <div className="mform-actions">
                {i.keyUrl && (
                  <a className="slink" href={i.keyUrl} target="_blank" rel="noreferrer">
                    Get a key <ExternalLink size={12} />
                  </a>
                )}
                <button className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
                <SpinButton className="sbtn primary" spinning={busy} onClick={connect} disabled={i.fields ? !fieldsReady : !key.trim()}>
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
  const [sure, setSure] = useState(false); // Disconnect asks once more: every agent using it loses it
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
      : failedLine(i) ?? i.what;
  const bad = !waiting && !!i.test && !i.test.ok;
  return (
    <li className={open || error ? 'with-form' : undefined} data-integration={i.id}>
      <span className="sconn-name">
        <ServiceMark id={i.id} />
        {i.name}
      </span>
      {sub && <span className={`sconn-what${bad ? ' sint-bad' : ''}`}>{sub}</span>}
      <span className="sint-actions">
        {i.connected ? (
          <>
            <ApproveButton i={i} onOpenApproval={onOpenApproval} />
            <span onBlur={() => setSure(false)}>
              <SpinButton spinning={false} onClick={() => (sure ? (setSure(false), act(() => disconnectIntegration(i.id))) : setSure(true))}>
                {sure ? 'Disconnect for every agent?' : 'Disconnect'}
              </SpinButton>
            </span>
          </>
        ) : open ? null : (
          <>
            {/* An MCP server's own sign-in (no redirect to set) has no client the person made. */}
            {signIn.hasClient && signIn.redirect && (
              <button className="sbtn" onClick={() => setOpen(true)} disabled={busy}>
                Change client
              </button>
            )}
            {/* "Connect", as every connection's button says - a sign-in or a key alike. */}
            <SpinButton spinning={busy || waiting !== null} onClick={() => (signIn.hasClient ? start() : setOpen(true))}>
              Connect
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
              {signIn.redirect && (
                <p className="sint-help">
                  Redirect address to add to the client: <code className="sint-code">{signIn.redirect}</code>
                </p>
              )}
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

// Your AI assistant (runner/assistant.ts): the whole agency in the AI app you
// use, in one click - Claude Desktop installs an extension, Cursor its MCP link.
// The address is on the computer the agency runs on; a teammate on another
// computer gets one on their own, which this app carries to the host while it's
// open (account.ts, runner/remote-mcp.ts). Either way it looks the same here.
function AgencyMcp() {
  const off = useOffline();
  const [mcp, setMcp] = useState<{ url: string; here: boolean; remote?: boolean } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const org = currentOrg();
    void getAgencyMcp().then(
      m => (m.here || !org ? setMcp(m) : remoteAssistantUrl(org.id).then(r => setMcp({ url: r.url, here: true, remote: true }))),
      () => {},
    );
  }, []);
  if (!mcp) return null;
  const connect = async (app: IdeId) => {
    setSaid(null);
    try {
      const org = currentOrg();
      const r = mcp.remote && org ? await connectAssistantTo(app, mcp.url, org.name) : await connectAssistant(app);
      setSaid(
        r.restart
          ? `Added to ${r.assistant}, which is opening - your agency is in its connectors.`
          : `${r.assistant} is asking to install the agency - click Install. Nothing came up? Open ${r.assistant}, then try again.`,
      );
    } catch (e) {
      setSaid((e as Error).message);
    }
  };
  const copy = () =>
    navigator.clipboard?.writeText(mcp.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }, () => {});
  return (
    <li className="sint-wide">
      <span className="sconn-name">Your AI assistant</span>
      <span className="sconn-what">
        {mcp.here
          ? 'Use your agency from the AI app you already use - one click to connect it. Works while this app is open.'
          : 'Works on the computer the organization runs on, so it can’t be connected from here yet.'}
      </span>
      {mcp.here && (
        <span className="sint-actions">
          {(Object.keys(AI_IDES) as IdeId[]).map(id => (
            <button key={id} className="sbtn" onClick={() => connect(id)}>
              <IdeLogo logo={AI_IDES[id].logo} />
              Connect {AI_IDES[id].name}
            </button>
          ))}
          <button className="sbtn" title={off ?? 'For another AI app that can add an MCP server by its address'} onClick={copy}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </span>
      )}
      {said && <p className="sint-help">{said}</p>}
    </li>
  );
}

// An integration's events that a service posts (docs/events.md): the address to
// paste into the service for each, and the signing secret it gives, if it signs.
function EventHooks({ i, events, refresh }: { i: IntegrationView; events: EventInfo[]; refresh: () => void }) {
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const off = useOffline();
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
              <button className="sbtn" onClick={() => copy(e.id, url)} title={off ?? url}>
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
  // A failure that never reached a status still says why, here, instead of the switch just not moving.
  const [failed, setFailed] = useState<string | null>(null);
  const flip = () => {
    setFailed(null);
    setTunnel(!on).then(
      r => onChange(r.tunnel),
      e => setFailed((e as Error).message),
    );
  };
  const what = failed ? failed :
    tunnel.status === 'on'
      ? tunnel.url
      : tunnel.status === 'starting'
        ? 'Starting...'
        : tunnel.status === 'missing'
          ? (
              <>
                Needs Cloudflare's free tunnel program on this computer:{' '}
                <a className="text-link" href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noreferrer">
                  download it
                </a>
                , install it, then turn this on again
              </>
            )
          : tunnel.status === 'error'
            ? tunnel.error
            : 'Lets services post events to this computer';
  return (
    <li>
      <span className="sconn-name">Public webhook address</span>
      <span className={`sconn-what${failed || tunnel.status === 'error' || tunnel.status === 'missing' ? ' sint-bad' : ''}`}>{what}</span>
      <span className="sint-actions">
        <button className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label="Public webhook address" onClick={flip} />
      </span>
    </li>
  );
}

// A command, or an address on this computer or its network.
// A command that starts a server: a known launcher, or a program by its path
// ("not a url at all just words" was taken for one).
const looksLikeCommand = (s: string) => {
  const first = s.trim().split(/\s+/)[0] ?? '';
  return /^(npx|node|uvx|uv|python3?|pipx|docker|deno|bun|bunx|pnpm|yarn|npm|java|go|cargo|dotnet)$/i.test(first) || /[\\/]|\.(exe|cmd|bat|sh|js|mjs|py)$/i.test(first);
};

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
          placeholder="https://mcp.example.com/mcp or npx -y ..."
          title="Its address, or a command that starts one on this computer"
          onChange={e => setUrl(e.target.value)}
        />
        {onThisComputer(url) && (
          <p className="sint-help sint-bad">
            {!/^https?:\/\//i.test(url.trim()) && !looksLikeCommand(url)
              ? "That isn't a web address (https://...) or a command that starts a server (npx -y ...)."
              : isAdmin()
              ? 'This one runs on this computer, with your permissions - agents using it can do what it can. Only add servers you trust.'
              : 'This one would run on the host’s computer. Only the owner or an admin can add those.'}
          </p>
        )}
        <input className="srow2-input mwide" value={name} placeholder="Name (optional)" onChange={e => setName(e.target.value)} />
        {/* The app's own choice buttons, not the browser's radio dots. */}
        <div className="segmented sint-auth" role="radiogroup" aria-label="How it signs in">
          {([['none', 'No sign-in'], ['bearer', 'API key / token'], ['signin', 'Sign in']] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={auth === v} className={auth === v ? 'on' : ''} onClick={() => setAuth(v)}>
              {label}
            </button>
          ))}
        </div>
        {auth === 'bearer' && (
          <input className="srow2-input mwide" type="password" autoComplete="off" value={key} placeholder="Key or token" onChange={e => setKey(e.target.value)} />
        )}
        <div className="mform-actions">
          <button className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
          <SpinButton className="sbtn primary" spinning={busy} onClick={add} disabled={!url.trim() || (auth === 'bearer' && !key.trim()) || (!isAdmin() && onThisComputer(url)) || (!/^https?:\/\//i.test(url.trim()) && !looksLikeCommand(url))}>
            Add
          </SpinButton>
        </div>
        {error && <span className="custom-error">{error}</span>}
      </div>
    </li>
  );
}

// The agents' own browser: separate profiles the person signs in to, and agents
// sign up in themselves. One opens in a real window on this computer.
function AgentBrowser({ status }: { status: IntegrationsView['profile'] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counted from the password list once it's in, so adding or deleting one shows here at once.
  const [saved, setSaved] = useState<SavedPassword[] | null>(null);
  const profiles = (status.profiles ?? [{ n: 1, open: status.open, inUse: status.inUse, accounts: 0 }]).map(p => (saved ? { ...p, accounts: saved.filter(r => r.profile === p.n).length } : p));
  const open = async (n: number) => {
    setBusy(n);
    setError(null);
    try {
      await openAgentBrowser(n);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="sgroup">
      <h3>Signed-in browser</h3>
      <p className="slead">Edge or Chrome profiles just for agents, kept signed in. Sign in to your own accounts here; agents sign up for theirs.</p>
      <ul className="sconnectors">
        {profiles.map(p => (
          <li key={p.n}>
            <span className="sconn-name">
              <Globe size={14} /> Profile {p.n}
            </span>
            <span className="sconn-what">
              {p.open ? "Open on your screen - close the window when you're done" : p.inUse ? 'In use by an agent right now' : `${p.accounts} saved account${p.accounts === 1 ? '' : 's'}`}
            </span>
            <span className="sint-actions">
              <SpinButton spinning={busy === p.n} onClick={() => open(p.n)} disabled={p.inUse} title={p.inUse ? 'An agent is using it - try again in a minute' : undefined}>
                Open
              </SpinButton>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="custom-error">{error}</p>}
      <Passwords onRows={setSaved} />
    </div>
  );
}

// The agents' accounts and passwords: who made each, in which profile. Revealed one at
// a time; agents never see them (they type them straight into the page).
function Passwords({ onRows }: { onRows: (rows: SavedPassword[]) => void }) {
  const [rows, setRowsState] = useState<SavedPassword[] | null>(null);
  const setRows = (r: SavedPassword[]) => (setRowsState(r), onRows(r));
  const [shown, setShown] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ site: '', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () => getPasswords().then(setRows, e => setError((e as Error).message));
  useEffect(() => void load(), []);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const reveal = (id: string) =>
    act(async () => {
      if (shown[id]) return setShown(({ [id]: _, ...rest }) => rest);
      const pw = await revealPassword(id);
      setShown(v => ({ ...v, [id]: pw }));
    });
  return (
    <>
      <h3 className="ssub">Passwords</h3>
      <ul className="sconnectors spasswords">
        {rows?.map(r => (
          <li key={r.id}>
            <span className="sconn-name">
              {r.site} <span className="muted">{r.username}</span>
            </span>
            <span className="sconn-what">
              {shown[r.id] ? <code className="spw">{shown[r.id]}</code> : `Profile ${r.profile} - ${r.agent_id ? `made by ${r.agent_id}` : 'added by a person'}${r.note ? ` - ${r.note}` : ''}`}
            </span>
            <span className="sint-actions">
              <button className="slink" onClick={() => reveal(r.id)}>
                {shown[r.id] ? 'Hide' : 'Show'}
              </button>
              {shown[r.id] && (
                <button className="slink" onClick={() => void navigator.clipboard?.writeText(shown[r.id]).catch(() => {})}>
                  Copy
                </button>
              )}
              <button
                className="slink"
                onClick={() => (confirm === r.id ? act(async () => (await deletePassword(r.id), setConfirm(null), load())) : setConfirm(r.id))}
                title={confirm === r.id ? 'Click again to delete it from the store (the account itself stays)' : 'Delete from the store'}
              >
                {confirm === r.id ? 'Sure?' : 'Delete'}
              </button>
            </span>
          </li>
        ))}
        {rows && !rows.length && !adding && (
          <li>
            <span className="sconn-what">No accounts yet.</span>
          </li>
        )}
        {adding && (
          <li className="with-form">
            <span className="sconn-name">Add an account agents can use</span>
            <div className="sint-form">
              <input className="srow2-input" placeholder="Site (linkedin.com)" value={form.site} onChange={e => setForm({ ...form, site: e.target.value })} />
              <input className="srow2-input" placeholder="Username or email" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
              <input className="srow2-input" type="password" autoComplete="new-password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
              <div className="mform-actions">
                <button className="sbtn" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  className="sbtn primary"
                  disabled={!form.site.trim() || !form.username.trim() || !form.password}
                  onClick={() => act(async () => (await addPassword(form), setForm({ site: '', username: '', password: '' }), setAdding(false), load()))}
                >
                  Add
                </button>
              </div>
            </div>
          </li>
        )}
      </ul>
      {!adding && (
        <button className="sbtn" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add account
        </button>
      )}
      {error && <p className="custom-error">{error}</p>}
    </>
  );
}
