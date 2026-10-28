import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Bundled (not fetched from Google) so the desktop app works offline.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
