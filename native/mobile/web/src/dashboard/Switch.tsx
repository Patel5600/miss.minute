interface SwitchProps {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

/** A labelled on/off switch with an accessible 48px+ touch target. */
export function Switch({ checked, label, description, disabled = false, onChange }: SwitchProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-cream">{label}</p>
        {description && <p className="mt-0.5 text-xs leading-snug text-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="flex h-12 w-16 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={`flex h-8 w-14 items-center rounded-full border px-1 transition-colors ${
            checked
              ? 'justify-end border-face bg-face'
              : 'justify-start border-white/[0.12] bg-[#0B0908]'
          }`}
        >
          <span
            className={`h-6 w-6 rounded-full shadow-sm transition-transform ${
              checked ? 'bg-[#110C07]' : 'bg-cream/90'
            }`}
          />
        </span>
      </button>
    </div>
  );
}
