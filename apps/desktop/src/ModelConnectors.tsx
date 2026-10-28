import { useEffect, useRef, useState } from 'react';
import { Cpu, ExternalLink } from 'lucide-react';
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
import { connectKey, disconnectModel, getConnections, startCopilot, startSignIn, connectClaudeCode, type Connection } from './builder';

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
  }, []);

  // A sign-in finishes in another window: check back until it's connected.
  const watching = useRef<ReturnType<typeof setInterval>>();
  const watch = (id: string) => {
    clearInterval(watching.current);
    const until = Date.now() + SIGN_IN_WAIT_MS;
    watching.current = setInterval(async () => {
      const next = await getConnections().catch(() => null);
      if (next) setList(next);
      const c = next?.find(x => x.id === id);
      if ((c?.connected && !c.pending) || Date.now() > until) clearInterval(watching.current);
    }, 2000);
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
          <PlanRow key={c.id} c={c} refresh={refresh} watch={watch} />
        ))}
      </div>
      <div className="sgroup">
        <h3>API keys</h3>
        {group('key').map(c => (
          <KeyRow key={c.id} c={c} refresh={refresh} watch={watch} />
        ))}
      </div>
      <div className="sgroup">
        <h3>On this computer</h3>
        {group('local').map(c => (
          <KeyRow key={c.id} c={c} refresh={refresh} watch={watch} />
        ))}
      </div>
    </>
  );
}

type RowProps = { c: Connection; refresh: () => Promise<unknown>; watch: (id: string) => void };

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

function KeyRow({ c, refresh, watch }: RowProps) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? '');
  const { busy, error, act } = useAction(refresh);
  const local = c.kind === 'local';
  const connect = async () => {
    if (await act(() => connectKey(c.id, key, c.editableBaseUrl ? baseUrl : undefined))) {
      setKey('');
      setOpen(false);
    }
  };
  const signIn = () =>
    act(async () => {
      const { url } = await startSignIn(c.id);
      window.open(url, '_blank', 'popup,width=520,height=720');
      watch(c.id);
    });

  return (
    <RowShell
      c={c}
      sub={c.connected ? `${c.label}${modelCount(c.models)}` : c.what}
      below={
        (open || error) && (
          <div className="mform">
            {open && c.editableBaseUrl && (
              <input
                className="srow2-input mwide"
                value={baseUrl}
                placeholder="API base URL, e.g. https://api.together.xyz/v1"
                onChange={e => setBaseUrl(e.target.value)}
              />
            )}
            {open && !local && (
              <input
                className="srow2-input mwide"
                type="password"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={c.keyPrefix ? `${c.keyPrefix}...` : 'API key'}
                onChange={e => setKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && connect()}
              />
            )}
            {open && (
              <div className="mform-actions">
                {c.keyUrl && (
                  <a className="slink" href={c.keyUrl} target="_blank" rel="noreferrer">
                    Get a key <ExternalLink size={12} />
                  </a>
                )}
                <button className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
                <button className="sbtn primary" onClick={connect} disabled={busy || (!local && !key.trim())}>
                  {busy ? 'Checking...' : 'Connect'}
                </button>
              </div>
            )}
            {error && <span className="custom-error">{error}</span>}
          </div>
        )
      }
    >
      {c.connected ? (
        <button className="sbtn" disabled={busy} onClick={() => act(() => disconnectModel(c.id))}>
          Disconnect
        </button>
      ) : (
        !open && (
          <>
            {c.oneClick && (
              <button className="sbtn" disabled={busy} onClick={signIn}>
                Sign in
              </button>
            )}
            <button className="sbtn" onClick={() => setOpen(true)}>
              {local ? 'Connect' : 'Add key'}
            </button>
          </>
        )
      )}
    </RowShell>
  );
}

function PlanRow({ c, refresh, watch }: RowProps) {
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
    const cc = c.claudeCode;
    const sub = c.connected
      ? `${c.label} · signed in with your Claude account`
      : !cc?.installed
        ? 'Install Claude Code, then sign in to it with your Claude account.'
        : !cc.loggedIn
          ? 'Open a terminal, run claude and sign in with your Claude account.'
          : 'Claude Code is signed in. Your agents can run on your plan.';
    return (
      <RowShell
        c={c}
        sub={
          <>
            {sub}
            <span className="mnote">This app never sees your Claude login - you sign in to Claude Code itself.</span>
          </>
        }
        below={errorLine}
      >
        {c.connected ? (
          disconnect
        ) : !cc?.installed ? (
          <a className="sbtn" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
            Get Claude Code
          </a>
        ) : cc.loggedIn ? (
          <button className="sbtn primary" disabled={busy} onClick={() => act(connectClaudeCode)}>
            Use my Claude plan
          </button>
        ) : (
          <button className="sbtn" disabled={busy} onClick={() => act(refresh)}>
            Check again
          </button>
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
          <button
            className="sbtn primary"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const { url } = await startSignIn('chatgpt');
                window.open(url, '_blank', 'popup,width=520,height=720');
                watch('chatgpt');
              })
            }
          >
            Sign in with ChatGPT
          </button>
        )}
      </RowShell>
    );
  }

  // GitHub Copilot: a device code you enter on GitHub.
  return (
    <RowShell
      c={c}
      sub={c.connected ? `${c.label}${modelCount(c.models)}` : (c.setupNeeded ?? c.what)}
      below={
        <>
          {c.pending?.userCode && (
            <div className="mform mcode">
              <span>Enter this code on GitHub:</span>
              <code>{c.pending.userCode}</code>
              <a className="sbtn" href={c.pending.verificationUri} target="_blank" rel="noreferrer">
                Open GitHub <ExternalLink size={12} />
              </a>
            </div>
          )}
          {errorLine}
        </>
      }
    >
      {c.connected ? (
        disconnect
      ) : (
        <button
          className="sbtn primary"
          disabled={busy || !!c.setupNeeded || !!c.pending}
          title={c.setupNeeded}
          onClick={() =>
            act(async () => {
              const { verificationUri } = await startCopilot();
              window.open(verificationUri, '_blank');
              watch('copilot');
            })
          }
        >
          {c.pending ? 'Waiting for GitHub...' : 'Connect'}
        </button>
      )}
    </RowShell>
  );
}
