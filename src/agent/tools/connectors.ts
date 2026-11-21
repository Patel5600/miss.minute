/**
 * MCP tool importer and server-derived side-effect classifier.
 * Untrusted MCP tools default to at least 'external' even if they claim readOnlyHint: true,
 * and 'financial' tools can never be downgraded below 'financial'.
 */
import {
  importMcpTool,
  isDesktopRuntime,
  reclassifyMcpTool,
  type SideEffectTier,
  type ToolManifest,
} from '../../desktop/bridge.ts';
import { deleteRecord, listAll, putRecord, type ConnectorRecord } from '../../store/db.ts';
import { optionalBoolean, requiredEnum, requiredText, ToolInputError, type RawArgs } from './args.ts';
import { makeTool } from './define.ts';
import type { ToolContext } from './types.ts';

export const SIDE_EFFECT_TIERS: readonly SideEffectTier[] = [
  'read_only',
  'local_write',
  'external',
  'destructive',
  'financial',
];

const SIDE_EFFECT_RANK: Record<SideEffectTier, number> = {
  read_only: 0,
  local_write: 1,
  external: 2,
  destructive: 3,
  financial: 4,
};

export interface ToolBehaviorFlags {
  mutatesLocalState: boolean;
  contactsExternalOrigin: boolean;
  irreversibleOrDeletes: boolean;
  transfersMoneyOrPurchase: boolean;
}

export function deriveSideEffect(flags: ToolBehaviorFlags, rawDescription: string): SideEffectTier {
  const lower = rawDescription.toLowerCase();
  if (
    flags.transfersMoneyOrPurchase
    || lower.includes('payment')
    || lower.includes('purchase')
    || lower.includes('wire ')
    || lower.includes('checkout')
  ) {
    return 'financial';
  }
  if (
    flags.irreversibleOrDeletes
    || lower.includes('delete')
    || lower.includes('rm ')
    || lower.includes('prune')
    || lower.includes('drop table')
  ) {
    return 'destructive';
  }
  if (
    flags.contactsExternalOrigin
    || lower.includes('webhook')
    || lower.includes('http')
    || lower.includes('email')
    || lower.includes('call ')
    || lower.includes('upload')
  ) {
    return 'external';
  }
  if (flags.mutatesLocalState) {
    return 'local_write';
  }
  return 'read_only';
}

export function maxSideEffect(a: SideEffectTier, b: SideEffectTier): SideEffectTier {
  return SIDE_EFFECT_RANK[a] >= SIDE_EFFECT_RANK[b] ? a : b;
}

export function parseMcpToolJson(serverName: string, toolJson: string): ToolManifest {
  const cleanServer = serverName.trim();
  if (!cleanServer) {
    throw new ToolInputError('empty_server_or_tool_name: MCP server name is required.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(toolJson) as unknown;
  } catch {
    throw new ToolInputError('malformed_json: MCP tool definition must be valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolInputError('malformed_json: MCP tool definition must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) {
    throw new ToolInputError('empty_server_or_tool_name: MCP tool JSON must include a non-empty "name".');
  }
  const description = typeof obj.description === 'string' ? obj.description : '';
  const readOnlyHint = obj.readOnlyHint === true;
  const destructiveHint = obj.destructiveHint === true;

  // MCP servers cross a process/network boundary, so contactsExternalOrigin is always true
  // and the minimum derived tier is clamped to at least 'external'.
  const derived = maxSideEffect(
    deriveSideEffect(
      {
        mutatesLocalState: !readOnlyHint,
        contactsExternalOrigin: true,
        irreversibleOrDeletes: destructiveHint,
        transfersMoneyOrPurchase: false,
      },
      description,
    ),
    'external',
  );

  return {
    id: `mcp:${cleanServer}:${name}`,
    name,
    description,
    trusted_builtin: false,
    derived_side_effect: derived,
    owner_approved_reclassification: false,
  };
}

export function applyMcpReclassification(
  manifest: ToolManifest,
  requested: SideEffectTier,
  ownerConfirmed: boolean,
): ToolManifest {
  if (!ownerConfirmed) {
    throw new Error(`explicit owner confirmation is required to reclassify or execute external MCP tool '${manifest.id}'`);
  }
  if (manifest.derived_side_effect === 'financial' && SIDE_EFFECT_RANK[requested] < SIDE_EFFECT_RANK.financial) {
    throw new ToolInputError('cannot_downgrade_financial_tool: Financial tools cannot be downgraded below financial tier.');
  }
  return {
    ...manifest,
    derived_side_effect: requested,
    owner_approved_reclassification: true,
  };
}

export async function listConnectors(): Promise<ConnectorRecord[]> {
  const rows = await listAll('connectors');
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeConnector(id: string): Promise<void> {
  await deleteRecord('connectors', id);
}

export async function importAndSaveConnector(
  serverName: string,
  toolJson: string,
  now = Date.now(),
): Promise<ConnectorRecord> {
  const localManifest = parseMcpToolJson(serverName, toolJson);
  const manifest = isDesktopRuntime() ? await importMcpTool(serverName, toolJson) : localManifest;
  const record: ConnectorRecord = {
    id: manifest.id,
    serverName: serverName.trim(),
    name: manifest.name,
    description: manifest.description,
    trustedBuiltin: manifest.trusted_builtin,
    derivedSideEffect: manifest.derived_side_effect,
    ownerApprovedReclassification: manifest.owner_approved_reclassification,
    rawManifestJson: toolJson,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord('connectors', record);
  return record;
}

export async function reclassifyAndSaveConnector(
  connectorId: string,
  requested: SideEffectTier,
  ownerConfirmed: boolean,
  now = Date.now(),
): Promise<ConnectorRecord> {
  const existing = (await listAll('connectors')).find(item => item.id === connectorId);
  if (!existing) {
    throw new ToolInputError(`Connector "${connectorId}" was not found.`);
  }
  const currentManifest: ToolManifest = {
    id: existing.id,
    name: existing.name,
    description: existing.description,
    trusted_builtin: existing.trustedBuiltin,
    derived_side_effect: existing.derivedSideEffect,
    owner_approved_reclassification: existing.ownerApprovedReclassification,
  };
  const checked = applyMcpReclassification(currentManifest, requested, ownerConfirmed);
  const updatedManifest = isDesktopRuntime()
    ? await reclassifyMcpTool(currentManifest, requested)
    : checked;

  const updated: ConnectorRecord = {
    ...existing,
    derivedSideEffect: updatedManifest.derived_side_effect,
    ownerApprovedReclassification: updatedManifest.owner_approved_reclassification,
    updatedAt: now,
  };
  await putRecord('connectors', updated);
  return updated;
}

function ownerOnly(ctx: ToolContext): boolean {
  return !ctx.guestMode;
}

function coerceToolJsonString(args: RawArgs): string {
  const val = args.tool_json;
  if (typeof val === 'string') return requiredText({ tool_json: val }, 'tool_json', 32_000, { raw: true });
  if (val && typeof val === 'object' && !Array.isArray(val)) return JSON.stringify(val);
  throw new ToolInputError("'tool_json' must be a JSON string or MCP tool descriptor object.");
}

interface ImportArgs {
  serverName: string;
  toolJson: string;
}

interface ReclassifyArgs {
  connectorId: string;
  requested: SideEffectTier;
  ownerConfirmed: boolean;
}

export const connectorTools = [
  makeTool<ImportArgs>({
    name: 'import_mcp_connector',
    description:
      'Imports an untrusted external MCP tool JSON descriptor and classifies its server-derived side-effect tier '
      + '(defaulting to at least external regardless of readOnlyHint). Owner only; asks before saving.',
    parameters: {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: 'MCP server identifier, e.g. "docs-server".' },
        tool_json: { type: 'string', description: 'JSON string of the MCP tool manifest ({name, description, readOnlyHint, destructiveHint}).' },
      },
      required: ['server_name', 'tool_json'],
    },
    policy: 'confirm',
    failure: "Couldn't import MCP connector",
    available: ownerOnly,
    parse(args) {
      const serverName = requiredText(args, 'server_name', 120);
      const toolJson = coerceToolJsonString(args);
      parseMcpToolJson(serverName, toolJson);
      return { serverName, toolJson };
    },
    describe(args) {
      const manifest = parseMcpToolJson(args.serverName, args.toolJson);
      return `Import MCP connector "${manifest.id}" (classified as ${manifest.derived_side_effect})`;
    },
    async prepare(args) {
      const manifest = parseMcpToolJson(args.serverName, args.toolJson);
      const highRisk = manifest.derived_side_effect === 'financial' || manifest.derived_side_effect === 'destructive';
      return {
        text: `Import external MCP connector "${manifest.id}" with server-derived tier "${manifest.derived_side_effect}".`,
        content: JSON.stringify(manifest, null, 2),
        risk: highRisk ? 'high' : 'medium',
      };
    },
    async run(args) {
      const saved = await importAndSaveConnector(args.serverName, args.toolJson);
      return {
        ok: true,
        summary: `Imported ${saved.id} as ${saved.derivedSideEffect}`,
        data: {
          id: saved.id,
          name: saved.name,
          server_name: saved.serverName,
          derived_side_effect: saved.derivedSideEffect,
          trusted_builtin: saved.trustedBuiltin,
          owner_approved_reclassification: saved.ownerApprovedReclassification,
        },
      };
    },
  }),

  makeTool<ReclassifyArgs>({
    name: 'reclassify_mcp_connector',
    description:
      'Reclassifies a previously imported MCP connector side-effect tier after explicit owner confirmation. '
      + 'Financial tools cannot be downgraded below financial.',
    parameters: {
      type: 'object',
      properties: {
        connector_id: { type: 'string', description: 'Connector ID, e.g. "mcp:docs-server:fetch_docs".' },
        requested_side_effect: { type: 'string', enum: [...SIDE_EFFECT_TIERS], description: 'Requested side-effect tier.' },
        owner_confirmed: { type: 'boolean', description: 'Must be true when confirming reclassification.' },
      },
      required: ['connector_id', 'requested_side_effect'],
    },
    policy: 'confirm',
    failure: "Couldn't reclassify MCP connector",
    available: ownerOnly,
    parse(args) {
      const connectorId = requiredText(args, 'connector_id', 200);
      const requested = requiredEnum(args, 'requested_side_effect', SIDE_EFFECT_TIERS);
      const confirmed = optionalBoolean(args, 'owner_confirmed') ?? true;
      return { connectorId, requested, ownerConfirmed: confirmed };
    },
    describe(args) {
      return `Reclassify connector ${args.connectorId} to ${args.requested}`;
    },
    async prepare(args) {
      const existing = (await listAll('connectors')).find(item => item.id === args.connectorId);
      if (!existing) throw new ToolInputError(`Connector "${args.connectorId}" not found.`);
      if (existing.derivedSideEffect === 'financial' && SIDE_EFFECT_RANK[args.requested] < SIDE_EFFECT_RANK.financial) {
        throw new ToolInputError('Financial tools cannot be downgraded below financial tier.');
      }
      return {
        text: `Reclassify "${existing.id}" from ${existing.derivedSideEffect} to ${args.requested}.`,
        risk: args.requested === 'read_only' ? 'medium' : 'low',
      };
    },
    async run(args, _ctx, prepared) {
      const confirmed = args.ownerConfirmed && prepared !== undefined;
      const saved = await reclassifyAndSaveConnector(args.connectorId, args.requested, confirmed);
      return {
        ok: true,
        summary: `Reclassified ${saved.id} to ${saved.derivedSideEffect}`,
        data: {
          id: saved.id,
          derived_side_effect: saved.derivedSideEffect,
          owner_approved_reclassification: saved.ownerApprovedReclassification,
        },
      };
    },
  }),
];
