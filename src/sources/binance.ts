import type { MarketDataInterval, MarketDataPoint } from "../types";

export const BINANCE_KLINES_REQUEST_WEIGHT = 2;
export const BINANCE_MAX_KLINES_LIMIT = 1000;
export const DEFAULT_BINANCE_FETCH_TIMEOUT_MS = 15_000;

function numberFrom(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric market-data value: ${String(value)}`);
  return parsed;
}

function headerNumber(headers: Headers, name: string) {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface BinanceKlineFetchResult {
  marketData: MarketDataPoint[];
  requestWeight: number;
  status: number;
  latencyMs: number;
  usedWeight1m: number | null;
  retryAfterMs: number | null;
}

export async function fetchBinanceKlines(options: {
  symbol: string;
  interval?: MarketDataInterval | string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  timeoutMs?: number;
}): Promise<BinanceKlineFetchResult> {
  const started = Date.now();
  const symbol = options.symbol.replace("/", "").toUpperCase();
  const interval = options.interval ?? "1m";
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", String(interval));
  url.searchParams.set(
    "limit",
    String(Math.min(Math.max(options.limit ?? 500, 1), BINANCE_MAX_KLINES_LIMIT))
  );
  if (options.startTime) url.searchParams.set("startTime", String(options.startTime.getTime()));
  if (options.endTime) url.searchParams.set("endTime", String(options.endTime.getTime()));

  const timeoutMs = options.timeoutMs ?? DEFAULT_BINANCE_FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { headers: { "user-agent": "SignalHarvester/0.1" }, signal });
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (signal.aborted) {
      const timeoutError = new Error(`Binance fetch timed out for ${symbol} after ${timeoutMs}ms`);
      Object.assign(timeoutError, { status: 408, retryAfterMs: null, usedWeight1m: null, latencyMs });
      throw timeoutError;
    }
    throw error;
  }
  const latencyMs = Date.now() - started;
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter ? Math.max(Number(retryAfter) * 1000, 0) : null;
  const usedWeight1m = headerNumber(response.headers, "x-mbx-used-weight-1m");

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(
      `Binance fetch failed for ${symbol}: ${response.status}${text ? ` ${text}` : ""}`
    );
    Object.assign(error, { status: response.status, retryAfterMs, usedWeight1m, latencyMs });
    throw error;
  }

  const rows = (await response.json()) as unknown[][];
  return {
    marketData: rows.map((row) => ({
      provider: "binance",
      sourceName: "Binance",
      symbol,
      interval,
      timestamp: new Date(Number(row[0])),
      open: numberFrom(row[1]),
      high: numberFrom(row[2]),
      low: numberFrom(row[3]),
      close: numberFrom(row[4]),
      volume: numberFrom(row[5]),
      raw: row,
    })),
    requestWeight: BINANCE_KLINES_REQUEST_WEIGHT,
    status: response.status,
    latencyMs,
    usedWeight1m,
    retryAfterMs,
  };
}
