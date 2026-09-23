// Closing auctions can finish after 13:30, so same-day EOD is eligible from 13:35.
export function taipeiClock(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600_000);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}
export function isFastAfterCloseWindow(now = new Date()) {
  const { hour, minute } = taipeiClock(now);
  return (hour === 13 && minute >= 30) || hour === 14;
}
export function afterClosePollMs(now = new Date()) {
  return isFastAfterCloseWindow(now) ? 120_000 : 600_000;
}
