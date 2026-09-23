// Standalone GitHub runner: public official market data only. Never reads .env or watchlists.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { enrichRows, parseDaily, parseIndex, SOURCES } from '../lib/eod-radar.ts';
import { freezeObservations, OBSERVATION_RULE } from '../lib/eod-history.ts';

const output = resolve(process.argv[2] || 'data');
await mkdir(output, { recursive: true });
async function jsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const manifestPath = join(output, 'manifest.json');
const previous = await jsonFile(manifestPath, { version: 1, entries: [] });
if (previous.version !== 1 || !Array.isArray(previous.entries)) throw new Error('Invalid archive manifest');
const entries = new Map(previous.entries.map(entry => [`${entry.date}:${entry.exchange}`, entry]));
let failed = false;
const collectedDates = new Map();
const warnings = [];
async function official(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('source unavailable');
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}
for (const exchange of ['TWSE', 'TPEX']) {
  try {
    const [rawQuotes, rawIndex] = await Promise.all([official(SOURCES[exchange].quotes), official(SOURCES[exchange].index)]);
    const capturedAt = new Date().toISOString();
    const market = parseDaily(rawQuotes, exchange, new Date(capturedAt));
    if (!market.date || market.rows.length < 500) throw new Error('daily dataset incomplete');
    market.index = parseIndex(rawIndex, exchange, market.date);
    if (!market.index) throw new Error('same-date index missing');
    // Preserve eligible no-trade/missing-price rows so coverage does not look artificially complete.
    const filtered = rawQuotes.filter(row => /^[1-9]\d{3}$/.test(String(exchange === 'TWSE' ? row.Code : row.SecuritiesCompanyCode).trim()));
    const dir = join(output, market.date);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${exchange}.json`);
    const observations = freezeObservations(enrichRows([market], []), capturedAt, capturedAt);
    const value = { version: 1, date: market.date, exchange, capturedAt, frozenAt: capturedAt, rule: OBSERVATION_RULE, observations, rawQuotes: filtered, rawIndex };
    // First-capture snapshots are immutable. Reruns never change a historical observation.
    try { await writeFile(target, JSON.stringify(value), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const saved = await jsonFile(target, null);
    if (!saved || saved.version !== 1 || saved.date !== market.date || saved.exchange !== exchange) throw new Error('archive conflict');
    entries.set(`${saved.date}:${exchange}`, { date: saved.date, exchange, capturedAt: saved.capturedAt });
    collectedDates.set(exchange, saved.date);
    console.log(`${exchange}: ${saved.date}, ${market.rows.length} equities, saved`);
  } catch {
    failed = true;
    const warning = `${exchange}: official dataset unavailable or incomplete; existing files retained`;
    warnings.push(warning);
    console.error(warning);
  }
}
if (collectedDates.size === 2 && collectedDates.get('TWSE') !== collectedDates.get('TPEX')) {
  failed = true;
  const warning = `TWSE/TPEx official dates differ (${collectedDates.get('TWSE')} / ${collectedDates.get('TPEX')}); each valid file is retained, run marked partial`;
  warnings.push(warning);
  console.error(warning);
}
const ordered = [...entries.values()].sort((a,b) => b.date.localeCompare(a.date) || a.exchange.localeCompare(b.exchange)).slice(0, 180);
const completeDates = [...new Set(ordered.map(entry => entry.date))].filter(date =>
  entries.has(`${date}:TWSE`) && entries.has(`${date}:TPEX`)).sort().reverse();
await writeFile(manifestPath, JSON.stringify({ version: 1, checkedAt: new Date().toISOString(),
  lastRunSucceeded: !failed, latestCompleteDate: completeDates[0] ?? null,
  sourceDates: { TWSE: collectedDates.get('TWSE') ?? null, TPEX: collectedDates.get('TPEX') ?? null },
  warnings, entries: ordered }, null, 2));
if (failed) process.exitCode = 1;
