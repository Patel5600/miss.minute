/**
 * Offer verification, scam filtering, and 50/35/15 weighted ranking.
 * Mirrors `crates/mm-mission/src/offers.rs`.
 */
import {
  isDesktopRuntime,
  rankOffers,
  type OfferListing,
  type RankedOffer,
  type ScamFlag,
  type TrustSignals,
} from '../../desktop/bridge.ts';
import { clearStore, listAll, putRecords, type OfferRecord } from '../../store/db.ts';
import { optionalText, requiredText, ToolInputError } from './args.ts';
import { makeTool } from './define.ts';
import type { ToolContext } from './types.ts';

function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function defaultTrustSignals(raw: unknown): TrustSignals {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    verified_domain: obj.verified_domain === true,
    requires_upfront_fee_or_wire: obj.requires_upfront_fee_or_wire === true,
    asks_off_platform_payment: obj.asks_off_platform_payment === true,
    typosquatted_or_suspicious_url: obj.typosquatted_or_suspicious_url === true,
    impossible_roi_or_urgency_pressure: obj.impossible_roi_or_urgency_pressure === true,
    opaque_contact_or_masked_redirect: obj.opaque_contact_or_masked_redirect === true,
    transparent_terms_present: obj.transparent_terms_present === true,
  };
}

export function normalizeOfferListings(rawListings: unknown): OfferListing[] {
  let items: unknown = rawListings;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items) as unknown;
    } catch {
      throw new ToolInputError("'listings' must be a JSON array of offer objects.");
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new ToolInputError("'listings' must be a non-empty array of offers.");
  }
  return items.slice(0, 100).map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ToolInputError(`Offer at index ${idx} must be an object.`);
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `offer-${idx + 1}`;
    const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : '';
    if (!title) throw new ToolInputError(`Offer "${id}" requires a non-empty 'title'.`);
    const sourceDomain = typeof obj.source_domain === 'string' ? obj.source_domain.trim() : '';
    return {
      id,
      title,
      source_domain: sourceDomain,
      fit_score: clampScore(Number(obj.fit_score ?? 50)),
      clarity_score: clampScore(Number(obj.clarity_score ?? 50)),
      base_legitimacy_score: clampScore(Number(obj.base_legitimacy_score ?? 50)),
      signals: defaultTrustSignals(obj.signals),
    };
  });
}

export function evaluateOffer(listing: OfferListing): RankedOffer {
  const flags: ScamFlag[] = [];
  if (listing.signals.requires_upfront_fee_or_wire) flags.push('upfront_fee_or_wire');
  if (listing.signals.asks_off_platform_payment) flags.push('off_platform_payment');
  if (listing.signals.typosquatted_or_suspicious_url) flags.push('suspicious_or_typosquatted_domain');
  if (listing.signals.impossible_roi_or_urgency_pressure) flags.push('impossible_roi_or_urgency');
  if (listing.signals.opaque_contact_or_masked_redirect) flags.push('masked_redirect_or_opaque_contact');

  const text = listing.title.toLowerCase();
  if (
    text.includes('wire only')
    || text.includes('gift card')
    || text.includes('kindly pay upfront')
    || text.includes('guaranteed 500%')
  ) {
    if (
      !flags.includes('upfront_fee_or_wire')
      && (text.includes('wire') || text.includes('gift card') || text.includes('upfront'))
    ) {
      flags.push('upfront_fee_or_wire');
    }
    if (!flags.includes('impossible_roi_or_urgency') && text.includes('guaranteed 500%')) {
      flags.push('impossible_roi_or_urgency');
    }
  }

  const rejected = flags.length > 0;
  let legRaw = 0;
  if (!rejected) {
    legRaw = clampScore(listing.base_legitimacy_score);
    legRaw = listing.signals.verified_domain ? Math.min(100, legRaw + 10) : Math.max(0, legRaw - 15);
    if (listing.signals.transparent_terms_present) {
      legRaw = Math.min(100, legRaw + 5);
    }
  }
  const fitRaw = rejected ? 0 : clampScore(listing.fit_score);
  const clarityRaw = rejected ? 0 : clampScore(listing.clarity_score);

  const legitimacyComp = 0.50 * legRaw;
  const fitComp = 0.35 * fitRaw;
  const clarityComp = 0.15 * clarityRaw;
  const totalScore = rejected ? 0 : legitimacyComp + fitComp + clarityComp;

  return {
    id: listing.id,
    title: listing.title,
    source_domain: listing.source_domain,
    rejected_as_scam: rejected,
    scam_flags: flags,
    legitimacy_component: legitimacyComp,
    fit_component: fitComp,
    clarity_component: clarityComp,
    total_score: totalScore,
  };
}

export function rankOffersLocal(listings: readonly OfferListing[]): RankedOffer[] {
  return listings.map(evaluateOffer).sort((a, b) => {
    if (a.rejected_as_scam !== b.rejected_as_scam) {
      return a.rejected_as_scam ? 1 : -1;
    }
    if (b.total_score !== a.total_score) {
      return b.total_score - a.total_score;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function listSavedOffers(): Promise<OfferRecord[]> {
  const rows = await listAll('offers');
  return rows.sort((a, b) => Number(a.rejectedAsScam) - Number(b.rejectedAsScam) || b.totalScore - a.totalScore || b.updatedAt - a.updatedAt);
}

export async function clearSavedOffers(): Promise<void> {
  await clearStore('offers');
}

export async function evaluateAndSaveOffers(
  query: string,
  listings: OfferListing[],
  now = Date.now(),
): Promise<RankedOffer[]> {
  const ranked = isDesktopRuntime() ? await rankOffers(listings) : rankOffersLocal(listings);
  const cleanQuery = query.trim() || 'Offer search';
  const records: OfferRecord[] = ranked.map(item => ({
    id: item.id,
    query: cleanQuery,
    sourceDomain: item.source_domain,
    title: item.title,
    totalScore: Number(item.total_score.toFixed(2)),
    legitimacyScore: Number(item.legitimacy_component.toFixed(2)),
    fitScore: Number(item.fit_component.toFixed(2)),
    clarityScore: Number(item.clarity_component.toFixed(2)),
    rejectedAsScam: item.rejected_as_scam,
    scamFlags: item.scam_flags,
    createdAt: now,
    updatedAt: now,
  }));
  await putRecords('offers', records);
  return ranked;
}

interface RankOffersArgs {
  query: string;
  listings: OfferListing[];
}

export const offerTools = [
  makeTool<RankOffersArgs>({
    name: 'rank_offers',
    description:
      'Verifies offer listings against hard scam signals and ranks legitimate offers using weighted scoring '
      + '(50% legitimacy, 35% fit, 15% clarity). Saves results for the Offers Radar panel. Owner only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search or comparison topic, e.g. "Local cloud GPU providers".' },
        listings: {
          type: 'array',
          description: 'Offer listings with id, title, source_domain, fit_score, clarity_score, base_legitimacy_score, and trust signals.',
          items: { type: 'object' },
        },
      },
      required: ['listings'],
    },
    policy: 'auto',
    failure: "Couldn't evaluate offers",
    available: (ctx: ToolContext) => !ctx.guestMode,
    parse(args) {
      const query = optionalText(args, 'query', 180) ?? 'Offer comparison';
      const listings = normalizeOfferListings(args.listings);
      if (!requiredText({ query }, 'query', 180)) {
        throw new ToolInputError("'query' cannot be empty.");
      }
      return { query, listings };
    },
    describe(args) {
      return `Rank ${args.listings.length} offer${args.listings.length === 1 ? '' : 's'} for "${args.query}"`;
    },
    async run(args) {
      const ranked = await evaluateAndSaveOffers(args.query, args.listings);
      const scams = ranked.filter(r => r.rejected_as_scam).length;
      const legit = ranked.length - scams;
      const top = legit > 0 ? ranked[0] : null;
      return {
        ok: true,
        summary: top
          ? `Ranked ${legit} verified offer(s), rejected ${scams} scam(s); top pick: "${top.title}" (${top.total_score.toFixed(1)}/100)`
          : `All ${scams} offer(s) rejected for scam indicators`,
        data: {
          query: args.query,
          verified_count: legit,
          scam_rejected_count: scams,
          ranked,
        },
      };
    },
  }),
];
