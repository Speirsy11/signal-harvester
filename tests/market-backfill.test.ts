import { afterEach, describe, expect, it, vi } from "vitest";

import { startMarketBackfill } from "../src/marketBackfill";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => "rate limited",
  };
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    listMarketBackfillTargets: vi.fn().mockResolvedValue([{ provider: "binance", symbol: "BTCUSDT", interval: "1m" }]),
    getMarketBackfillState: vi.fn().mockResolvedValue({
      provider: "binance",
      symbol: "BTCUSDT",
      interval: "1m",
      status: "idle",
      nextStartTime: new Date("2020-01-01T00:00:00.000Z"),
    }),
    getLatestMarketDataPoint: vi.fn().mockResolvedValue(null),
    upsertMarketBackfillState: vi.fn().mockResolvedValue({}),
    storeMarketData: vi.fn().mockResolvedValue(2),
    markMarketBackfillFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("market backfill scheduler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("records throughput metrics while fetching bounded Binance batches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          [
            [Date.parse("2020-01-01T00:00:00.000Z"), "1", "2", "0.5", "1.5", "10"],
            [Date.parse("2020-01-01T00:01:00.000Z"), "1.5", "2", "1", "1.75", "11"],
          ],
          { "x-mbx-used-weight-1m": "42" }
        )
      )
    );
    const repo = repository();
    const backfill = startMarketBackfill(repo as never, {
      enabled: true,
      batchSize: 2,
      maxConcurrency: 1,
      targetWeightPerMinute: 6000,
      minIntervalMs: 0,
    });

    await vi.waitFor(() => expect(repo.storeMarketData).toHaveBeenCalled(), { timeout: 1000 });
    const metrics = backfill.getMetrics();
    backfill.close();

    expect(metrics.weightLastMinute).toBeGreaterThanOrEqual(2);
    expect(metrics.fetchedLastMinute).toBeGreaterThanOrEqual(2);
    expect(metrics.insertedLastMinute).toBeGreaterThanOrEqual(2);
    expect(metrics.lastUsedWeight1m).toBe(42);
  });

  it("marks the exact target failed and throttles on Binance 429 Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(429, { "retry-after": "1" })));
    const repo = repository();
    const backfill = startMarketBackfill(repo as never, {
      enabled: true,
      batchSize: 2,
      maxConcurrency: 1,
      targetWeightPerMinute: 6000,
      minIntervalMs: 0,
    });

    await vi.waitFor(() => expect(repo.markMarketBackfillFailed).toHaveBeenCalled(), { timeout: 1000 });
    const metrics = backfill.getMetrics();
    backfill.close();

    expect(repo.markMarketBackfillFailed).toHaveBeenCalledWith(
      "binance",
      "BTCUSDT",
      "1m",
      expect.stringContaining("429")
    );
    expect(metrics.failuresLastMinute).toBeGreaterThanOrEqual(1);
    expect(metrics.throttledUntil).toEqual(expect.any(String));
  });

  it("does not mark a target complete when Binance returns no rows and the cursor is behind", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([], { "x-mbx-used-weight-1m": "2" })));
    const cursor = new Date(Date.now() - 10 * 60_000);
    const repo = repository({
      getMarketBackfillState: vi.fn().mockResolvedValue({
        provider: "binance",
        symbol: "BTCUSDT",
        interval: "1m",
        status: "idle",
        nextStartTime: cursor,
      }),
    });
    const backfill = startMarketBackfill(repo as never, {
      enabled: true,
      batchSize: 1000,
      maxConcurrency: 1,
      targetWeightPerMinute: 6000,
      minIntervalMs: 0,
    });

    await vi.waitFor(() => expect(repo.storeMarketData).toHaveBeenCalled(), { timeout: 1000 });
    backfill.close();

    expect(repo.upsertMarketBackfillState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "idle",
        nextStartTime: cursor,
      })
    );
  });
});
