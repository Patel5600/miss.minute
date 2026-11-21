/**
 * Offer Verification & Weighted Ranking Radar (50% legitimacy, 35% fit, 15% clarity).
 * Filters out offers carrying hard scam flags or red-flag language.
 */
import { useState } from 'react';
import { Plus, Radar, ShieldAlert, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useDbList } from '../store/useDb';
import type { OfferListing, TrustSignals } from '../desktop/bridge';
import { clearSavedOffers, evaluateAndSaveOffers } from '../agent/tools/offers';
import { formatWhen } from '../agent/tools/time';
import { Button, ConfirmButton, Empty, ErrorLine, MicroLabel, PanelShell, inputClass } from './ui';
import { useAction } from './useAction';

export interface OffersPanelProps {
  className?: string;
}

const SAMPLE_LISTINGS: OfferListing[] = [
  {
    id: 'trusted-cloud-gpu',
    title: 'Reserved Workstation Node — Standard SLA',
    source_domain: 'compute.example.org',
    base_legitimacy_score: 84,
    fit_score: 88,
    clarity_score: 90,
    signals: {
      verified_domain: true,
      transparent_terms_present: true,
      requires_upfront_fee_or_wire: false,
      asks_off_platform_payment: false,
      typosquatted_or_suspicious_url: false,
      impossible_roi_or_urgency_pressure: false,
      opaque_contact_or_masked_redirect: false,
    },
  },
  {
    id: 'sketchy-wire-deal',
    title: 'Guaranteed 500% Rebate — Kindly Pay Upfront',
    source_domain: 'fast-rebates-wire.example.invalid',
    base_legitimacy_score: 70,
    fit_score: 95,
    clarity_score: 60,
    signals: {
      verified_domain: false,
      transparent_terms_present: false,
      requires_upfront_fee_or_wire: true,
      asks_off_platform_payment: true,
      typosquatted_or_suspicious_url: true,
      impossible_roi_or_urgency_pressure: true,
      opaque_contact_or_masked_redirect: false,
    },
  },
];

function ScoreBar({ label, weight, score }: { label: string; weight: string; score: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(score)));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#CBBEB0]">
          {label} <span className="text-[#786B5E]">({weight})</span>
        </span>
        <span className="font-mono text-[#FFF8EE]">{score.toFixed(1)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/50">
        <div className="h-full rounded-full bg-[#FF7A1A]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const DEFAULT_SIGNALS: TrustSignals = {
  verified_domain: true,
  transparent_terms_present: true,
  requires_upfront_fee_or_wire: false,
  asks_off_platform_payment: false,
  typosquatted_or_suspicious_url: false,
  impossible_roi_or_urgency_pressure: false,
  opaque_contact_or_masked_redirect: false,
};

export function OffersPanel({ className }: OffersPanelProps) {
  const { data: offers = [], loading, error: loadError } = useDbList(
    'offers',
    rows => [...rows].sort((a, b) => Number(a.rejectedAsScam) - Number(b.rejectedAsScam) || b.totalScore - a.totalScore || b.updatedAt - a.updatedAt),
  );
  const action = useAction();

  const [query, setQuery] = useState('Workstation compute comparison');
  const [candidates, setCandidates] = useState<OfferListing[]>(SAMPLE_LISTINGS);
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [legScore, setLegScore] = useState(80);
  const [fitScore, setFitScore] = useState(75);
  const [clarityScore, setClarityScore] = useState(80);
  const [signals, setSignals] = useState<TrustSignals>({ ...DEFAULT_SIGNALS });

  const addCandidate = () => {
    if (!title.trim()) return;
    const item: OfferListing = {
      id: `offer-${Date.now().toString(36)}-${candidates.length + 1}`,
      title: title.trim(),
      source_domain: domain.trim() || 'unknown.example',
      base_legitimacy_score: Math.min(100, Math.max(0, legScore)),
      fit_score: Math.min(100, Math.max(0, fitScore)),
      clarity_score: Math.min(100, Math.max(0, clarityScore)),
      signals: { ...signals },
    };
    setCandidates(prev => [...prev, item]);
    setTitle('');
    setDomain('');
    setSignals({ ...DEFAULT_SIGNALS });
  };

  const toggleSignal = (key: keyof TrustSignals) => {
    setSignals(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <PanelShell
      title="Offers Radar"
      icon={<Radar className="h-4 w-4" />}
      className={className}
      subtitle={`${offers.filter(o => !o.rejectedAsScam).length} verified · ${offers.filter(o => o.rejectedAsScam).length} blocked`}
      actions={
        offers.length > 0 ? (
          <ConfirmButton
            question="Clear all ranked offers?"
            confirmLabel="Clear"
            tone="ghost"
            onConfirm={() => action.run(() => clearSavedOffers())}
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </ConfirmButton>
        ) : null
      }
    >
      <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MicroLabel htmlFor="offers-query-input">Comparison Topic</MicroLabel>
          <Button
            tone="ghost"
            onClick={() => setCandidates(SAMPLE_LISTINGS)}
            className="min-h-11"
          >
            <Sparkles className="h-3.5 w-3.5" /> Load Sample Set
          </Button>
        </div>

        <input
          id="offers-query-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="What are you comparing?"
          className={`${inputClass} min-h-11 w-full`}
        />

        <div className="space-y-2 rounded-2xl border border-white/[0.06] bg-[#0E0B08] p-3">
          <MicroLabel>Add Candidate Listing</MicroLabel>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Listing title"
              aria-label="Listing title"
              className={`${inputClass} min-h-11`}
            />
            <input
              value={domain}
              onChange={e => setDomain(e.target.value)}
              placeholder="source_domain (e.g. vendor.com)"
              aria-label="Source domain"
              className={`${inputClass} min-h-11`}
            />
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <label className="space-y-1 text-[#CBBEB0]">
              <span>Legit (0–100)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={legScore}
                onChange={e => setLegScore(Number(e.target.value) || 0)}
                className={`${inputClass} min-h-11 w-full font-mono`}
              />
            </label>
            <label className="space-y-1 text-[#CBBEB0]">
              <span>Fit (0–100)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={fitScore}
                onChange={e => setFitScore(Number(e.target.value) || 0)}
                className={`${inputClass} min-h-11 w-full font-mono`}
              />
            </label>
            <label className="space-y-1 text-[#CBBEB0]">
              <span>Clarity (0–100)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={clarityScore}
                onChange={e => setClarityScore(Number(e.target.value) || 0)}
                className={`${inputClass} min-h-11 w-full font-mono`}
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-1.5 pt-1 text-xs text-[#CBBEB0] sm:grid-cols-2">
            {(
              [
                ['verified_domain', 'Verified domain (+10 legit)'],
                ['transparent_terms_present', 'Transparent terms (+5 legit)'],
                ['requires_upfront_fee_or_wire', 'Red flag: upfront fee / wire'],
                ['asks_off_platform_payment', 'Red flag: off-platform payment'],
                ['typosquatted_or_suspicious_url', 'Red flag: suspicious / typosquatted domain'],
                ['impossible_roi_or_urgency_pressure', 'Red flag: impossible ROI / urgency'],
                ['opaque_contact_or_masked_redirect', 'Red flag: opaque contact / redirect'],
              ] as Array<[keyof TrustSignals, string]>
            ).map(([key, label]) => (
              <label key={key} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-2 py-1 hover:bg-white/[0.03]">
                <input
                  type="checkbox"
                  checked={signals[key]}
                  onChange={() => toggleSignal(key)}
                  className="h-4 w-4 accent-[#FF7A1A]"
                />
                <span className="truncate">{label}</span>
              </label>
            ))}
          </div>
          <Button
            tone="ghost"
            onClick={addCandidate}
            disabled={!title.trim()}
            className="min-h-11 w-full justify-center"
          >
            <Plus className="h-3.5 w-3.5" /> Add Candidate to Batch ({candidates.length})
          </Button>
        </div>

        {candidates.length > 0 && (
          <div className="space-y-1.5">
            <MicroLabel>Queued for Scoring ({candidates.length})</MicroLabel>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map(c => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-black/30 px-2.5 py-1 text-xs text-[#F5EFE6]"
                >
                  <span className="max-w-[180px] truncate">{c.title}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${c.title}`}
                    onClick={() => setCandidates(prev => prev.filter(x => x.id !== c.id))}
                    className="cursor-pointer text-[#9D9082] hover:text-red-300"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        <Button
          tone="solid"
          disabled={action.busy || candidates.length === 0}
          onClick={() => action.run(() => evaluateAndSaveOffers(query, candidates))}
          className="min-h-12 w-full justify-center"
        >
          <Radar className="h-4 w-4" />
          {action.busy ? 'Evaluating Signals…' : 'Evaluate & Rank Offers (50/35/15)'}
        </Button>
        <ErrorLine message={action.error} />
      </div>

      <ErrorLine message={loadError} />

      {loading ? (
        <Empty>Loading saved offers…</Empty>
      ) : offers.length === 0 ? (
        <Empty>No offers ranked yet. Run a comparison above or ask Miss Minutes in chat.</Empty>
      ) : (
        <ul className="space-y-3">
          {offers.map(item => (
            <li
              key={item.id}
              className={`space-y-2.5 rounded-2xl border p-3.5 ${
                item.rejectedAsScam
                  ? 'border-red-500/45 bg-red-950/20'
                  : 'border-white/[0.08] bg-[#16120E]'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {item.rejectedAsScam ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/45 bg-red-950/50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-200">
                        <ShieldAlert className="h-3 w-3" /> Scam Rejected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-950/35 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                        <ShieldCheck className="h-3 w-3" /> Verified
                      </span>
                    )}
                    <span className="truncate font-mono text-[11px] text-[#9D9082]">{item.sourceDomain || 'unknown'}</span>
                  </div>
                  <p className="mt-1 break-words text-sm font-semibold text-[#FFF8EE]">{item.title}</p>
                  <p className="text-[11px] text-[#9D9082]">
                    {item.query} · {formatWhen(item.updatedAt)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`font-mono text-xl font-bold tabular-nums ${item.rejectedAsScam ? 'text-red-300' : 'text-[#FF9240]'}`}>
                    {item.totalScore.toFixed(1)}
                  </span>
                  <span className="block text-[10px] text-[#9D9082]">/ 100</span>
                </div>
              </div>

              {item.rejectedAsScam ? (
                <div className="flex flex-wrap gap-1.5">
                  {item.scamFlags.map(flag => (
                    <span
                      key={flag}
                      className="rounded-lg border border-red-500/35 bg-red-950/40 px-2 py-0.5 font-mono text-[10px] text-red-200"
                    >
                      {flag}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 border-t border-white/[0.06] pt-2 sm:grid-cols-3">
                  <ScoreBar label="Legitimacy" weight="50%" score={item.legitimacyScore * 2} />
                  <ScoreBar label="Fit" weight="35%" score={(item.fitScore / 0.35)} />
                  <ScoreBar label="Clarity" weight="15%" score={(item.clarityScore / 0.15)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}
