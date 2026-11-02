interface SwitchProps {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

/** A labelled on/off switch with a 48 px touch target. */
export function Switch({ checked, label, description, disabled = false, onChange }: SwitchProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-base text-cream">{label}</p>
        {description && <p className="mt-0.5 text-sm leading-snug text-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="flex h-12 w-16 shrink-0 items-center justify-center disabled:opacity-50"
      >
        <span className={`flex h-8 w-14 items-center rounded-full px-1 transition-colors ${checked ? 'justify-end bg-face' : 'justify-start bg-line'}`}>
          <span className="h-6 w-6 rounded-full bg-cream" />
        </span>
      </button>
    </div>
  );
}
