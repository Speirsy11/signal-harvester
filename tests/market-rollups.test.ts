import { describe, expect, it } from "vitest";

import {
  buildRollupPoint,
  closedRollupWindowsBetween,
  closedRollupWindowsForPoint,
  rollupWindowForTimestamp,
} from "../src/marketRollups";
import type { MarketDataPoint } from "../src/types";

function point(timestamp: string, price: number, volume: number | null = 1): MarketDataPoint {
  return {
    provider: "binance",
    sourceName: "Binance",
    symbol: "BTCUSDT",
    interval: "1m",
    timestamp: new Date(timestamp),
    open: price,
    high: price + 2,
    low: price - 2,
    close: price + 1,
    volume,
    raw: {},
  };
}

describe("market rollups", () => {
  it("emits closed bucket candidates only when a new bucket starts", () => {
    expect(closedRollupWindowsForPoint(point("2026-05-30T12:14:00Z", 100))).toHaveLength(0);

    const windows = closedRollupWindowsForPoint(point("2026-05-30T13:00:00Z", 100));
    expect(windows.map((window) => window.interval)).toEqual(["5m", "15m", "1h"]);
    expect(windows.find((window) => window.interval === "1h")?.start.toISOString()).toBe(
      "2026-05-30T12:00:00.000Z"
    );
  });

  it("uses UTC calendar boundaries for week and month rollups", () => {
    const weekly = rollupWindowForTimestamp("1W", new Date("2026-06-03T10:30:00Z"));
    expect(weekly.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(weekly.end.toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(weekly.expectedPoints).toBe(10_080);

    const monthly = rollupWindowForTimestamp("1M", new Date("2026-02-12T10:30:00Z"));
    expect(monthly.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(monthly.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(monthly.expectedPoints).toBe(40_320);
  });

  it("builds OHLCV candles from complete source buckets", () => {
    const window = rollupWindowForTimestamp("5m", new Date("2026-05-30T12:00:00Z"));
    const rollup = buildRollupPoint(window, [
      point("2026-05-30T12:00:00Z", 100, 2),
      point("2026-05-30T12:01:00Z", 103, 3),
      point("2026-05-30T12:02:00Z", 98, 4),
      point("2026-05-30T12:03:00Z", 105, 5),
      point("2026-05-30T12:04:00Z", 101, 6),
    ]);

    expect(rollup).toMatchObject({
      provider: "binance",
      sourceName: "Binance",
      symbol: "BTCUSDT",
      interval: "5m",
      timestamp: new Date("2026-05-30T12:00:00Z"),
      open: 100,
      high: 107,
      low: 96,
      close: 102,
      volume: 20,
    });
  });

  it("lists closed windows over a lookback period", () => {
    const windows = closedRollupWindowsBetween(
      "1d",
      new Date("2026-05-28T12:00:00Z"),
      new Date("2026-05-30T14:00:00Z")
    );

    expect(windows.map((window) => window.start.toISOString())).toEqual([
      "2026-05-28T00:00:00.000Z",
      "2026-05-29T00:00:00.000Z",
    ]);
  });

  it("refuses incomplete or gapped source buckets", () => {
    const window = rollupWindowForTimestamp("5m", new Date("2026-05-30T12:00:00Z"));
    expect(buildRollupPoint(window, [point("2026-05-30T12:00:00Z", 100)])).toBeNull();
    expect(
      buildRollupPoint(window, [
        point("2026-05-30T12:00:00Z", 100),
        point("2026-05-30T12:01:00Z", 101),
        point("2026-05-30T12:02:00Z", 102),
        point("2026-05-30T12:04:00Z", 104),
        point("2026-05-30T12:05:00Z", 105),
      ])
    ).toBeNull();
  });
});
