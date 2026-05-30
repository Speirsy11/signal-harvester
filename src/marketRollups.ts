import type { MarketDataPoint } from "./types";

export const SOURCE_MARKET_INTERVAL = "1m";
export const ROLLUP_MARKET_INTERVALS = ["5m", "15m", "1h", "4h", "1d", "1W", "1M"] as const;

export type RollupMarketInterval = (typeof ROLLUP_MARKET_INTERVALS)[number];

export interface RollupWindow {
  interval: RollupMarketInterval;
  start: Date;
  end: Date;
  expectedPoints: number;
}

const MINUTE_MS = 60_000;
const FIXED_INTERVAL_MINUTES: Partial<Record<RollupMarketInterval, number>> = {
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1_440,
};

export function isRollupMarketInterval(interval: string): interval is RollupMarketInterval {
  return (ROLLUP_MARKET_INTERVALS as readonly string[]).includes(interval);
}

function utcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / MINUTE_MS);
}

export function rollupWindowForTimestamp(interval: RollupMarketInterval, timestamp: Date): RollupWindow {
  const fixedMinutes = FIXED_INTERVAL_MINUTES[interval];
  if (fixedMinutes) {
    const intervalMs = fixedMinutes * MINUTE_MS;
    const startMs = Math.floor(timestamp.getTime() / intervalMs) * intervalMs;
    return {
      interval,
      start: new Date(startMs),
      end: new Date(startMs + intervalMs),
      expectedPoints: fixedMinutes,
    };
  }

  const year = timestamp.getUTCFullYear();
  const month = timestamp.getUTCMonth();
  const day = timestamp.getUTCDate();

  if (interval === "1W") {
    const date = utcDate(year, month, day);
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    const start = new Date(date.getTime() - daysSinceMonday * 24 * 60 * MINUTE_MS);
    const end = new Date(start.getTime() + 7 * 24 * 60 * MINUTE_MS);
    return { interval, start, end, expectedPoints: minutesBetween(start, end) };
  }

  const start = utcDate(year, month, 1);
  const end = utcDate(year, month + 1, 1);
  return { interval, start, end, expectedPoints: minutesBetween(start, end) };
}

export function previousRollupWindow(interval: RollupMarketInterval, window: RollupWindow): RollupWindow {
  const fixedMinutes = FIXED_INTERVAL_MINUTES[interval];
  if (fixedMinutes) {
    const start = new Date(window.start.getTime() - fixedMinutes * MINUTE_MS);
    return {
      interval,
      start,
      end: window.start,
      expectedPoints: fixedMinutes,
    };
  }

  if (interval === "1W") {
    const start = new Date(window.start.getTime() - 7 * 24 * 60 * MINUTE_MS);
    return { interval, start, end: window.start, expectedPoints: minutesBetween(start, window.start) };
  }

  const start = utcDate(window.start.getUTCFullYear(), window.start.getUTCMonth() - 1, 1);
  return { interval, start, end: window.start, expectedPoints: minutesBetween(start, window.start) };
}

export function nextRollupWindow(interval: RollupMarketInterval, window: RollupWindow): RollupWindow {
  return rollupWindowForTimestamp(interval, window.end);
}

export function advanceRollupWindows(interval: RollupMarketInterval, window: RollupWindow, count: number) {
  let advanced = window;
  for (let index = 0; index < count; index += 1) advanced = nextRollupWindow(interval, advanced);
  return advanced;
}

export function closedRollupWindowsBetween(interval: RollupMarketInterval, from: Date, to: Date) {
  const windows: RollupWindow[] = [];
  let window = rollupWindowForTimestamp(interval, from);

  while (window.end <= to) {
    windows.push(window);
    window = nextRollupWindow(interval, window);
  }

  return windows;
}

export function closedRollupWindowsForPoint(point: MarketDataPoint) {
  if (point.interval !== SOURCE_MARKET_INTERVAL) return [];

  return ROLLUP_MARKET_INTERVALS.flatMap((interval) => {
    const currentWindow = rollupWindowForTimestamp(interval, point.timestamp);
    if (point.timestamp.getTime() !== currentWindow.start.getTime()) return [];
    return [previousRollupWindow(interval, currentWindow)];
  });
}

export function buildRollupPoint(window: RollupWindow, points: MarketDataPoint[]): MarketDataPoint | null {
  if (points.length !== window.expectedPoints) return null;

  const orderedPoints = [...points].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  for (let index = 0; index < orderedPoints.length; index += 1) {
    const expectedTimestamp = window.start.getTime() + index * MINUTE_MS;
    if (orderedPoints[index]?.timestamp.getTime() !== expectedTimestamp) return null;
  }

  const firstPoint = orderedPoints[0];
  const lastPoint = orderedPoints[orderedPoints.length - 1];
  if (!firstPoint || !lastPoint) return null;

  const volumes = orderedPoints.map((point) => point.volume).filter((volume): volume is number => volume !== null);

  return {
    provider: firstPoint.provider,
    sourceName: firstPoint.sourceName,
    symbol: firstPoint.symbol,
    interval: window.interval,
    timestamp: window.start,
    open: firstPoint.open,
    high: Math.max(...orderedPoints.map((point) => point.high)),
    low: Math.min(...orderedPoints.map((point) => point.low)),
    close: lastPoint.close,
    volume: volumes.length === 0 ? null : volumes.reduce((sum, volume) => sum + volume, 0),
    raw: {
      derivedFromInterval: SOURCE_MARKET_INTERVAL,
      sourcePoints: orderedPoints.length,
      bucketStart: window.start.toISOString(),
      bucketEnd: window.end.toISOString(),
      rollupInterval: window.interval,
    },
  };
}
