import type { Repository } from "./db/repository";
import {
  BINANCE_KLINES_REQUEST_WEIGHT,
  BINANCE_MAX_KLINES_LIMIT,
  fetchBinanceKlines,
} from "./sources/binance";

const ONE_MINUTE_MS = 60_000;
const DEFAULT_BACKFILL_BATCH_SIZE = BINANCE_MAX_KLINES_LIMIT;
const DEFAULT_BACKFILL_TARGET_WEIGHT_PER_MINUTE = 3000;
const DEFAULT_BACKFILL_MAX_CONCURRENCY = 16;
const DEFAULT_BACKFILL_MIN_INTERVAL_MS = 20;
const DEFAULT_BACKFILL_TARGET_REFRESH_MS = 10_000;

type BackfillTarget = { provider: string; symbol: string; interval: string };
type MetricSample = { at: number; weight: number; fetched: number; inserted: number; failed: boolean; latencyMs: number };

export interface MarketBackfillOptions {
  intervalMs?: number;
  batchSize?: number;
  enabled?: boolean;
  targetWeightPerMinute?: number;
  maxConcurrency?: number;
  minIntervalMs?: number;
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextStartFrom(points: { timestamp: Date }[], fallback: Date) {
  const latest = points.reduce((max, point) => Math.max(max, point.timestamp.getTime()), fallback.getTime());
  return new Date(latest + ONE_MINUTE_MS);
}

function errorInfo(error: unknown) {
  const e = error as Error & { status?: number; retryAfterMs?: number; usedWeight1m?: number; latencyMs?: number };
  return {
    message: e instanceof Error ? e.message : String(error),
    status: e.status ?? null,
    retryAfterMs: e.retryAfterMs ?? null,
    usedWeight1m: e.usedWeight1m ?? null,
    latencyMs: e.latencyMs ?? 0,
  };
}

async function discoverBinanceFirstCandle(symbol: string) {
  const result = await fetchBinanceKlines({ symbol, interval: "1m", startTime: new Date(0), limit: 1 });
  const first = result.marketData[0]?.timestamp;
  if (!first) throw new Error(`Binance returned no historical candles for ${symbol}.`);
  return first;
}

class WeightedLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private lastRequestAt = 0;

  constructor(
    private readonly weightPerMinute: number,
    private readonly minIntervalMs: number
  ) {
    // Start empty so restarts ramp up instead of bursting above the configured minute budget.
    this.tokens = 0;
  }

  async acquire(weight: number, shouldStop: () => boolean) {
    while (!shouldStop()) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      if (elapsed > 0) {
        this.tokens = Math.min(this.weightPerMinute, this.tokens + (elapsed * this.weightPerMinute) / 60_000);
        this.lastRefill = now;
      }

      const intervalOk = now - this.lastRequestAt >= this.minIntervalMs;
      if (this.tokens >= weight && intervalOk) {
        this.tokens -= weight;
        this.lastRequestAt = now;
        return;
      }

      const tokenWait = this.tokens >= weight ? 0 : ((weight - this.tokens) * 60_000) / this.weightPerMinute;
      const intervalWait = intervalOk ? 0 : this.minIntervalMs - (now - this.lastRequestAt);
      await sleep(Math.max(1, Math.ceil(Math.max(tokenWait, intervalWait))));
    }
  }

  snapshot() {
    return { tokens: Math.floor(this.tokens), targetWeightPerMinute: this.weightPerMinute, minIntervalMs: this.minIntervalMs };
  }
}

export function startMarketBackfill(repository: Repository, options: MarketBackfillOptions = {}) {
  const enabled = options.enabled ?? process.env["MARKET_BACKFILL_ENABLED"] !== "0";
  const batchSize = Math.min(
    Math.max(options.batchSize ?? envNumber("MARKET_BACKFILL_BATCH_SIZE", DEFAULT_BACKFILL_BATCH_SIZE), 1),
    BINANCE_MAX_KLINES_LIMIT
  );
  const targetWeightPerMinute = options.targetWeightPerMinute ?? envNumber(
    "MARKET_BACKFILL_TARGET_WEIGHT_PER_MINUTE",
    DEFAULT_BACKFILL_TARGET_WEIGHT_PER_MINUTE
  );
  const maxConcurrency = Math.max(
    1,
    Math.floor(options.maxConcurrency ?? envNumber("MARKET_BACKFILL_MAX_CONCURRENCY", DEFAULT_BACKFILL_MAX_CONCURRENCY))
  );
  const minIntervalMs = Math.max(
    0,
    Math.floor(options.minIntervalMs ?? envNumber("MARKET_BACKFILL_MIN_INTERVAL_MS", DEFAULT_BACKFILL_MIN_INTERVAL_MS))
  );
  const limiter = new WeightedLimiter(targetWeightPerMinute, minIntervalMs);
  const cursors = new Map<string, Date>();
  const inFlightStarts = new Map<string, Date>();
  const samples: MetricSample[] = [];
  const activeByTarget = new Map<string, number>();
  let targets: BackfillTarget[] = [];
  let nextTargetIndex = 0;
  let active = 0;
  let stopped = false;
  let refreshTimer: NodeJS.Timeout | null = null;
  let schedulerTimer: NodeJS.Timeout | null = null;
  let throttledUntil = 0;
  let lastError: string | null = null;
  let lastStatus: number | null = null;
  let lastUsedWeight1m: number | null = null;
  const startedAt = Date.now();

  const keyFor = (target: BackfillTarget) => `${target.provider}:${target.symbol}:${target.interval}`;
  const pruneSamples = () => {
    const cutoff = Date.now() - 60_000;
    while (samples[0] && samples[0].at < cutoff) samples.shift();
  };
  const addSample = (sample: MetricSample) => {
    samples.push(sample);
    pruneSamples();
  };

  const refreshTargets = async () => {
    if (!enabled || stopped) return;
    targets = await repository.listMarketBackfillTargets();
  };

  const reserveBatch = async (target: BackfillTarget) => {
    const key = keyFor(target);
    let cursor = cursors.get(key);
    if (!cursor) {
      const existing = await repository.getMarketBackfillState(target.provider, target.symbol, target.interval);
      const storedCursor = existing?.nextStartTime ?? null;
      const latestStoredPoint = await repository.getLatestMarketDataPoint(target.provider, target.symbol, target.interval);
      cursor = latestStoredPoint ? nextStartFrom([latestStoredPoint], storedCursor ?? latestStoredPoint.timestamp) : storedCursor ?? undefined;
      cursor ??= await discoverBinanceFirstCandle(target.symbol);
      cursors.set(key, cursor);
    }

    const latestAvailableTime = new Date(Date.now() - ONE_MINUTE_MS);
    if (cursor.getTime() >= latestAvailableTime.getTime()) {
      await repository.upsertMarketBackfillState({
        provider: target.provider,
        symbol: target.symbol,
        interval: target.interval,
        status: "complete",
        latestAvailableTime,
        lastError: null,
      });
      return null;
    }

    const startTime = cursor;
    inFlightStarts.set(key, startTime);
    return { startTime, latestAvailableTime };
  };

  const rollbackCursor = (target: BackfillTarget, startTime: Date) => {
    const key = keyFor(target);
    const cursor = cursors.get(key);
    if (!cursor || startTime.getTime() < cursor.getTime()) cursors.set(key, startTime);
  };

  const runTarget = async (target: BackfillTarget) => {
    const key = keyFor(target);
    active += 1;
    activeByTarget.set(key, (activeByTarget.get(key) ?? 0) + 1);
    const started = Date.now();
    let reserved: { startTime: Date; latestAvailableTime: Date } | null = null;

    try {
      reserved = await reserveBatch(target);
      if (!reserved) return;

      await repository.upsertMarketBackfillState({
        provider: target.provider,
        symbol: target.symbol,
        interval: target.interval,
        status: "running",
        startTime: reserved.startTime,
        latestAvailableTime: reserved.latestAvailableTime,
        lastError: null,
      });

      const waitForThrottle = throttledUntil - Date.now();
      if (waitForThrottle > 0) await sleep(waitForThrottle);
      await limiter.acquire(BINANCE_KLINES_REQUEST_WEIGHT, () => stopped);
      if (stopped) return;

      const result = await fetchBinanceKlines({
        symbol: target.symbol,
        interval: target.interval,
        startTime: reserved.startTime,
        limit: batchSize,
      });
      lastStatus = result.status;
      lastUsedWeight1m = result.usedWeight1m;
      const inserted = await repository.storeMarketData(result.marketData);
      const nextStartTime = result.marketData.length > 0 ? nextStartFrom(result.marketData, reserved.startTime) : reserved.startTime;
      const complete = nextStartTime.getTime() >= reserved.latestAvailableTime.getTime();
      cursors.set(key, nextStartTime);

      await repository.upsertMarketBackfillState({
        provider: target.provider,
        symbol: target.symbol,
        interval: target.interval,
        status: complete ? "complete" : "idle",
        startTime: reserved.startTime,
        nextStartTime,
        latestAvailableTime: reserved.latestAvailableTime,
        lastBatchAt: new Date(),
        lastFetched: result.marketData.length,
        lastInserted: inserted,
        totalFetchedDelta: result.marketData.length,
        totalInsertedDelta: inserted,
        lastError: null,
      });
      lastError = null;
      addSample({
        at: Date.now(),
        weight: result.requestWeight,
        fetched: result.marketData.length,
        inserted,
        failed: false,
        latencyMs: Date.now() - started,
      });
    } catch (error) {
      const info = errorInfo(error);
      lastError = info.message;
      lastStatus = info.status;
      if (info.usedWeight1m !== null) lastUsedWeight1m = info.usedWeight1m;
      if (reserved) rollbackCursor(target, reserved.startTime);
      if (info.status === 429 || info.status === 418) {
        throttledUntil = Date.now() + (info.retryAfterMs ?? 60_000);
      }
      await repository.markMarketBackfillFailed(target.provider, target.symbol, target.interval, info.message).catch(
        () => undefined
      );
      addSample({ at: Date.now(), weight: BINANCE_KLINES_REQUEST_WEIGHT, fetched: 0, inserted: 0, failed: true, latencyMs: info.latencyMs });
    } finally {
      inFlightStarts.delete(key);
      active -= 1;
      const next = (activeByTarget.get(key) ?? 1) - 1;
      if (next <= 0) activeByTarget.delete(key);
      else activeByTarget.set(key, next);
    }
  };

  const schedule = () => {
    if (!enabled || stopped || targets.length === 0) return;
    let attempts = 0;
    while (active < maxConcurrency && Date.now() >= throttledUntil && targets.length > 0 && attempts < targets.length) {
      const target = targets[nextTargetIndex % targets.length];
      nextTargetIndex += 1;
      attempts += 1;
      const key = keyFor(target);
      if (inFlightStarts.has(key) || activeByTarget.has(key)) continue;
      void runTarget(target);
    }
  };

  const runOnce = async () => {
    await refreshTargets();
    schedule();
  };

  if (enabled) {
    void refreshTargets().then(schedule);
    refreshTimer = setInterval(() => void refreshTargets(), DEFAULT_BACKFILL_TARGET_REFRESH_MS);
    schedulerTimer = setInterval(schedule, Math.max(DEFAULT_BACKFILL_MIN_INTERVAL_MS, minIntervalMs));
  }

  return {
    runOnce,
    getMetrics: () => {
      pruneSamples();
      const successes = samples.filter((sample) => !sample.failed);
      const failures = samples.filter((sample) => sample.failed);
      const weightLastMinute = samples.reduce((sum, sample) => sum + sample.weight, 0);
      const fetchedLastMinute = samples.reduce((sum, sample) => sum + sample.fetched, 0);
      const insertedLastMinute = samples.reduce((sum, sample) => sum + sample.inserted, 0);
      const avgLatencyMs = successes.length
        ? Math.round(successes.reduce((sum, sample) => sum + sample.latencyMs, 0) / successes.length)
        : 0;
      return {
        enabled,
        startedAt: new Date(startedAt).toISOString(),
        targets: targets.length,
        active,
        maxConcurrency,
        activeByTarget: Object.fromEntries(activeByTarget),
        batchSize,
        limiter: limiter.snapshot(),
        weightLastMinute,
        targetWeightPerMinute,
        requestUtilizationPct: Number(((weightLastMinute / targetWeightPerMinute) * 100).toFixed(2)),
        fetchedLastMinute,
        insertedLastMinute,
        requestsLastMinute: samples.length,
        failuresLastMinute: failures.length,
        avgLatencyMs,
        throttledUntil: throttledUntil > Date.now() ? new Date(throttledUntil).toISOString() : null,
        lastStatus,
        lastUsedWeight1m,
        lastError,
      };
    },
    close: () => {
      stopped = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (schedulerTimer) clearInterval(schedulerTimer);
    },
  };
}
