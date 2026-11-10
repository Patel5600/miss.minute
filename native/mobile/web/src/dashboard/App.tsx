import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Home as HomeIcon, MessageSquare, Layers, Settings as SettingsIcon } from 'lucide-react';
import { Home } from './screens/Home.tsx';
const Chat = lazy(() => import('./screens/Chat.tsx').then(module => ({ default: module.Chat })));
const Panels = lazy(() => import('./screens/Panels.tsx').then(module => ({ default: module.Panels })));
const Settings = lazy(() => import('./screens/Settings.tsx').then(module => ({ default: module.Settings })));
import { initializeSettings, loadSettings } from '@desktop/agent/settings';
import { startScheduler } from '@desktop/agent/scheduler';
import { speaker } from '@desktop/app/speaker';

interface Tab {
  id: string;
  label: string;
  icon: typeof HomeIcon;
  render: () => ReactNode;
}

const TABS: readonly Tab[] = [
  { id: 'home', label: 'Home', icon: HomeIcon, render: () => <Home /> },
  { id: 'chat', label: 'Chat', icon: MessageSquare, render: () => <Chat /> },
  { id: 'panels', label: 'Panels', icon: Layers, render: () => <Panels /> },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, render: () => <Settings /> },
];

export function App() {
  const [active, setActive] = useState(TABS[0]?.id ?? 'home');
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];

  useEffect(() => {
    void initializeSettings().catch(() => undefined);

    // Start background alarms/timers scheduler in the mobile webview
    const stopScheduler = startScheduler({
      speak: (text) => {
        speaker.say(text, loadSettings());
      },
      onAlert: (alert) => {
        if (!alert.missed) {
          speaker.say(`Alert: ${alert.title}. ${alert.body || ''}`, loadSettings());
        }
      },
    });

    return () => {
      stopScheduler();
    };
  }, []);

  return (
    <div className="safe-x flex min-h-dvh flex-col bg-base text-cream">
      <main className="safe-top min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-3">
        <Suspense fallback={<div role="status" className="mx-auto mt-8 w-full max-w-sm rounded-xl border border-line bg-raised p-4 text-center text-sm text-muted">Opening section…</div>}>{tab?.render()}</Suspense>
      </main>
      <nav
        aria-label="Sections"
        className="safe-bottom safe-x sticky bottom-0 z-50 flex shrink-0 border-t border-line bg-raised/95 backdrop-blur"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => setActive(t.id)}
              className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center px-1 py-2 transition-colors ${
                isActive ? 'text-face' : 'text-muted hover:text-cream'
              }`}
            >
              <Icon className="h-5 w-5 mb-0.5" />
              <span className="text-[11px] font-medium tracking-wide">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
