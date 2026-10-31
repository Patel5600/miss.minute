/**
 * Small building blocks shared by the panels, in the TVA amber/CRT look of the original
 * Timeline Monitor: dark amber glass cards, mono type, uppercase micro-labels.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

export const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-1 focus-visible:ring-offset-black';

export const inputClass = `bg-black/60 border border-amber-700/50 rounded px-2 py-1 text-amber-100 text-xs placeholder:text-amber-500/50 ${focusRing}`;

const TONES = {
  amber: 'bg-amber-600/30 hover:bg-amber-600/50 border-amber-500/40 text-amber-100',
  solid: 'bg-amber-500 hover:bg-amber-400 border-amber-400 text-neutral-950 font-bold',
  ghost: 'bg-transparent hover:bg-amber-900/40 border-amber-700/40 text-amber-300',
  danger: 'bg-red-900/60 hover:bg-red-800 border-red-500/50 text-red-100',
  quiet: 'bg-transparent hover:bg-amber-900/30 border-transparent text-amber-400/80 hover:text-amber-200',
} as const;

export type Tone = keyof typeof TONES;

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  type?: 'button' | 'submit';
  disabled?: boolean;
  title?: string;
  label?: string;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.label}
      aria-pressed={props.pressed}
      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${TONES[props.tone ?? 'amber']} ${focusRing} ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

/** Icon-only button; `label` is required for screen readers and the tooltip. */
export function IconButton(props: { label: string; onClick: () => void; children: ReactNode; tone?: Tone; disabled?: boolean; pressed?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      className={`inline-flex items-center justify-center w-7 h-7 rounded border transition-colors disabled:opacity-40 ${TONES[props.tone ?? 'ghost']} ${focusRing}`}
    >
      {props.children}
    </button>
  );
}

/** Two-step destructive action: the first click asks, the second does it. Escape cancels. */
export function ConfirmButton(props: {
  children: ReactNode;
  question: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  tone?: Tone;
  label?: string;
  iconOnly?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
  }, [asking]);
  if (!asking) {
    return props.iconOnly ? (
      <IconButton label={props.label ?? props.question} onClick={() => setAsking(true)} tone={props.tone ?? 'ghost'}>{props.children}</IconButton>
    ) : (
      <Button tone={props.tone ?? 'ghost'} onClick={() => setAsking(true)} label={props.label}>{props.children}</Button>
    );
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setAsking(false);
  };
  return (
    <span role="group" aria-label={props.question} className="inline-flex items-center gap-1 text-[11px] text-red-200" onKeyDown={onKey}>
      <span>{props.question}</span>
      <button
        ref={confirmRef}
        type="button"
        onClick={() => { setAsking(false); void props.onConfirm(); }}
        className={`px-2 py-0.5 rounded border ${TONES.danger} ${focusRing}`}
      >
        {props.confirmLabel ?? 'Yes'}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={`px-2 py-0.5 rounded border ${TONES.ghost} ${focusRing}`}>
        No
      </button>
    </span>
  );
}

export function PanelShell(props: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  alert?: boolean;
  className?: string;
  subtitle?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={`bg-amber-950/40 border ${props.alert ? 'border-red-500/50' : 'border-amber-600/30'} rounded-xl p-4 backdrop-blur-md shadow-2xl font-mono text-amber-200 flex flex-col gap-3 ${props.className ?? ''}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-600/20 pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${props.alert ? 'bg-red-500 motion-safe:animate-pulse' : 'bg-amber-400'}`} aria-hidden="true" />
          <span className="text-amber-400 flex-shrink-0" aria-hidden="true">{props.icon}</span>
          <h3 id={id} className="font-bold tracking-wider text-sm uppercase text-amber-300 truncate">{props.title}</h3>
          {props.subtitle ? <span className="text-[10px] text-amber-400/70 uppercase tracking-widest truncate">{props.subtitle}</span> : null}
        </div>
        {props.actions ? <div className="flex flex-wrap items-center gap-1.5">{props.actions}</div> : null}
      </header>
      {props.children}
    </section>
  );
}

export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[11px] text-red-300 bg-red-950/40 border border-red-700/40 rounded px-2 py-1">
      <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-amber-400/60 italic px-1 py-2">{children}</p>;
}

export function MicroLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return htmlFor
    ? <label htmlFor={htmlFor} className="text-[10px] uppercase tracking-widest text-amber-500">{children}</label>
    : <span className="text-[10px] uppercase tracking-widest text-amber-500">{children}</span>;
}

/** Accessible tab strip (arrow keys move between tabs). */
export function Tabs<T extends string>(props: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % props.tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + props.tabs.length) % props.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = props.tabs.length - 1;
    else return;
    event.preventDefault();
    props.onChange(props.tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={props.label} className="flex flex-wrap gap-1">
      {props.tabs.map((tab, index) => {
        const selected = tab.id === props.value;
        return (
          <button
            key={tab.id}
            ref={element => { refs.current[index] = element; }}
            role="tab"
            id={`${props.idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${props.idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(tab.id)}
            onKeyDown={event => onKeyDown(event, index)}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${focusRing} ${selected ? 'bg-amber-600/40 text-amber-100 font-semibold' : 'text-amber-400/70 hover:text-amber-200'}`}
          >
            {tab.label}{tab.count !== undefined ? ` (${tab.count})` : ''}
          </button>
        );
      })}
    </div>
  );
}
