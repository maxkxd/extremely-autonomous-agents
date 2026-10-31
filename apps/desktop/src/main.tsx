import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled (not fetched from Google) so the desktop app works offline.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import './styles.css';
import { initAccount, state } from './account';

// Who's signed in and which agency the app is in come first: everything else
// (data.ts, the stored card order...) is that agency's.
void (async () => {
  await initAccount().catch(e => console.error('Starting without the account:', e));
  // The browser half of the desktop app's Google/GitHub sign-in: just the outcome.
  if (state.handoff) {
    const done = state.handoff === 'done';
    createRoot(document.getElementById('root')!).render(
      <div className="handoff-page">
        <h1>{done ? "You're signed in" : 'That didn’t work'}</h1>
        <p>{done ? 'Go back to the app - you can close this tab.' : state.handoff === 'done' ? '' : state.handoff.error}</p>
      </div>,
    );
    return;
  }
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
