import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled (not fetched from Google) so the desktop app works offline.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import './styles.css';
import { inDesktopApp, initAccount, state } from './account';

// Who's signed in and which agency the app is in come first: everything else
// (data.ts, the stored card order...) is that agency's.
void (async () => {
  // The browser half of the desktop app's Google/GitHub sign-in (account.ts):
  // never the app itself, only where signing in is up to and how it ended.
  const q = new URLSearchParams(location.search);
  const handoffPage = !inDesktopApp && (q.has('handoff') || (location.pathname === '/sso-callback' && q.has('handoff_state')));
  if (handoffPage) {
    const root = createRoot(document.getElementById('root')!);
    const show = (title: string, text: string) =>
      root.render(
        <div className="handoff-page">
          <h1>{title}</h1>
          <p>{text}</p>
        </div>,
      );
    const signedIn = () => show("You're signed in", 'Go back to the app - you can close this tab.');
    // Where signing this browser back out lands, once the app has its ticket.
    if (q.get('handoff') === 'done') return signedIn();
    show('Signing you in...', 'One moment.');
    try {
      await initAccount();
    } catch (e) {
      state.handoff = { error: (e as Error).message || 'Something went wrong. Try again from the app.' };
    }
    // Nothing yet: on the way to Google or GitHub, this page is leaving.
    if (state.handoff === 'done') signedIn();
    else if (state.handoff) show('That didn’t work', state.handoff.error);
    return;
  }
  await initAccount().catch(e => console.error('Starting without the account:', e));
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
