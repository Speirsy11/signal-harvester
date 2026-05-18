import type { Repository } from "./db/repository";
import { FinancialApiSource } from "./sources/FinancialApiSource";
import type { CollectionJob } from "./types";

const ONE_MINUTE_MS = 60_000;

export interface MarketBackfillOptions {
  intervalMs?: number;
  batchSize?: number;
  enabled?: boolean;
}

function marketJobFor(target: { provider: string; symbol: string; interval: string }, startTime: Date, limit: number): CollectionJob {
  return {
    id: `backfill-${target.provider}-${target.symbol}-${target.interval}`.toLowerCase(),
    name: `${target.symbol} historical ${target.interval} backfill`,
    topic: target.symbol.replace(/USDT$/, ""),
    sourceKind: "financial-api",
    config: {
      provider: target.provider,
      symbols: [target.symbol],
      interval: target.interval,
      startTime: startTime.toISOString(),
      limit,
    },
    enabled: true,
    scheduleMs: null,
    status: "idle",
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function discoverBinanceFirstCandle(symbol: string) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", "0");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { headers: { "user-agent": "SignalHarvester/0.1" } });
  if (!response.ok) throw new Error(`Binance earliest-candle fetch failed for ${symbol}: ${response.status}`);
  const rows = (await response.json()) as unknown[][];
  const first = rows[0]?.[0];
  if (first === undefined) throw new Error(`Binance returned no historical candles for ${symbol}.`);
  return new Date(Number(first));
}

function nextStartFrom(points: { timestamp: Date }[], fallback: Date) {
  const latest = points.reduce((max, point) => Math.max(max, point.timestamp.getTime()), fallback.getTime());
  return new Date(latest + ONE_MINUTE_MS);
}

export function startMarketBackfill(repository: Repository, options: MarketBackfillOptions = {}) {
  const enabled = options.enabled ?? process.env["MARKET_BACKFILL_ENABLED"] !== "0";
  const intervalMs = options.intervalMs ?? Number(process.env["MARKET_BACKFILL_INTERVAL_MS"] ?? 5 * 60_000);
  const batchSize = Math.min(Math.max(options.batchSize ?? Number(process.env["MARKET_BACKFILL_BATCH_SIZE"] ?? 1000), 1), 1000);
  const source = new FinancialApiSource(repository);
  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (!enabled || running || stopped) return;
    running = true;
    try {
      const targets = await repository.listMarketBackfillTargets();
      for (const target of targets) {
        const existing = await repository.getMarketBackfillState(target.provider, target.symbol, target.interval);
        if (existing?.status === "complete") continue;

        await repository.upsertMarketBackfillState({
          provider: target.provider,
          symbol: target.symbol,
          interval: target.interval,
          status: "running",
          lastError: null,
        });

        const startTime = existing?.nextStartTime ?? (await discoverBinanceFirstCandle(target.symbol));
        const result = await source.collect(marketJobFor(target, startTime, batchSize));
        const marketData = result.marketData ?? [];
        const inserted = await repository.storeMarketData(marketData);
        const nextStartTime = marketData.length > 0 ? nextStartFrom(marketData, startTime) : startTime;
        const latestAvailableTime = new Date(Date.now() - ONE_MINUTE_MS);
        const complete = nextStartTime.getTime() >= latestAvailableTime.getTime();

        await repository.upsertMarketBackfillState({
          provider: target.provider,
          symbol: target.symbol,
          interval: target.interval,
          startTime: existing?.startTime ?? startTime,
          nextStartTime,
          latestAvailableTime,
          lastBatchAt: new Date(),
          lastFetched: marketData.length,
          lastInserted: inserted,
          totalFetchedDelta: marketData.length,
          totalInsertedDelta: inserted,
          status: complete ? "complete" : "idle",
          lastError: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.markOldestMarketBackfillFailed(message).catch(() => undefined);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  void runOnce();
  return {
    runOnce,
    close: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
