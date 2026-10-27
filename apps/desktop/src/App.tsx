import { useState } from 'react';
import { Sidebar, viewLabel, type View } from './Sidebar';

export function App() {
  const [view, setView] = useState<View>('dashboard');

  return (
    <div className="app">
      <Sidebar view={view} onSelect={setView} />
      <main className="main">
        <header className="main-header">
          <h1>{viewLabel(view)}</h1>
        </header>
        <div className="main-empty">Main panel - coming next.</div>
      </main>
    </div>
  );
}
