/**
 * web_search: Wikipedia full-text search with intro summaries (one request, CORS via
 * origin=*), plus DuckDuckGo Instant Answers when the browser can reach them. Both are keyless.
 * Results are title, snippet and url so the model can cite them.
 */
import { clip, optionalNumber, requiredText } from './args';
import { makeTool } from './define';
import { fetchJson, plainText } from './net';

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  source: 'wikipedia' | 'duckduckgo';
}

interface WikiResponse {
  query?: {
    pages?: Array<{ title: string; index?: number; extract?: string; fullurl?: string; missing?: boolean }>;
  };
}

const WIKI_HEADERS = { 'Api-User-Agent': 'MissMinutes/1.0 (local desktop companion)' };

async function searchWikipedia(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(limit),
    gsrnamespace: '0',
    prop: 'extracts|info',
    exintro: '1',
    explaintext: '1',
    exsentences: '3',
    exlimit: 'max',
    inprop: 'url',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const data = await fetchJson<WikiResponse>(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
    service: 'Wikipedia', signal, headers: WIKI_HEADERS,
  });
  return (data.query?.pages ?? [])
    .filter(page => !page.missing && page.fullurl)
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
    .map(page => ({
      title: page.title,
      snippet: clip(plainText(page.extract ?? ''), 320),
      url: page.fullurl as string,
      source: 'wikipedia' as const,
    }));
}

interface DuckTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckTopic[];
}

interface DuckResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionSource?: string;
  DefinitionURL?: string;
  RelatedTopics?: DuckTopic[];
}

interface DuckResult {
  answer?: { text: string; source: string; url?: string };
  results: SearchResult[];
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<DuckResult> {
  const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1', no_redirect: '1', t: 'missminutes' });
  const data = await fetchJson<DuckResponse>(`https://api.duckduckgo.com/?${params.toString()}`, {
    service: 'DuckDuckGo', signal, timeoutMs: 6000,
  });
  const out: DuckResult = { results: [] };
  const answer = typeof data.Answer === 'string' ? plainText(data.Answer) : '';
  if (answer) out.answer = { text: clip(answer, 400), source: 'DuckDuckGo' };
  if (data.AbstractText && data.AbstractURL) {
    out.results.push({
      title: data.Heading || query,
      snippet: clip(plainText(data.AbstractText), 400),
      url: data.AbstractURL,
      source: 'duckduckgo',
    });
  } else if (data.Definition && data.DefinitionURL) {
    out.results.push({ title: data.Heading || query, snippet: clip(plainText(data.Definition), 300), url: data.DefinitionURL, source: 'duckduckgo' });
  }
  const topics = (data.RelatedTopics ?? []).flatMap(topic => (topic.Topics ? topic.Topics : [topic]));
  for (const topic of topics.slice(0, 4)) {
    if (!topic.Text || !topic.FirstURL) continue;
    const text = plainText(topic.Text);
    out.results.push({ title: clip(text.split(' - ')[0], 90), snippet: clip(text, 240), url: topic.FirstURL, source: 'duckduckgo' });
  }
  return out;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${decodeURIComponent(parsed.pathname).replace(/_/g, ' ')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

interface SearchArgs {
  query: string;
  max: number;
}

export const searchTools = [
  makeTool<SearchArgs>({
    name: 'web_search',
    description:
      'Searches the web for facts: Wikipedia articles (title, summary, url) plus a DuckDuckGo instant answer when '
      + 'available. Best for people, places, concepts, history and definitions; it has no live news or prices. '
      + 'Cite the url when you use a result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, e.g. "Time Variance Authority".' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5.' },
      },
      required: ['query'],
    },
    policy: 'auto',
    failure: 'Search failed',
    parse(args) {
      return { query: requiredText(args, 'query', 300), max: optionalNumber(args, 'max_results', { min: 1, max: 10, integer: true }) ?? 5 };
    },
    describe(args) {
      return `Search the web for "${args.query}"`;
    },
    async run(args, ctx) {
      const [wiki, duck] = await Promise.allSettled([
        searchWikipedia(args.query, args.max, ctx.signal),
        searchDuckDuckGo(args.query, ctx.signal),
      ]);
      if (wiki.status === 'rejected' && duck.status === 'rejected') {
        throw new Error(wiki.reason instanceof Error ? wiki.reason.message : 'Neither Wikipedia nor DuckDuckGo could be reached.');
      }
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      const add = (result: SearchResult) => {
        const key = normalizeUrl(result.url);
        if (seen.has(key) || results.length >= args.max) return;
        seen.add(key);
        results.push(result);
      };
      const duckValue = duck.status === 'fulfilled' ? duck.value : undefined;
      // A DuckDuckGo abstract (often itself from Wikipedia) is the most direct answer, so it leads.
      if (duckValue?.results[0]?.snippet && duckValue.results[0].title) add(duckValue.results[0]);
      if (wiki.status === 'fulfilled') wiki.value.forEach(add);
      duckValue?.results.slice(1).forEach(add);
      const sources = [wiki.status === 'fulfilled' ? 'Wikipedia' : '', duckValue ? 'DuckDuckGo' : ''].filter(Boolean).join(' + ');
      const summary = results.length === 0 && !duckValue?.answer
        ? `No results for "${args.query}"`
        : `${results.length} result${results.length === 1 ? '' : 's'} for "${args.query}" (${sources})${results[0] ? `: ${results[0].title}` : ''}`;
      return {
        ok: true,
        summary,
        data: {
          query: args.query,
          ...(duckValue?.answer ? { answer: duckValue.answer } : {}),
          results,
          ...(wiki.status === 'rejected' ? { wikipedia_error: String(wiki.reason instanceof Error ? wiki.reason.message : wiki.reason) } : {}),
        },
      };
    },
  }),
];
