import type { VolumeResult, ArchiveStatus } from './eod-history';
import { taipeiClock } from './after-close-timing.ts';
export type Exchange = 'TWSE' | 'TPEX';
export type EodBar = {
  symbol: string; name: string; exchange: Exchange; date: string;
  close: number; change: number | null; changePercent: number | null;
  open: number | null; high: number | null; low: number | null;
  shares: number | null; turnover: number | null;
};
export type EodIndex = { date: string; close: number; changePercent: number | null };
export type EodMarket = {
  exchange: Exchange; date: string | null; fetchedAt: string | null;
  status: 'ok' | 'cached_error' | 'unavailable' | 'history';
  sourceRows: number; eligible: number; excluded: number; invalid: number;
  index: EodIndex | null; rows: EodBar[]; warning: string | null;
};
export type EodRow = EodBar & {
  volume?: VolumeResult;
  industry: string | null; marketRelative: number | null;
  sectorMean: number | null; sectorRelative: number | null;
  sectorPeers: number; sectorUpPercent: number | null;
};
export type EodReport = {
  archive?: ArchiveStatus;
  mode: 'eod'; generatedAt: string; availableDates: string[];
  requestedDate: string | null; markets: Omit<EodMarket, 'rows'>[]; rows: EodRow[];
};
type RecordData = Record<string, unknown>;
export const SOURCES = {
  TWSE: { quotes: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', index: 'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK' },
  TPEX: { quotes: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', index: 'https://www.tpex.org.tw/openapi/v1/tpex_daily_trading_index' },
};
export function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const clean = value.trim().replaceAll(',', '').replaceAll('−', '-');
  // X/除權息/--- are unknown, never coerced to zero or stripped into numbers.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(clean)) return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}
export function tradeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replaceAll('/', '').replaceAll('-', '');
  if (!/^\d{7,8}$/.test(digits)) return null;
  const yearSize = digits.length - 4;
  const year = Number(digits.slice(0, yearSize)) + (yearSize === 3 ? 1911 : 0);
  const month = Number(digits.slice(yearSize, yearSize + 2));
  const day = Number(digits.slice(-2));
  if (year < 2000 || year > 2100) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return parsed.toISOString().slice(0, 10);
}
export function taipeiToday(now = new Date()) { return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10); }
export function isClosedDate(date: string, now = new Date()) {
  const { date: today, hour, minute } = taipeiClock(now);
  return date < today || (date === today && (hour > 13 || (hour === 13 && minute >= 35)));
}
function records(value: unknown): RecordData[] {
  if (!Array.isArray(value)) throw new Error('官方資料格式無法辨識');
  return value.filter((row): row is RecordData => row != null && typeof row === 'object' && !Array.isArray(row));
}
function nonnegative(value: unknown) { const n = numeric(value); return n != null && n >= 0 ? n : null; }
function positive(value: unknown) { const n = numeric(value); return n != null && n > 0 ? n : null; }
export function percentChange(close: number, change: number | null) {
  return change != null && close - change > 0 ? change / (close - change) * 100 : null;
}
export function parseDaily(value: unknown, exchange: Exchange, now = new Date()): EodMarket {
  const source = records(value);
  const dates = source.map(row => tradeDate(row.Date)).filter((d): d is string => d != null && isClosedDate(d, now));
  const date = dates.sort().at(-1) ?? null;
  const rows: EodBar[] = [];
  let eligible = 0, excluded = 0, invalid = 0;
  const seen = new Set<string>();
  for (const raw of source) {
    if (tradeDate(raw.Date) !== date || !date) continue;
    const symbol = String(exchange === 'TWSE' ? raw.Code : raw.SecuritiesCompanyCode).trim();
    // Four-digit equities / depositary receipts; exclude ETFs, warrants, bonds and preferred shares.
    if (!/^[1-9]\d{3}$/.test(symbol)) { excluded++; continue; }
    eligible++;
    const close = positive(exchange === 'TWSE' ? raw.ClosingPrice : raw.Close);
    const name = exchange === 'TWSE' ? raw.Name : raw.CompanyName;
    if (close == null || typeof name !== 'string' || !name.trim() || seen.has(symbol)) { invalid++; continue; }
    seen.add(symbol);
    const change = numeric(raw.Change);
    rows.push({ symbol, name: name.trim(), exchange, date, close, change, changePercent: percentChange(close, change),
      open: positive(exchange === 'TWSE' ? raw.OpeningPrice : raw.Open),
      high: positive(exchange === 'TWSE' ? raw.HighestPrice : raw.High),
      low: positive(exchange === 'TWSE' ? raw.LowestPrice : raw.Low),
      shares: nonnegative(exchange === 'TWSE' ? raw.TradeVolume : raw.TradingShares),
      turnover: nonnegative(exchange === 'TWSE' ? raw.TradeValue : raw.TransactionAmount),
    });
  }
  return { exchange, date, fetchedAt: now.toISOString(), status: rows.length ? 'ok' : 'unavailable',
    sourceRows: source.length, eligible, excluded, invalid, index: null, rows, warning: null };
}
export function parseIndex(value: unknown, exchange: Exchange, date: string): EodIndex | null {
  const row = records(value).find(row => tradeDate(row.Date) === date);
  if (!row) return null;
  const close = positive(exchange === 'TWSE' ? row.TAIEX : row.TPExIndex);
  return close == null ? null : { date, close, changePercent: percentChange(close, numeric(row.Change)) };
}
export function enrichRows(markets: EodMarket[], master: { symbol: string; exchange: string; industry?: string | null }[]): EodRow[] {
  const industries = new Map(master.map(row => [`${row.exchange}:${row.symbol}`, row.industry || null]));
  const all = markets.flatMap(market => market.rows.map(row => ({ ...row,
    industry: industries.get(`${row.exchange}:${row.symbol}`) ?? null,
    marketRelative: row.changePercent != null && market.index?.date === row.date && market.index.changePercent != null
      ? row.changePercent - market.index.changePercent : null,
  })));
  const groups = new Map<string, { count: number; sum: number; up: number }>();
  for (const row of all) {
    if (!row.industry || row.changePercent == null) continue;
    const key = `${row.date}:${row.industry}`;
    const group = groups.get(key) ?? { count: 0, sum: 0, up: 0 };
    group.count++; group.sum += row.changePercent; group.up += Number(row.changePercent > 0);
    groups.set(key, group);
  }
  return all.map(row => {
    const group = row.industry ? groups.get(`${row.date}:${row.industry}`) : undefined;
    const includeSelf = row.changePercent != null;
    const peers = group ? group.count - Number(includeSelf) : 0;
    const mean = group && peers >= 5 ? (group.sum - (row.changePercent ?? 0)) / peers : null;
    return { ...row, sectorPeers: peers, sectorMean: mean,
      sectorRelative: mean != null && row.changePercent != null ? row.changePercent - mean : null,
      sectorUpPercent: group && peers >= 5 ? (group.up - Number(includeSelf && row.changePercent! > 0)) / peers * 100 : null,
    };
  });
}
export type EodFilter = '全部' | '上漲' | '下跌' | '相對強勢' | '相對弱勢' | '成交金額';
export function rankRows(rows: EodRow[], filter: EodFilter, query = '') {
  const q = query.trim().toLowerCase();
  return rows.filter(row => !q || `${row.symbol} ${row.name} ${row.industry ?? ''}`.toLowerCase().includes(q)).filter(row => {
    if (filter === '上漲') return row.changePercent != null && row.changePercent > 0;
    if (filter === '下跌') return row.changePercent != null && row.changePercent < 0;
    if (filter === '相對強勢') return row.marketRelative != null && row.marketRelative >= 2;
    if (filter === '相對弱勢') return row.marketRelative != null && row.marketRelative <= -2;
    return true;
  }).sort((a, b) => {
    const value = (row: EodRow) => filter === '成交金額' ? row.turnover :
      filter === '相對強勢' || filter === '相對弱勢' ? row.marketRelative == null ? null : Math.abs(row.marketRelative) :
      row.changePercent == null ? null : Math.abs(row.changePercent);
    return (value(b) ?? -1) - (value(a) ?? -1) || a.symbol.localeCompare(b.symbol);
  });
}
