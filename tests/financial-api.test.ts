import { describe, expect, it, vi } from "vitest";

import { FinancialApiSource } from "../src/sources/FinancialApiSource";
import type { CollectionJob } from "../src/types";

const job: CollectionJob = {
  id: "market",
  name: "BTC/USD 1m",
  topic: "BTC",
  sourceKind: "financial-api",
  config: {
    provider: "alpha-vantage",
    credentialId: "alpha-vantage",
    symbols: ["BTCUSD"],
    interval: "1m",
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

describe("FinancialApiSource", () => {
  it("normalizes Alpha Vantage intraday market data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          "Meta Data": { "2. Symbol": "BTCUSD" },
          "Time Series (1min)": {
            "2026-05-17 12:00:00": {
              "1. open": "100.0",
              "2. high": "105.0",
              "3. low": "99.5",
              "4. close": "102.25",
              "5. volume": "1234",
            },
          },
        }),
      }))
    );

    const repository = {
      getCredential: vi.fn().mockResolvedValue({ id: "alpha-vantage", apiKey: "test-key" }),
    };
    const result = await new FinancialApiSource(repository as never).collect(job);

    expect(result.marketData).toHaveLength(1);
    expect(result.marketData?.[0]).toMatchObject({
      provider: "alpha-vantage",
      sourceName: "Alpha Vantage",
      symbol: "BTCUSD",
      interval: "1m",
      open: 100,
      high: 105,
      low: 99.5,
      close: 102.25,
      volume: 1234,
    });
  });

  it("explains how to add missing Alpha Vantage credentials", async () => {
    const repository = { getCredential: vi.fn().mockResolvedValue(null) };
    await expect(new FinancialApiSource(repository as never).collect(job)).rejects.toThrow(
      "Missing Alpha Vantage API key"
    );
  });
});
