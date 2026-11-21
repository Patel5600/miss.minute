/**
 * Shared UI building blocks for TVA workspace panels (Sacred Timeline, Toolbelt, Dossier, Activity):
 * obsidian cards, warm editorial contrast, accessible keyboard controls, and clockwork amber focus states.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0B0908]';

export const inputClass =
  `bg-[#0E0B08] border border-white/[0.12] rounded-xl px-3 py-1.5 text-[#F5EFE6] text-xs placeholder:text-[#786B5E] transition-colors focus:border-[#FF7A1A]/60 ${focusRing}`;

const TONES = {
  amber: 'bg-[#FF7A1A]/15 hover:bg-[#FF7A1A]/25 border-[#FF7A1A]/35 text-[#FFD9B3]',
  solid: 'bg-[#FF7A1A] hover:bg-[#FF903B] border-[#FF7A1A] text-[#110C07] font-semibold',
  ghost: 'bg-white/[0.03] hover:bg-white/[0.08] border-white/[0.1] text-[#CBBEB0] hover:text-[#F5EFE6]',
  danger: 'bg-red-950/60 hover:bg-red-900/70 border-red-500/40 text-red-200',
  quiet: 'bg-transparent hover:bg-white/[0.06] border-transparent text-[#9D9082] hover:text-[#F5EFE6]',
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
      className={`inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs rounded-xl border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${TONES[props.tone ?? 'amber']} ${focusRing} ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

/** Icon-only button; `label` is required for screen readers and the tooltip. */
export function IconButton(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: Tone;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      className={`inline-flex cursor-pointer items-center justify-center w-8 h-8 rounded-xl border transition-colors disabled:opacity-40 ${TONES[props.tone ?? 'ghost']} ${focusRing}`}
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
      <IconButton label={props.label ?? props.question} onClick={() => setAsking(true)} tone={props.tone ?? 'ghost'}>
        {props.children}
      </IconButton>
    ) : (
      <Button tone={props.tone ?? 'ghost'} onClick={() => setAsking(true)} label={props.label}>
        {props.children}
      </Button>
    );
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setAsking(false);
  };
  return (
    <span role="group" aria-label={props.question} className="inline-flex items-center gap-1.5 text-xs text-red-200" onKeyDown={onKey}>
      <span>{props.question}</span>
      <button
        ref={confirmRef}
        type="button"
        onClick={() => { setAsking(false); void props.onConfirm(); }}
        className={`cursor-pointer px-2.5 py-1 rounded-lg border ${TONES.danger} ${focusRing}`}
      >
        {props.confirmLabel ?? 'Yes'}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={`cursor-pointer px-2.5 py-1 rounded-lg border ${TONES.ghost} ${focusRing}`}>
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
      className={`bg-[#14100C] border ${
        props.alert ? 'border-red-500/45' : 'border-white/[0.08]'
      } rounded-2xl p-4 sm:p-5 shadow-[0_14px_40px_rgba(0,0,0,0.45)] text-[#F5EFE6] flex flex-col gap-3.5 ${props.className ?? ''}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${props.alert ? 'bg-red-500 motion-safe:animate-pulse' : 'bg-[#FF7A1A]'}`}
            aria-hidden="true"
          />
          <span className="text-[#FF9240] flex-shrink-0" aria-hidden="true">{props.icon}</span>
          <h3 id={id} className="font-semibold tracking-tight text-base text-[#FFF8EE] truncate">
            {props.title}
          </h3>
          {props.subtitle ? (
            <span className="text-[11px] font-medium text-[#9D9082] truncate">· {props.subtitle}</span>
          ) : null}
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
    <p role="alert" className="flex items-start gap-1.5 text-xs text-red-300 bg-red-950/35 border border-red-500/35 rounded-xl px-3 py-2">
      <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-[#9D9082] px-1 py-2">{children}</p>;
}

export function MicroLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return htmlFor
    ? <label htmlFor={htmlFor} className="text-[11px] font-medium uppercase tracking-wider text-[#9D9082]">{children}</label>
    : <span className="text-[11px] font-medium uppercase tracking-wider text-[#9D9082]">{children}</span>;
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
    <div role="tablist" aria-label={props.label} className="flex flex-wrap gap-1.5">
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
            className={`cursor-pointer px-3 py-1.5 text-xs rounded-xl border transition-colors ${focusRing} ${
              selected
                ? 'border-[#FF7A1A]/40 bg-[#FF7A1A]/15 text-[#FFF4E4] font-semibold'
                : 'border-white/[0.06] bg-white/[0.02] text-[#9D9082] hover:text-[#F5EFE6]'
            }`}
          >
            {tab.label}{tab.count !== undefined ? ` (${tab.count})` : ''}
          </button>
        );
      })}
    </div>
  );
}
