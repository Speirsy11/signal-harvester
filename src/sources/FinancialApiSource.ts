import type { CollectionJob, HarvestResult, MarketDataInterval, MarketDataPoint } from "../types";
import type { Repository } from "../db/repository";

import { fetchBinanceKlines } from "./binance";
import type { SourceAdapter } from "./SourceAdapter";

interface FinancialApiConfig {
  provider?: "alpha-vantage" | "binance";
  credentialId?: string;
  symbols?: string[];
  interval?: MarketDataInterval | string;
  outputsize?: "compact" | "full";
  startTime?: string;
  endTime?: string;
  limit?: number;
}

const alphaVantageIntervals: Record<string, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "1h": "60min",
};

function numberFrom(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric market-data value: ${String(value)}`);
  return parsed;
}

function dateFrom(value: string) {
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid market-data timestamp: ${value}`);
  return date;
}

export class FinancialApiSource implements SourceAdapter {
  readonly kind = "financial-api";

  constructor(private readonly repository: Repository) {}

  async collect(job: CollectionJob): Promise<HarvestResult> {
    const config = job.config as FinancialApiConfig;
    const provider = config.provider ?? "alpha-vantage";

    if (provider === "alpha-vantage") return this.collectAlphaVantage(job, config);
    if (provider === "binance") return this.collectBinance(config);

    throw new Error(`Unsupported financial provider: ${provider}`);
  }

  private async collectAlphaVantage(
    job: CollectionJob,
    config: FinancialApiConfig
  ): Promise<HarvestResult> {
    const credentialId = config.credentialId ?? "alpha-vantage";
    const credential = await this.repository.getCredential(credentialId);
    if (!credential?.apiKey) {
      throw new Error(
        `Missing Alpha Vantage API key. Add one in the UI under Provider credentials with id "${credentialId}".`
      );
    }

    const interval = config.interval ?? "1m";
    const alphaInterval = alphaVantageIntervals[String(interval)];
    if (!alphaInterval) throw new Error(`Alpha Vantage currently supports 1m, 5m, 15m, or 1h jobs.`);

    const symbols = config.symbols?.length ? config.symbols : [`${job.topic}USD`];
    const points: MarketDataPoint[] = [];

    for (const symbol of symbols) {
      const url = new URL("https://www.alphavantage.co/query");
      url.searchParams.set("function", "TIME_SERIES_INTRADAY");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", alphaInterval);
      url.searchParams.set("outputsize", config.outputsize ?? "compact");
      url.searchParams.set("apikey", credential.apiKey);

      const response = await fetch(url, { headers: { "user-agent": "SignalHarvester/0.1" } });
      if (!response.ok) throw new Error(`Alpha Vantage fetch failed for ${symbol}: ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      if (typeof payload["Error Message"] === "string") throw new Error(payload["Error Message"]);
      if (typeof payload["Note"] === "string") throw new Error(payload["Note"]);

      const seriesKey = Object.keys(payload).find((key) => key.startsWith("Time Series"));
      const series = seriesKey ? payload[seriesKey] : null;
      if (!series || typeof series !== "object") {
        throw new Error(`Alpha Vantage response for ${symbol} did not include a time series.`);
      }

      for (const [timestamp, rawPoint] of Object.entries(series as Record<string, Record<string, unknown>>)) {
        points.push({
          provider: "alpha-vantage",
          sourceName: "Alpha Vantage",
          symbol,
          interval,
          timestamp: dateFrom(timestamp),
          open: numberFrom(rawPoint["1. open"]),
          high: numberFrom(rawPoint["2. high"]),
          low: numberFrom(rawPoint["3. low"]),
          close: numberFrom(rawPoint["4. close"]),
          volume: rawPoint["5. volume"] === undefined ? null : numberFrom(rawPoint["5. volume"]),
          raw: rawPoint,
        });
      }
    }

    return { marketData: points };
  }

  private async collectBinance(config: FinancialApiConfig): Promise<HarvestResult> {
    const symbols = config.symbols?.length ? config.symbols : ["BTCUSDT"];
    const interval = config.interval ?? "1m";
    const points: MarketDataPoint[] = [];

    for (const symbol of symbols) {
      const result = await fetchBinanceKlines({
        symbol,
        interval,
        startTime: config.startTime ? new Date(config.startTime) : undefined,
        endTime: config.endTime ? new Date(config.endTime) : undefined,
        limit: config.limit,
      });
      points.push(...result.marketData);
    }

    return { marketData: points };
  }
}
