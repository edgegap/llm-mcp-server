/**
 * Pure helpers for the operations tools (fleet health, log search, version
 * comparison) and the metrics summaries. No network, so they are unit-tested
 * directly in test/unit.test.mjs.
 */

import type { MetricSeries } from './client.js';

const round = (x: number) => Math.round(x * 100) / 100;

/** Nearest-rank percentile of already finite numbers; undefined when empty. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function finiteValues(series: MetricSeries | undefined): number[] {
  return (series?.datasets ?? []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Latest, average, p95 and peak of one series, plus anomaly flags an agent can
 * act on without reading the raw samples:
 * - spikes: samples above mean + 3 standard deviations (at least 8 samples);
 * - rising: the last quarter averages 25 % above the first quarter (a leak or
 *   growing load; at least 8 samples, and only for a series that is not ~0);
 * - nonzero: the share of samples above zero, for throttling.
 * Units are the API's; the flags are relative, so they need no units.
 */
export function analyzeSeries(series: MetricSeries | undefined, opts: { nonzero?: boolean } = {}) {
  const values = finiteValues(series);
  if (values.length === 0) return undefined;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const peak = Math.max(...values);
  const anomalies: string[] = [];
  if (n >= 8) {
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    if (sd > 0) {
      const limit = mean + 3 * sd;
      const idx = values.flatMap((v, i) => (v > limit ? [i] : []));
      if (idx.length) {
        const at = series?.timestamps?.[idx[0]];
        anomalies.push(
          `${idx.length} spike${idx.length === 1 ? '' : 's'} above ${round(limit)} (mean + 3 sd)` +
            (at ? `, first at ${at}` : '')
        );
      }
    }
    const q = Math.max(2, Math.floor(n / 4));
    const first = values.slice(0, q).reduce((a, b) => a + b, 0) / q;
    const last = values.slice(-q).reduce((a, b) => a + b, 0) / q;
    if (first > 0 && peak > 0 && last > first * 1.25) {
      anomalies.push(`rising: last quarter averages ${Math.round((last / first - 1) * 100)} % above the first quarter`);
    }
  }
  let nonzeroShare: number | undefined;
  if (opts.nonzero) {
    nonzeroShare = round(values.filter((v) => v > 0).length / n);
    if (nonzeroShare > 0) anomalies.push(`above zero in ${Math.round(nonzeroShare * 100)} % of samples`);
  }
  return {
    latest: round(values[n - 1]),
    average: round(mean),
    p95: round(percentile(values, 95)!),
    peak: round(peak),
    samples: n,
    ...(nonzeroShare !== undefined ? { nonzero_share: nonzeroShare } : {}),
    ...(anomalies.length ? { anomalies } : {}),
    labels: series?.labels?.length ? [...new Set(series.labels)].slice(0, 5) : undefined,
    from: series?.timestamps?.[0],
    to: series?.timestamps?.[series.timestamps.length - 1],
  };
}

/** Runs fn over items with at most `limit` in flight; keeps input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * A log line with the parts that differ between occurrences of the same error
 * replaced (timestamps, hex ids, numbers, quoted strings, IPs), so matches can
 * be grouped by what went wrong rather than when or where.
 */
export function logSignature(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/"[^"]{0,200}"/g, '"…"')
    // Not word-bounded: "30s" and "31s" are the same timeout.
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface LogGroup {
  signature: string;
  count: number;
  deployments: string[];
  example: string;
}

/** Groups matching lines from several deployments by signature, most frequent first. */
export function groupLogMatches(matches: Array<{ request_id: string; line: string }>, maxGroups: number): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const m of matches) {
    const sig = logSignature(m.line);
    const g = groups.get(sig) ?? { signature: sig, count: 0, deployments: [], example: m.line.slice(0, 300) };
    g.count++;
    if (!g.deployments.includes(m.request_id)) g.deployments.push(m.request_id);
    groups.set(sig, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.deployments.length - a.deployments.length).slice(0, maxGroups);
}

/**
 * A line matcher from an agent-supplied pattern. Plain text matches as a
 * case-insensitive substring. A regex is opt-in, length-capped, and rejected
 * when it nests quantifiers (the usual catastrophic-backtracking shape), since
 * the hosted server runs it on someone else's logs inside a request budget.
 */
export function lineMatcher(pattern: string, regex: boolean): { test: (line: string) => boolean } | { error: string } {
  if (!pattern || pattern.length > 200) return { error: 'pattern must be 1-200 characters.' };
  if (!regex) {
    const needle = pattern.toLowerCase();
    return { test: (line) => line.toLowerCase().includes(needle) };
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
    return { error: 'Nested quantifiers like (a+)+ are refused. Simplify the regex, or search for plain text.' };
  }
  try {
    const re = new RegExp(pattern, 'i');
    return { test: (line) => re.test(line.slice(0, 2000)) };
  } catch (err) {
    return { error: `Invalid regex: ${(err as Error).message}` };
  }
}

/** Default lines that look like a crash or error, for a search with no pattern. */
export const ERROR_PATTERN =
  '(error|exception|fatal|panic|segmentation fault|sigsegv|sigabrt|core dumped|unhandled|stack ?trace|assert(ion)? failed|out of memory|oom|killed)';
