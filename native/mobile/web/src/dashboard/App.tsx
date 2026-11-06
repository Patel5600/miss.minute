import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Home as HomeIcon, MessageSquare, Layers, Settings as SettingsIcon } from 'lucide-react';
import { Home } from './screens/Home.tsx';
import { Chat } from './screens/Chat.tsx';
import { Panels } from './screens/Panels.tsx';
import { Settings } from './screens/Settings.tsx';
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
      <main className="safe-top flex-1 overflow-y-auto px-4 pb-4 pt-3">
        {tab?.render()}
      </main>
      <nav
        aria-label="Sections"
        className="safe-bottom safe-x sticky bottom-0 flex border-t border-line bg-raised/95 backdrop-blur z-50"
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
              className={`flex flex-col items-center justify-center h-14 flex-1 transition-colors ${
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
