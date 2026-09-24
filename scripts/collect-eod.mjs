// Standalone GitHub runner: public official market data only. Never reads .env or watchlists.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { enrichRows, numeric, parseDaily, parseIndex, SOURCES, taipeiToday, tradeDate } from '../lib/eod-radar.ts';
import { freezeObservations, OBSERVATION_RULE } from '../lib/eod-history.ts';

const output = resolve(process.argv[2] || 'data');
// TPEx's daily_close_quotes includes many historical rows (~4.6 MB); this official
// current-day endpoint has the same needed fields at a fraction of the size.
const TPEX_CURRENT_QUOTES = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
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
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`official HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}
function candidate(rawQuotes, rawIndex, exchange, capturedAt, sourceUrls) {
  const market = parseDaily(rawQuotes, exchange, new Date(capturedAt));
  if (!market.date || market.rows.length < 500) throw new Error('daily dataset incomplete');
  market.index = parseIndex(rawIndex, exchange, market.date);
  if (!market.index) throw new Error('same-date index missing');
  return { rawQuotes, rawIndex, market, capturedAt, sourceUrls };
}
function signedRwd(markup, amount) {
  const value = numeric(amount);
  if (value == null) return 'X';
  const sign = String(markup);
  if (sign.includes('+')) return String(value);
  if (sign.includes('-')) return String(-value);
  return value === 0 && !sign.includes('X') ? '0' : 'X';
}
async function twseRwdCandidate() {
  const date = taipeiToday().replaceAll('-', '');
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`;
  const value = await official(url);
  if (value?.stat !== 'OK' || tradeDate(String(value.date)) !== tradeDate(date) || !Array.isArray(value.tables)) {
    throw new Error('TWSE web report not yet available for today');
  }
  const stockTable = value.tables.find(table => String(table.title).includes('每日收盤行情') && Array.isArray(table.data));
  const indexTable = value.tables.find(table => String(table.title).includes('價格指數(臺灣證券交易所)') && Array.isArray(table.data));
  const index = indexTable?.data.find(row => Array.isArray(row) && row[0] === '發行量加權股價指數');
  if (!stockTable || !index || stockTable.data.length < 500) throw new Error('TWSE web report incomplete');
  const rawQuotes = stockTable.data.filter(row => Array.isArray(row) && row.length >= 11).map(row => ({
    Date: date, Code: row[0], Name: row[1], TradeVolume: row[2], Transaction: row[3], TradeValue: row[4],
    OpeningPrice: row[5], HighestPrice: row[6], LowestPrice: row[7], ClosingPrice: row[8],
    Change: signedRwd(row[9], row[10]),
  }));
  const rawIndex = [{ Date: date, TAIEX: index[1], Change: signedRwd(index[2], index[3]) }];
  return candidate(rawQuotes, rawIndex, 'TWSE', new Date().toISOString(), { quotes: url, index: url });
}
async function twseCandidate() {
  const choices = [];
  const problems = [];
  try {
    const [rawQuotes, rawIndex] = await Promise.all([official(SOURCES.TWSE.quotes), official(SOURCES.TWSE.index)]);
    choices.push(candidate(rawQuotes, rawIndex, 'TWSE', new Date().toISOString(), SOURCES.TWSE));
  } catch (error) { problems.push(`OpenAPI: ${error instanceof Error ? error.message : 'unavailable'}`); }
  try { choices.push(await twseRwdCandidate()); }
  catch (error) { problems.push(`web: ${error instanceof Error ? error.message : 'unavailable'}`); }
  const latest = choices.sort((a, b) => b.market.date.localeCompare(a.market.date))[0];
  if (!latest) throw new Error(problems.join('; '));
  return latest;
}
for (const exchange of ['TWSE', 'TPEX']) {
  try {
    const source = exchange === 'TWSE' ? await twseCandidate() :
      candidate(...await Promise.all([official(TPEX_CURRENT_QUOTES), official(SOURCES.TPEX.index)]),
        'TPEX', new Date().toISOString(), { quotes: TPEX_CURRENT_QUOTES, index: SOURCES.TPEX.index });
    const { rawQuotes, rawIndex, market, capturedAt, sourceUrls } = source;
    // Preserve eligible no-trade/missing-price rows so coverage does not look artificially complete.
    const filtered = rawQuotes.filter(row => /^[1-9]\d{3}$/.test(String(exchange === 'TWSE' ? row.Code : row.SecuritiesCompanyCode).trim()));
    const dir = join(output, market.date);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${exchange}.json`);
    const observations = freezeObservations(enrichRows([market], []), capturedAt, capturedAt);
    const value = { version: 1, date: market.date, exchange, capturedAt, frozenAt: capturedAt,
      sourceUrls, rule: OBSERVATION_RULE, observations, rawQuotes: filtered, rawIndex };
    // First-capture snapshots are immutable. Reruns never change a historical observation.
    try { await writeFile(target, JSON.stringify(value), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const saved = await jsonFile(target, null);
    if (!saved || saved.version !== 1 || saved.date !== market.date || saved.exchange !== exchange) throw new Error('archive conflict');
    entries.set(`${saved.date}:${exchange}`, { date: saved.date, exchange, capturedAt: saved.capturedAt });
    collectedDates.set(exchange, saved.date);
    console.log(`${exchange}: ${saved.date}, ${market.rows.length} equities, saved`);
  } catch (error) {
    failed = true;
    const warning = `${exchange}: official dataset unavailable or incomplete (${error instanceof Error ? error.message.slice(0, 180) : 'unknown'}); existing files retained`;
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
if (completeDates[0]) {
  const date = completeDates[0];
  const markets = {};
  for (const exchange of ['TWSE', 'TPEX']) {
    const saved = await jsonFile(join(output, date, `${exchange}.json`), null);
    if (!saved || saved.version !== 1 || saved.date !== date || saved.exchange !== exchange) throw new Error('Complete-date archive missing');
    const market = parseDaily(saved.rawQuotes, exchange, new Date(saved.capturedAt));
    const index = parseIndex(saved.rawIndex, exchange, date);
    if (market.date !== date || market.rows.length < 500 || !index) throw new Error('Complete-date archive invalid');
    markets[exchange] = { indexChangePercent: index.changePercent,
      rows: market.rows.map(row => [row.symbol, row.name, row.close, row.changePercent, row.shares]) };
  }
  // Public, compact, complete-day input for a private five-symbol background checker.
  // Never put watchlists, push endpoints, account data, or keys in this repository.
  await writeFile(join(output, 'latest-compact.json'), JSON.stringify({ version: 1, date,
    sourceCapturedAt: { TWSE: entries.get(`${date}:TWSE`).capturedAt, TPEX: entries.get(`${date}:TPEX`).capturedAt }, markets }));
}
await writeFile(manifestPath, JSON.stringify({ version: 1, checkedAt: new Date().toISOString(),
  lastRunSucceeded: !failed, latestCompleteDate: completeDates[0] ?? null,
  sourceDates: { TWSE: collectedDates.get('TWSE') ?? null, TPEX: collectedDates.get('TPEX') ?? null },
  warnings, entries: ordered }, null, 2));
if (failed) process.exitCode = 1;

