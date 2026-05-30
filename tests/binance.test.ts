import { describe, expect, it, vi } from "vitest";

import { fetchBinanceKlines } from "../src/sources/binance";

describe("fetchBinanceKlines", () => {
  it("aborts Binance requests after the configured timeout", async () => {
    const fetchMock = vi.fn((_url: URL | string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBinanceKlines({ symbol: "BTCUSDT", timeoutMs: 1 })).rejects.toThrow(
      "Binance fetch timed out for BTCUSDT after 1ms"
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
