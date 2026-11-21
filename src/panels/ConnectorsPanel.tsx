/**
 * External MCP Connector Importer & Server-Derived Side-Effect Classifier panel.
 * Untrusted MCP manifests default to >= 'external' even when claiming readOnlyHint: true.
 * 'financial' connectors can never be downgraded below 'financial'.
 */
import { useMemo, useState } from 'react';
import { Lock, Plug, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useDbList } from '../store/useDb';
import type { SideEffectTier } from '../desktop/bridge';
import {
  SIDE_EFFECT_TIERS,
  importAndSaveConnector,
  parseMcpToolJson,
  reclassifyAndSaveConnector,
  removeConnector,
} from '../agent/tools/connectors';
import { formatWhen } from '../agent/tools/time';
import { Button, ConfirmButton, Empty, ErrorLine, MicroLabel, PanelShell, inputClass } from './ui';
import { useAction } from './useAction';

export interface ConnectorsPanelProps {
  className?: string;
}

const SAMPLE_READONLY_SPOOF = JSON.stringify(
  {
    name: 'fetch_workspace_docs',
    description: 'Fetches external documentation over HTTPS',
    readOnlyHint: true,
    destructiveHint: false,
  },
  null,
  2,
);

const SAMPLE_FINANCIAL = JSON.stringify(
  {
    name: 'submit_wire_payment',
    description: 'Initiates vendor payment and checkout transfer',
    readOnlyHint: false,
    destructiveHint: false,
  },
  null,
  2,
);

const TIER_BADGE: Record<SideEffectTier, string> = {
  read_only: 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300',
  local_write: 'border-sky-500/40 bg-sky-950/35 text-sky-300',
  external: 'border-[#FF7A1A]/45 bg-[#FF7A1A]/15 text-[#FFD9B3]',
  destructive: 'border-orange-500/45 bg-orange-950/40 text-orange-200',
  financial: 'border-red-500/50 bg-red-950/45 text-red-200',
};

export function ConnectorsPanel({ className }: ConnectorsPanelProps) {
  const { data: connectors = [], loading, error: loadError } = useDbList(
    'connectors',
    rows => [...rows].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const action = useAction();

  const [serverName, setServerName] = useState('docs-server');
  const [toolJson, setToolJson] = useState(SAMPLE_READONLY_SPOOF);
  const [tierDraft, setTierDraft] = useState<Record<string, SideEffectTier>>({});

  const preview = useMemo(() => {
    try {
      const manifest = parseMcpToolJson(serverName, toolJson);
      return { ok: true as const, manifest };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [serverName, toolJson]);

  return (
    <PanelShell
      title="MCP Connectors"
      icon={<Plug className="h-4 w-4" />}
      className={className}
      subtitle={`${connectors.length} registered`}
    >
      <div className="flex items-start gap-2 rounded-xl border border-[#FF7A1A]/35 bg-[#FF7A1A]/10 px-3 py-2 text-xs text-[#FFD9B3]">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF9240]" aria-hidden="true" />
        <p className="min-w-0 leading-relaxed">
          Server-derived trust: external MCP tools default to at least{' '}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">external</code> regardless of{' '}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">readOnlyHint</code>.{' '}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">financial</code> tools cannot be downgraded.
        </p>
      </div>

      <div className="space-y-3 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5">
        <div className="flex flex-wrap gap-2">
          <Button
            tone="ghost"
            onClick={() => { setServerName('docs-server'); setToolJson(SAMPLE_READONLY_SPOOF); }}
            className="min-h-11"
          >
            Test readOnlyHint Spoof
          </Button>
          <Button
            tone="ghost"
            onClick={() => { setServerName('billing-mcp'); setToolJson(SAMPLE_FINANCIAL); }}
            className="min-h-11"
          >
            Test Financial Classifier
          </Button>
        </div>

        <label className="block space-y-1 text-xs">
          <MicroLabel htmlFor="mcp-server-name">Server Identifier</MicroLabel>
          <input
            id="mcp-server-name"
            value={serverName}
            onChange={e => setServerName(e.target.value)}
            placeholder="e.g. docs-server"
            className={`${inputClass} min-h-11 w-full font-mono`}
          />
        </label>

        <label className="block space-y-1 text-xs">
          <MicroLabel htmlFor="mcp-tool-json">MCP Tool JSON Manifest</MicroLabel>
          <textarea
            id="mcp-tool-json"
            rows={6}
            value={toolJson}
            onChange={e => setToolJson(e.target.value)}
            spellCheck={false}
            className={`${inputClass} w-full resize-y font-mono text-[11px]`}
          />
        </label>

        {preview.ok ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#0E0B08] px-3 py-2 text-xs">
            <span className="truncate font-mono text-[#FFF8EE]">{preview.manifest.id}</span>
            <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-semibold uppercase ${TIER_BADGE[preview.manifest.derived_side_effect]}`}>
              Derived: {preview.manifest.derived_side_effect}
            </span>
          </div>
        ) : (
          <ErrorLine message={preview.error} />
        )}

        <ConfirmButton
          question="Import untrusted MCP connector?"
          confirmLabel="Confirm Import"
          tone="solid"
          onConfirm={() => action.run(() => importAndSaveConnector(serverName, toolJson))}
        >
          <Plus className="h-4 w-4" /> Import MCP Connector
        </ConfirmButton>
        <ErrorLine message={action.error} />
      </div>

      <ErrorLine message={loadError} />

      {loading ? (
        <Empty>Loading registered connectors…</Empty>
      ) : connectors.length === 0 ? (
        <Empty>No external MCP connectors imported yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {connectors.map(conn => {
            const targetTier = tierDraft[conn.id] ?? conn.derivedSideEffect;
            const lockedFinancial = conn.derivedSideEffect === 'financial';
            return (
              <li
                key={conn.id}
                className="space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#16120E] p-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="break-all font-mono text-xs font-semibold text-[#FFF8EE]">{conn.id}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${TIER_BADGE[conn.derivedSideEffect]}`}>
                        {lockedFinancial && <Lock className="h-2.5 w-2.5" />}
                        {conn.derivedSideEffect}
                      </span>
                      {conn.ownerApprovedReclassification && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-950/30 px-2 py-0.5 text-[10px] text-emerald-300">
                          <ShieldCheck className="h-2.5 w-2.5" /> Reclassified
                        </span>
                      )}
                    </div>
                    {conn.description && (
                      <p className="mt-1 break-words text-xs text-[#CBBEB0]">{conn.description}</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-[#9D9082]">
                      Server: {conn.serverName} · {formatWhen(conn.updatedAt)}
                    </p>
                  </div>
                  <ConfirmButton
                    iconOnly
                    label={`Remove connector ${conn.id}`}
                    question="Remove?"
                    onConfirm={() => action.run(() => removeConnector(conn.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </ConfirmButton>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2">
                  <select
                    aria-label={`Reclassify tier for ${conn.id}`}
                    value={targetTier}
                    disabled={lockedFinancial}
                    onChange={e => setTierDraft(prev => ({ ...prev, [conn.id]: e.target.value as SideEffectTier }))}
                    className={`${inputClass} min-h-11`}
                  >
                    {SIDE_EFFECT_TIERS.map(tier => (
                      <option
                        key={tier}
                        value={tier}
                        disabled={lockedFinancial && tier !== 'financial'}
                      >
                        {tier}
                      </option>
                    ))}
                  </select>
                  {lockedFinancial ? (
                    <span className="text-[11px] text-red-200">
                      Financial tier is permanently locked against downgrades.
                    </span>
                  ) : (
                    <ConfirmButton
                      question={`Reclassify ${conn.name} to ${targetTier}?`}
                      confirmLabel="Approve"
                      tone="amber"
                      onConfirm={() =>
                        action.run(() => reclassifyAndSaveConnector(conn.id, targetTier, true))
                      }
                    >
                      Reclassify Tier
                    </ConfirmButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PanelShell>
  );
}
