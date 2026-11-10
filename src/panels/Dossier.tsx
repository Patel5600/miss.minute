/**
 * The TVA Variant Dossier, generated from long-term memory: everything Miss Minutes knows about
 * the owner, grouped like a case file, with when each fact was learned. Facts can be added,
 * edited, pinned and deleted; "forget everything" wipes the file.
 */
import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  Briefcase, FileText, FingerprintPattern, Heart, MapPin, Pencil, Pin, PinOff, Plus, Repeat, Save, Trash, User, Users,
} from 'lucide-react';
import { useDbList, useNow } from '../store/useDb';
import type { MemoryCategory, MemoryRecord } from '../store/db';
import { MEMORY_CATEGORIES } from '../agent/memory/store';
import { ToolInputError } from '../agent/tools/args';
import { geocode } from '../agent/tools/geo';
import { addMemoryManually, editMemory, forgetAllMemories, setMemoryPinned } from '../agent/tools/memory';
import { MINUTE, formatDay, formatWhen } from '../agent/tools/time';
import { deleteMemory } from '../agent/memory/store';
import { Button, ConfirmButton, Empty, ErrorLine, IconButton, MicroLabel, PanelShell, inputClass } from './ui';
import { useAction } from './useAction';

export interface DossierProps {
  className?: string;
  /** Home city from settings; weather and clocks default to it. */
  homeCity?: string;
  /**
   * Lets the owner set the home city here. Receives a geocoded "City, Region, Country" label.
   * Without it the home city is shown read-only.
   */
  onHomeCityChange?: (city: string) => void;
}

const SECTIONS: Array<{ category: MemoryCategory; title: string; icon: ReactNode }> = [
  { category: 'identity', title: 'Identity', icon: <User className="w-3.5 h-3.5" /> },
  { category: 'place', title: 'Location', icon: <MapPin className="w-3.5 h-3.5" /> },
  { category: 'preference', title: 'Preferences', icon: <Heart className="w-3.5 h-3.5" /> },
  { category: 'person', title: 'People', icon: <Users className="w-3.5 h-3.5" /> },
  { category: 'project', title: 'Projects', icon: <Briefcase className="w-3.5 h-3.5" /> },
  { category: 'routine', title: 'Routines', icon: <Repeat className="w-3.5 h-3.5" /> },
  { category: 'other', title: 'Other evidence', icon: <FileText className="w-3.5 h-3.5" /> },
];

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  identity: 'Identity', place: 'Location', preference: 'Preference', person: 'Person', project: 'Project', routine: 'Routine', other: 'Other',
};

const SOURCE_LABEL: Record<MemoryRecord['source'], string> = {
  chat: 'picked up in conversation',
  tool: 'Miss Minutes was asked to remember',
  manual: 'added by you',
};

function sortFacts(facts: MemoryRecord[]): MemoryRecord[] {
  return [...facts].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
}

function FactRow({ fact, now }: { fact: MemoryRecord; now: number }) {
  const ids = useId();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);
  const [category, setCategory] = useState<MemoryCategory>(fact.category);
  const updated = fact.updatedAt - fact.createdAt > MINUTE;

  const startEdit = () => {
    setText(fact.text);
    setCategory(fact.category);
    setEditing(true);
  };
  const save = () => action.run(async () => {
    await editMemory(fact.id, text, category);
    setEditing(false);
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setEditing(false);
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };

  if (editing) {
    return (
      <li className="rounded border border-amber-500/50 bg-black/40 p-2 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-end gap-2" onKeyDown={onKey}>
          <div className="flex flex-col gap-0.5 flex-1 min-w-[12rem]">
            <MicroLabel htmlFor={`${ids}-text`}>Fact</MicroLabel>
            <input id={`${ids}-text`} className={inputClass} value={text} onChange={event => setText(event.target.value)} maxLength={280} autoFocus />
          </div>
          <div className="flex flex-col gap-0.5">
            <MicroLabel htmlFor={`${ids}-category`}>Section</MicroLabel>
            <select id={`${ids}-category`} className={inputClass} value={category} onChange={event => setCategory(event.target.value as MemoryCategory)}>
              {MEMORY_CATEGORIES.map(option => <option key={option} value={option}>{CATEGORY_LABEL[option]}</option>)}
            </select>
          </div>
          <Button tone="solid" onClick={save} disabled={action.busy}><Save className="w-3 h-3" /> Save</Button>
          <Button tone="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
        <ErrorLine message={action.error} />
      </li>
    );
  }

  return (
    <li className={`group rounded border px-2 py-1.5 flex items-start gap-2 ${fact.pinned ? 'border-amber-500/50 bg-amber-900/20' : 'border-amber-800/30 bg-black/25'}`}>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-amber-100 break-words">{fact.text}</p>
        <p className="text-[10px] text-amber-400/60">
          Learned {formatDay(fact.createdAt, now)}, {SOURCE_LABEL[fact.source]}
          {updated ? ` · updated ${formatWhen(fact.updatedAt, now)}` : ''}
        </p>
        <ErrorLine message={action.error} />
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <IconButton
          label={fact.pinned ? `Unpin: ${fact.text}` : `Pin: ${fact.text}`}
          pressed={Boolean(fact.pinned)}
          onClick={() => action.run(() => setMemoryPinned(fact.id, !fact.pinned))}
          tone={fact.pinned ? 'amber' : 'ghost'}
        >
          {fact.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
        </IconButton>
        <IconButton label={`Edit: ${fact.text}`} onClick={startEdit}><Pencil className="w-3.5 h-3.5" /></IconButton>
        <ConfirmButton iconOnly label={`Delete: ${fact.text}`} question="Forget this?" confirmLabel="Forget" onConfirm={() => action.run(() => deleteMemory(fact.id))}>
          <Trash className="w-3.5 h-3.5" />
        </ConfirmButton>
      </div>
    </li>
  );
}

function HomeCity({ homeCity, onChange }: { homeCity?: string; onChange?: (city: string) => void }) {
  const ids = useId();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(homeCity ?? '');
  const [resolved, setResolved] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.run(async () => {
      if (!value.trim()) throw new ToolInputError('Type a city, e.g. "Pune" or "Portland, Oregon".');
      const place = await geocode(value);
      onChange?.(place.label);
      setResolved(`${place.label} (${place.timezone})`);
      setEditing(false);
    });
  };

  return (
    <div className="rounded border border-amber-700/40 bg-black/30 px-2 py-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <MicroLabel>Home city</MicroLabel>
          <p className="text-[12px] text-amber-100">{homeCity?.trim() || 'Not set'}</p>
          <p className="text-[10px] text-amber-400/60">Used for weather and local time when no city is named.</p>
        </div>
        {onChange && !editing ? (
          <Button tone="ghost" onClick={() => { setValue(homeCity ?? ''); setEditing(true); }}><Pencil className="w-3 h-3" /> {homeCity ? 'Change' : 'Set'}</Button>
        ) : null}
        {!onChange ? <span className="text-[10px] text-amber-400/60">Change it in Settings.</span> : null}
      </div>
      {editing ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
            <MicroLabel htmlFor={`${ids}-city`}>City</MicroLabel>
            <input id={`${ids}-city`} className={inputClass} value={value} onChange={event => setValue(event.target.value)} maxLength={120} placeholder="City, Country" autoFocus />
          </div>
          <Button type="submit" tone="solid" disabled={action.busy}>{action.busy ? 'Checking...' : 'Save'}</Button>
          <Button tone="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      ) : null}
      {resolved && !editing ? <p role="status" className="text-[10px] text-emerald-300">Home city set to {resolved}.</p> : null}
      <ErrorLine message={action.error} />
    </div>
  );
}

export function Dossier({ className, homeCity, onHomeCityChange }: DossierProps) {
  const ids = useId();
  const now = useNow(60_000);
  const action = useAction();
  const { data: memories = [], loading, error } = useDbList('memories');
  const [text, setText] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('identity');
  const [notice, setNotice] = useState<string | null>(null);

  const byCategory = new Map<MemoryCategory, MemoryRecord[]>();
  for (const memory of memories) byCategory.set(memory.category, [...(byCategory.get(memory.category) ?? []), memory]);
  const identity = sortFacts(byCategory.get('identity') ?? []);
  const subject = identity[0];
  const opened = memories.length > 0 ? Math.min(...memories.map(memory => memory.createdAt)) : undefined;
  const lastUpdated = memories.length > 0 ? Math.max(...memories.map(memory => memory.updatedAt)) : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.run(async () => {
      const { record, created } = await addMemoryManually(text, category);
      setNotice(created ? `Filed under ${CATEGORY_LABEL[record.category]}.` : `Updated a similar fact: "${record.text}".`);
      setText('');
    });
  };

  return (
    <PanelShell
      title="TVA Variant Dossier"
      icon={<FingerprintPattern className="w-4 h-4" />}
      className={`relative overflow-hidden ${className ?? ''}`}
      subtitle={`${memories.length} fact${memories.length === 1 ? '' : 's'} on file`}
      actions={memories.length > 0 ? (
        <ConfirmButton
          question={`Forget all ${memories.length} facts?`}
          confirmLabel="Forget everything"
          tone="danger"
          onConfirm={() => action.run(async () => { await forgetAllMemories(); setNotice('The dossier was wiped. Miss Minutes no longer remembers anything about you.'); })}
        >
          <Trash className="w-3 h-3" /> Forget everything
        </ConfirmButton>
      ) : null}
    >
      <div className="absolute -right-6 -bottom-6 opacity-10 pointer-events-none select-none text-7xl font-black rotate-12 text-amber-500" aria-hidden="true">TVA</div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div className="sm:col-span-3 bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <MicroLabel>Subject</MicroLabel>
          <span className="font-semibold text-amber-200 break-words">{subject ? subject.text : 'Unidentified variant: no identity facts on file yet.'}</span>
        </div>
        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <MicroLabel>File opened</MicroLabel>
          <span>{opened !== undefined ? formatDay(opened, now) : 'Not yet'}</span>
        </div>
        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <MicroLabel>Last entry</MicroLabel>
          <span>{lastUpdated !== undefined ? formatWhen(lastUpdated, now) : 'None'}</span>
        </div>
        <div className="bg-black/30 p-2 rounded border border-amber-800/20 flex flex-col">
          <MicroLabel>Pinned</MicroLabel>
          <span>{memories.filter(memory => memory.pinned).length}</span>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 bg-black/30 border border-amber-800/30 rounded-lg p-2.5" aria-label="Add a fact to the dossier">
        <div className="flex flex-col gap-0.5">
          <MicroLabel htmlFor={`${ids}-category`}>Section</MicroLabel>
          <select id={`${ids}-category`} className={inputClass} value={category} onChange={event => setCategory(event.target.value as MemoryCategory)}>
            {MEMORY_CATEGORIES.map(option => <option key={option} value={option}>{CATEGORY_LABEL[option]}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-[12rem]">
          <MicroLabel htmlFor={`${ids}-fact`}>Fact</MicroLabel>
          <input id={`${ids}-fact`} className={inputClass} value={text} onChange={event => setText(event.target.value)} maxLength={280} placeholder="Prefers to be called Irshad" required />
        </div>
        <Button type="submit" tone="solid" disabled={action.busy}><Plus className="w-3.5 h-3.5" /> File it</Button>
        <div className="w-full flex flex-col gap-1">
          <ErrorLine message={action.error ?? (error ? `Could not read memories: ${error}` : null)} />
          {notice ? <p role="status" className="text-[11px] text-emerald-300">{notice}</p> : null}
        </div>
      </form>

      {loading ? <Empty>Opening the file...</Empty> : null}
      {!loading && memories.length === 0 ? (
        <Empty>No file on this variant yet. Miss Minutes adds facts as you talk (when memory is on), or file one above.</Empty>
      ) : null}

      <div className="flex flex-col gap-3 max-h-[32rem] overflow-y-auto pr-1">
        {SECTIONS.map(section => {
          const facts = sortFacts(byCategory.get(section.category) ?? []);
          const showHome = section.category === 'place';
          if (facts.length === 0 && !showHome) return null;
          return (
            <section key={section.category} aria-label={section.title} className="flex flex-col gap-1.5">
              <h4 className="flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-[0.2em] text-amber-400">
                <span aria-hidden="true">{section.icon}</span>{section.title}
                <span className="text-amber-500/60 font-normal">({facts.length})</span>
              </h4>
              {showHome ? <HomeCity homeCity={homeCity} onChange={onHomeCityChange} /> : null}
              <ul className="flex flex-col gap-1">
                {facts.map(fact => <FactRow key={`${fact.id}:${fact.updatedAt}`} fact={fact} now={now} />)}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-amber-700/20 text-[10px] text-amber-400/70">
        <span className="flex items-center gap-1"><FingerprintPattern className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" /> Stored only on this device</span>
        <span className="font-bold text-amber-400">For all time. Always.</span>
      </div>
    </PanelShell>
  );
}
