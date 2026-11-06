import { useState } from 'react';
import { CalendarClock, Timer, BookUser, Activity } from 'lucide-react';
import { SacredTimeline } from '@desktop/panels/SacredTimeline';
import { Toolbelt } from '@desktop/panels/Toolbelt';
import { Dossier } from '@desktop/panels/Dossier';
import { ActivityLog } from '@desktop/panels/ActivityLog';
import { loadSettings, saveSettings } from '@desktop/agent/settings';

type SubPanel = 'timeline' | 'toolbelt' | 'dossier' | 'activity';

const SUB_PANELS: Array<{ id: SubPanel; label: string; icon: typeof Timer }> = [
  { id: 'timeline', label: 'Timeline', icon: CalendarClock },
  { id: 'toolbelt', label: 'Tools', icon: Timer },
  { id: 'dossier', label: 'Dossier', icon: BookUser },
  { id: 'activity', label: 'Activity', icon: Activity },
];

export function Panels() {
  const [active, setActive] = useState<SubPanel>('timeline');
  const [homeCity, setHomeCity] = useState(() => loadSettings().homeCity ?? '');

  const handleHomeCityChange = (city: string) => {
    setHomeCity(city);
    const current = loadSettings();
    saveSettings({ ...current, homeCity: city });
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* Sub-nav pills */}
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist">
        {SUB_PANELS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            onClick={() => setActive(id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors ${
              active === id
                ? 'border-amber-400 bg-amber-500/20 text-amber-50'
                : 'border-line bg-raised text-muted hover:border-amber-600/60'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-raised/80 p-3 sm:p-4">
        {active === 'timeline' && <SacredTimeline />}
        {active === 'toolbelt' && <Toolbelt />}
        {active === 'dossier' && (
          <Dossier homeCity={homeCity} onHomeCityChange={handleHomeCityChange} />
        )}
        {active === 'activity' && <ActivityLog />}
      </div>
    </div>
  );
}
