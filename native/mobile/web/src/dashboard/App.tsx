import { useState } from 'react';
import type { ReactNode } from 'react';
import { Home } from './screens/Home.tsx';
import { Settings } from './screens/Settings.tsx';

interface Tab {
  id: string;
  label: string;
  render: () => ReactNode;
}

/**
 * Tabs appear only when their stage delivers real content: Home and Settings now; Her view (S6) and
 * Panels (S7) are registered by those stages.
 */
const TABS: readonly Tab[] = [
  { id: 'home', label: 'Home', render: () => <Home /> },
  { id: 'settings', label: 'Settings', render: () => <Settings /> },
];

export function App() {
  const [active, setActive] = useState(TABS[0]?.id ?? 'home');
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];
  return (
    <div className="safe-x flex min-h-dvh flex-col bg-base text-cream">
      <main className="safe-top flex-1 overflow-y-auto px-5 pb-6 pt-4">{tab?.render()}</main>
      <nav
        aria-label="Sections"
        className="safe-bottom safe-x sticky bottom-0 flex border-t border-line bg-raised"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={t.id === active ? 'page' : undefined}
            onClick={() => setActive(t.id)}
            className={`h-14 flex-1 text-sm font-medium ${t.id === active ? 'text-face' : 'text-muted'}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
