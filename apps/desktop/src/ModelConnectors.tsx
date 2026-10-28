import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Cpu, ExternalLink, Loader2 } from 'lucide-react';
import {
  siAnthropic,
  siClaude,
  siDeepseek,
  siGithubcopilot,
  siGooglegemini,
  siMistralai,
  siOllama,
  siOpenrouter,
  siX,
  type SimpleIcon,
} from 'simple-icons';
import {
  connectClaudeCode,
  connectKey,
  disconnectModel,
  retryKey,
  getConnections,
  installClaudeCode,
  signInClaudeCode,
  startCopilot,
  startSignIn,
  type Connection,
} from './builder';

// A hand-drawn aside between plans and keys: crayon arrows out of either side
// of the text, curling out and up to the plans, and out and down to the keys. The wobble and grain come from an SVG filter, and each
// stroke is drawn twice, slightly offset, the way crayon catches the paper.
function Crayon({ shaft, head }: { shaft: string; head: string }) {
  const id = `crayon-${useId().replace(/:/g, '')}`;
  return (
    <svg className="mtip-arrow" viewBox="0 0 60 90" aria-hidden="true">
      <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="grain" />
        <feDisplacementMap in="SourceGraphic" in2="grain" scale="3.4" />
      </filter>
      <g filter={`url(#${id})`} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {[shaft, head].map(d => (
          <g key={d}>
            <path d={d} strokeWidth="4.2" opacity="0.75" />
            <path d={d} strokeWidth="2" opacity="0.5" transform="translate(1.2 1)" />
          </g>
        ))}
      </g>
    </svg>
  );
}

function CrayonTip() {
  return (
    <div className="mtip">
      <Crayon shaft="M57 46 C 32 49, 17 40, 20 8" head="M11 19 C 14 15, 17 11, 20 6 C 23 11, 26 15, 30 19" />
      <p className="mtip-text">
        <b>TIP:</b> the AI plans (above) are 99% of the time a MUCH better deal than the API keys (below)
      </p>
      <Crayon shaft="M3 44 C 28 41, 43 50, 40 82" head="M30 71 C 33 75, 36 79, 40 84 C 44 79, 47 75, 50 71" />
    </div>
  );
}

// Settings > Connectors: the AI models your agents run on (docs/model-connections.md).
// Plans you already pay for, connected through each provider's own sanctioned
// route; API keys, checked live before they're saved; and models on this computer.
// Keys go straight to the app's server and are never shown again.

const LOGOS: Record<string, SimpleIcon | undefined> = {
  'claude-code': siClaude,
  anthropic: siAnthropic,
  google: siGooglegemini,
  openrouter: siOpenrouter,
  xai: siX,
  mistral: siMistralai,
  deepseek: siDeepseek,
  ollama: siOllama,
  copilot: siGithubcopilot,
};

function Logo({ id }: { id: string }) {
  const logo = LOGOS[id];
  return (
    <span className="mlogo">
      {logo ? (
        <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden fill="currentColor">
          <path d={logo.path} />
        </svg>
      ) : (
        <Cpu size={16} strokeWidth={1.8} />
      )}
    </span>
  );
}

const SIGN_IN_WAIT_MS = 5 * 60_000;

export function ModelConnectors() {
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => getConnections().then(setList, e => setError((e as Error).message));
  useEffect(() => {
    refresh();
    // Back from a sign-in window (or anywhere else): show what changed.
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  // A sign-in already in progress (started before this page opened): keep checking.
  const pendingId = list?.find(c => c.pending)?.id;
  useEffect(() => {
    if (pendingId) watch(pendingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  // A sign-in finishes in another window: check every second until it's
  // connected. If that window is closed without finishing, give the server a
  // couple of seconds to land it, then stop.
  const [waiting, setWaiting] = useState<string | null>(null);
  // Only one key form is open at a time; opening one closes (and saves) the other.
  const [openId, setOpenId] = useState<string | null>(null);
  const watching = useRef<ReturnType<typeof setInterval>>();
  const watch = (id: string, popup?: Window | null) => {
    clearInterval(watching.current);
    setWaiting(id);
    const until = Date.now() + SIGN_IN_WAIT_MS;
    let closedAt = 0;
    const stop = () => {
      clearInterval(watching.current);
      setWaiting(null);
    };
    const check = async () => {
      const next = await getConnections().catch(() => null);
      if (next) setList(next);
      const c = next?.find(x => x.id === id);
      if (c?.connected && !c.pending) return stop();
      if (popup?.closed) closedAt ||= Date.now();
      if (Date.now() > until || (closedAt && Date.now() - closedAt > 2500)) stop();
    };
    watching.current = setInterval(check, 1000);
  };
  useEffect(() => () => clearInterval(watching.current), []);

  if (!list) return error ? <p className="custom-error">{error}</p> : <p className="snotes-empty">Loading...</p>;
  const group = (kind: Connection['kind']) => list.filter(c => c.kind === kind);
  return (
    <>
      <div className="sgroup">
        <h3>Your AI plans</h3>
        <p className="slead">Use a subscription you already pay for. Each connects through the provider's own sign-in.</p>
        {group('plan').map(c => (
          <PlanRow key={c.id} c={c} refresh={refresh} watch={watch} waiting={waiting === c.id} />
        ))}
      </div>
      <CrayonTip />
      <div className="sgroup">
        <h3>API keys</h3>
        {group('key').map(c => (
          <KeyRow
            key={c.id}
            c={c}
            refresh={refresh}
            watch={watch}
            waiting={waiting === c.id}
            open={openId === c.id}
            setOpen={o => setOpenId(o ? c.id : null)}
          />
        ))}
      </div>
      <div className="sgroup">
        <h3>On this computer</h3>
        {group('local').map(c => (
          <KeyRow
            key={c.id}
            c={c}
            refresh={refresh}
            watch={watch}
            waiting={waiting === c.id}
            open={openId === c.id}
            setOpen={o => setOpenId(o ? c.id : null)}
          />
        ))}
      </div>
    </>
  );
}

type RowProps = {
  c: Connection;
  refresh: () => Promise<unknown>;
  watch: (id: string, popup?: Window | null) => void;
  waiting: boolean; // a sign-in for this row is in progress
};

// A button that turns into a grey spinner while its action runs. It keeps its
// width (the label stays, invisibly) so the row doesn't jump.
export function SpinButton({
  spinning,
  className = 'sbtn',
  disabled,
  title,
  onClick,
  children,
}: {
  spinning: boolean;
  className?: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`${className}${spinning ? ' spinning' : ''}`}
      disabled={disabled || spinning}
      title={title}
      onClick={onClick}
      aria-busy={spinning}
    >
      <span className="spin-label">{children}</span>
      {spinning && <Loader2 size={15} className="spin-icon" aria-hidden />}
    </button>
  );
}

// Opens a provider's sign-in in a small window.
const openSignIn = (url: string) => window.open(url, '_blank', 'popup,width=520,height=720');

// Runs one action, keeping its error next to the row.
function useAction(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

function RowShell({ c, sub, children, below }: { c: Connection; sub: React.ReactNode; children: React.ReactNode; below?: React.ReactNode }) {
  return (
    <div className="mrow">
      <div className="srow2">
        <div className="srow2-text mrow-text">
          <Logo id={c.id} />
          <span>
            <span className="srow2-label">
              {c.name}
              {c.connected && <span className="mconnected">Connected</span>}
              {c.broken && (
                <span className="mbroken" title={c.broken}>
                  <AlertTriangle size={13} strokeWidth={2.2} /> Key not working
                </span>
              )}
            </span>
            <span className="srow2-sub">{sub}</span>
          </span>
        </div>
        <div className="srow2-control">{children}</div>
      </div>
      {below}
    </div>
  );
}

const modelCount = (n: number) => (n ? ` · ${n} model${n === 1 ? '' : 's'}` : '');

// An API key (or a local server). Typing a key and moving on - opening another
// row's form, leaving Connectors, closing Settings - saves it and checks it in
// the background. A key that doesn't check out is kept and marked broken, with
// the reason, until it's retried, replaced or removed. Cancel or Escape discards.
function KeyRow({
  c,
  refresh,
  watch,
  waiting,
  open,
  setOpen,
}: RowProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? '');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, error: actionError, act } = useAction(refresh);
  const local = c.kind === 'local';

  const draft = useRef({ key, baseUrl });
  draft.current = { key, baseUrl };
  const hasDraft = () => !local && draft.current.key.trim() !== '';

  const save = async (k: string, url: string) => {
    setChecking(true);
    setError(null);
    try {
      await connectKey(c.id, k, c.editableBaseUrl ? url : undefined);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setChecking(false);
      refresh();
    }
  };

  // Explicit Connect: on success the form closes; on failure it stays open
  // with the reason (the key is kept, marked broken).
  const connect = async () => {
    if (checking || (!local && !key.trim())) return;
    if (await save(key, baseUrl)) {
      setKey('');
      setOpen(false);
    }
  };
  const cancel = () => {
    setKey('');
    setError(null);
    setOpen(false);
  };

  // Closed because another row's form opened: keep what was typed.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open && hasDraft()) {
      const { key: k, baseUrl: url } = draft.current;
      setKey('');
      save(k, url);
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Leaving Connectors or closing Settings with a key typed in: save it. The
  // result (connected or broken) is waiting next time.
  useEffect(
    () => () => {
      if (wasOpen.current && hasDraft())
        connectKey(c.id, draft.current.key, c.editableBaseUrl ? draft.current.baseUrl : undefined).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const shownError = error ?? actionError;
  // Worth retrying only when the provider was down or busy, not for a bad key.
  const unreachable = !!c.broken && /couldn't reach|busy|had a problem/i.test(c.broken);
  const sub = checking
    ? 'Checking the key...'
    : c.connected
      ? `${c.label}${modelCount(c.models)}`
      : c.broken
        ? `${c.label} · ${c.broken}`
        : c.what;

  return (
    <RowShell
      c={c}
      sub={<span className={c.broken && !checking ? 'mbroken-sub' : undefined}>{sub}</span>}
      below={
        open ? (
          <div className="mform">
            {c.editableBaseUrl && (
              <input
                className="srow2-input mwide"
                value={baseUrl}
                placeholder="API base URL, e.g. https://api.together.xyz/v1"
                onChange={e => setBaseUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') connect();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    cancel();
                  }
                }}
              />
            )}
            {!local && (
              <input
                className="srow2-input mwide"
                type="password"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={c.broken ? 'Paste a new key' : c.keyPrefix ? `${c.keyPrefix}...` : 'API key'}
                onChange={e => {
                  setKey(e.target.value);
                  setError(null);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') connect();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    cancel();
                  }
                }}
              />
            )}
            <div className="mform-actions">
              {c.keyUrl && (
                <a className="slink" href={c.keyUrl} target="_blank" rel="noreferrer">
                  Get a key <ExternalLink size={12} />
                </a>
              )}
              <button className="sbtn" onClick={cancel} disabled={checking}>
                Cancel
              </button>
              <SpinButton className="sbtn primary" spinning={checking} onClick={connect} disabled={!local && !key.trim()}>
                Connect
              </SpinButton>
            </div>
            {shownError && <span className="custom-error">{shownError}</span>}
          </div>
        ) : (
          shownError &&
          !c.broken && (
            <div className="mform">
              <span className="custom-error">{shownError}</span>
            </div>
          )
        )
      }
    >
      {c.connected ? (
        <SpinButton spinning={busy} onClick={() => act(() => disconnectModel(c.id))}>
          Disconnect
        </SpinButton>
      ) : open ? null : c.broken ? (
        <>
          {unreachable && (
            <SpinButton spinning={busy || checking} onClick={() => act(() => retryKey(c.id))}>
              Retry
            </SpinButton>
          )}
          <button className="sbtn" disabled={checking} onClick={() => setOpen(true)}>
            Replace key
          </button>
          <button className="slink" disabled={busy || checking} onClick={() => act(() => disconnectModel(c.id))}>
            Remove
          </button>
        </>
      ) : (
        <>
          {c.oneClick && (
            <SpinButton spinning={busy || waiting} onClick={() => act(async () => {
              const { url } = await startSignIn(c.id);
              watch(c.id, openSignIn(url));
            })}>
              Sign in
            </SpinButton>
          )}
          <SpinButton spinning={checking} onClick={() => setOpen(true)}>
            {local ? 'Connect' : 'Add key'}
          </SpinButton>
        </>
      )}
    </RowShell>
  );
}

function PlanRow({ c, refresh, watch, waiting }: RowProps) {
  const { busy, error, act } = useAction(refresh);
  const disconnect = (
    <button className="sbtn" disabled={busy} onClick={() => act(() => disconnectModel(c.id))}>
      Disconnect
    </button>
  );
  const errorLine = error && (
    <div className="mform">
      <span className="custom-error">{error}</span>
    </div>
  );

  if (c.id === 'claude-code') {
    // One button that does whatever's next: install Claude Code, sign in to
    // it, or use the plan it's signed in with. Install and sign-in open in a
    // terminal window (Anthropic's own installer and login); this row follows
    // along and connects by itself when the sign-in finishes.
    const cc = c.claudeCode;
    const task = cc?.task;
    const sub = c.connected
      ? `${c.label} · signed in with your Claude account`
      : task === 'installing'
        ? 'Installing Claude Code in the window that opened...'
        : task === 'signing-in'
          ? 'Finish signing in to your Claude account in your browser.'
          : !cc?.installed
            ? 'Use your Claude plan through Claude Code, Anthropic\'s own app.'
            : cc.loggedIn
              ? 'Claude Code is signed in. Your agents can run on your plan.'
              : 'Sign in to Claude Code with your Claude account.';
    const start = (fn: () => Promise<unknown>) =>
      act(async () => {
        await fn();
        watch(c.id);
      });
    return (
      <RowShell
        c={c}
        sub={sub}
        below={errorLine}
      >
        {c.connected ? (
          disconnect
        ) : !cc?.installed ? (
          <SpinButton className="sbtn primary" spinning={busy || !!task} onClick={() => start(installClaudeCode)}>
            Install Claude Code
          </SpinButton>
        ) : cc.loggedIn ? (
          <SpinButton className="sbtn primary" spinning={busy || waiting} onClick={() => act(connectClaudeCode)}>
            Use my Claude plan
          </SpinButton>
        ) : (
          <SpinButton className="sbtn primary" spinning={busy || !!task} onClick={() => start(signInClaudeCode)}>
            Sign in to Claude
          </SpinButton>
        )}
      </RowShell>
    );
  }

  if (c.id === 'chatgpt') {
    return (
      <RowShell c={c} sub={c.connected ? `${c.label}${modelCount(c.models)}` : c.what} below={errorLine}>
        {c.connected ? (
          <>
            <a className="slink" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
              Usage limits <ExternalLink size={12} />
            </a>
            {disconnect}
          </>
        ) : (
          <SpinButton
            className="sbtn primary"
            spinning={busy || waiting}
            onClick={() =>
              act(async () => {
                const { url } = await startSignIn('chatgpt');
                watch('chatgpt', openSignIn(url));
              })
            }
          >
            Sign in with ChatGPT
          </SpinButton>
        )}
      </RowShell>
    );
  }

  // GitHub Copilot: a device code you enter on GitHub. While one is waiting,
  // the code and the one button you need replace Connect.
  const code = c.pending?.userCode;
  const failed = !c.connected && !code && c.lastError;
  return (
    <RowShell
      c={c}
      sub={
        c.connected
          ? `${c.label}${modelCount(c.models)}`
          : code
            ? 'Enter this code on GitHub and approve.'
            : (c.setupNeeded ?? c.what)
      }
      below={
        errorLine ||
        (failed && (
          <div className="mform">
            <span className="custom-error">{c.lastError}</span>
          </div>
        ))
      }
    >
      {c.connected ? (
        disconnect
      ) : code ? (
        <>
          <code className="mcode-chip">{code}</code>
          <a className="sbtn primary" href={c.pending!.verificationUri} target="_blank" rel="noreferrer">
            Open GitHub <ExternalLink size={12} />
          </a>
          <Loader2 size={15} className="spin-icon solo" aria-label="Waiting for GitHub" />
        </>
      ) : (
        <SpinButton
          className="sbtn primary"
          spinning={busy || waiting}
          disabled={!!c.setupNeeded}
          title={c.setupNeeded}
          onClick={() =>
            act(async () => {
              const { verificationUri } = await startCopilot();
              window.open(verificationUri, '_blank');
              watch('copilot');
            })
          }
        >
          Connect
        </SpinButton>
      )}
    </RowShell>
  );
}
