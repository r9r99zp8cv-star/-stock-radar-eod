import { isClosedDate, numeric, percentChange, tradeDate, type EodBar, type EodIndex, type EodRow, type Exchange } from './eod-radar.ts';

export const OBSERVATION_RULE = 'relative-strength-2pp-top20-per-market-v1';
export type VolumeResult = { ratio: number | null; samples: number; required: 20; median: number | null; status: 'ready' | 'collecting' | 'missing_data' | 'calendar_gap' | 'zero_baseline' };
export type Calendar = { sessions: EodIndex[]; complete: boolean };
export type HistoryBar = Pick<EodBar, 'symbol' | 'date' | 'exchange' | 'close' | 'change' | 'shares'>;
export type Observation = { row: EodRow; group: 'strong' | 'weak'; capturedAt: string; frozenAt: string; prospective: boolean; rule: string };
export type Outcome = { status: 'ready' | 'pending' | 'missing_data' | 'calendar_gap' | 'reference_changed'; date: string | null; stockReturn: number | null; indexReturn: number | null; excessReturn: number | null };
export type ReviewRow = Observation & { next: Outcome; fifth: Outcome };
export type ReviewReport = { date: string | null; availableDates: string[]; rows: ReviewRow[]; rule: string; asOf: string; warning: string | null };
export type ArchiveStatus = { state: 'unconfigured' | 'connected' | 'error'; lastCollectedAt: string | null; imported: number; remaining: number; message: string };

export function calendarMonths(start: string, end: string) {
  const months: string[] = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 7) <= end.slice(0, 7) && months.length < 12) {
    months.push(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
export function previousMonths(date: string, count = 2) {
  const cursor = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  cursor.setUTCMonth(cursor.getUTCMonth() - count);
  return cursor.toISOString().slice(0, 10);
}
export function calendarURL(exchange: Exchange, month: string) {
  return exchange === 'TWSE' ? `https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date=${month.replace('-', '')}01`
    : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${month.replace('-', '/')}/01&response=json`;
}
export function parseCalendar(value: unknown, exchange: Exchange, month: string, now = new Date()): EodIndex[] {
  const data = value as { stat?: string; fields?: string[]; data?: unknown[][]; tables?: { fields?: string[]; data?: unknown[][] }[] };
  if (!data || String(data.stat).toLowerCase() !== 'ok') throw new Error('交易日資料不可用');
  const table = exchange === 'TWSE' ? data : data.tables?.[0];
  const fields = table?.fields;
  if (!Array.isArray(fields) || !Array.isArray(table?.data) || fields[0] !== '日期' || !String(fields[4]).includes('指數')) throw new Error('交易日格式改變');
  const seen = new Set<string>();
  return table.data.flatMap(raw => {
    if (!Array.isArray(raw)) return [];
    const date = tradeDate(raw[0]), close = numeric(raw[4]);
    if (!date || date.slice(0, 7) !== month || !isClosedDate(date, now) || close == null || close <= 0 || seen.has(date)) return [];
    seen.add(date);
    return [{ date, close, changePercent: percentChange(close, numeric(raw[5])) }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}
export function volumeComparison(row: HistoryBar, history: HistoryBar[], calendar: Calendar): VolumeResult {
  const dates = calendar.sessions.map(s => s.date).filter(date => date < row.date).slice(-20);
  const byDate = new Map(history.filter(bar => bar.exchange === row.exchange && bar.symbol === row.symbol && bar.date < row.date).map(bar => [bar.date, bar]));
  const volumes = dates.flatMap(date => { const value = byDate.get(date)?.shares; return value != null && value >= 0 ? [value] : []; });
  const base = { ratio: null, samples: volumes.length, required: 20 as const, median: null };
  if (!calendar.complete) return { ...base, status: 'calendar_gap' };
  if (dates.length < 20 || volumes.length < 20) return { ...base, status: 'collecting' };
  if (row.shares == null || row.shares < 0) return { ...base, status: 'missing_data' };
  const sorted = [...volumes].sort((a, b) => a - b);
  const median = (sorted[9] + sorted[10]) / 2;
  if (median <= 0) return { ...base, median, status: 'zero_baseline' };
  return { ratio: row.shares / median, samples: 20, required: 20, median, status: 'ready' };
}
export function freezeObservations(rows: EodRow[], capturedAt: string, frozenAt = new Date().toISOString()): Observation[] {
  const groups: Observation[] = [];
  for (const exchange of ['TWSE', 'TPEX'] as const) for (const group of ['strong', 'weak'] as const) {
    const selected = rows.filter(row => row.exchange === exchange && row.marketRelative != null && (row.shares ?? 0) > 0 &&
      (group === 'strong' ? row.marketRelative >= 2 : row.marketRelative <= -2))
      .sort((a, b) => Math.abs(b.marketRelative!) - Math.abs(a.marketRelative!) || a.symbol.localeCompare(b.symbol)).slice(0, 20);
    groups.push(...selected.map(row => {
      // Late backfills are clearly retrospective and must not count as prospective evidence.
      const deadline = Date.parse(`${row.date}T09:00:00+08:00`) + 86400_000;
      const collected = Date.parse(capturedAt);
      const frozen = Date.parse(frozenAt);
      return { row, group, capturedAt, frozenAt, rule: OBSERVATION_RULE, prospective: Number.isFinite(collected) && Number.isFinite(frozen) &&
        collected >= Date.parse(`${row.date}T14:00:00+08:00`) && frozen >= collected && Math.max(collected, frozen) < deadline };
    }));
  }
  return groups;
}
export function evaluateObservation(observation: Observation, horizon: 1 | 5, bars: HistoryBar[], calendar: Calendar): Outcome {
  const empty = (status: Outcome['status'], date: string | null = null): Outcome => ({ status, date, stockReturn: null, indexReturn: null, excessReturn: null });
  const row = observation.row;
  if (!calendar.complete) return empty('calendar_gap');
  const baseIndex = calendar.sessions.find(session => session.date === row.date);
  if (!baseIndex) return empty('calendar_gap');
  const next = calendar.sessions.filter(session => session.date > row.date).slice(0, horizon);
  if (next.length < horizon) return empty('pending');
  const end = next[horizon - 1];
  const byDate = new Map(bars.filter(bar => bar.exchange === row.exchange && bar.symbol === row.symbol).map(bar => [bar.date, bar]));
  let previous = row.close;
  for (const session of next) {
    const bar = byDate.get(session.date);
    if (!bar || bar.shares == null || bar.shares <= 0) return empty('missing_data', end.date);
    // A changed reference may be ex-dividend/split/correction. No unadjusted performance claim.
    if (bar.change == null || Math.abs(bar.close - bar.change - previous) > 0.011) return empty('reference_changed', end.date);
    previous = bar.close;
  }
  const stockReturn = (previous / row.close - 1) * 100;
  const indexReturn = (end.close / baseIndex.close - 1) * 100;
  return { status: 'ready', date: end.date, stockReturn, indexReturn, excessReturn: stockReturn - indexReturn };
}
