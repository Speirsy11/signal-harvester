export type SourceKind = "news-rss" | "financial-api" | "web-scrape";
export type JobStatus = "idle" | "running" | "failed";
export type SentimentLabel = "positive" | "neutral" | "negative";
export type FinancialProvider = "alpha-vantage" | "binance";
export type MarketDataInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export interface CollectionJob {
  id: string;
  name: string;
  topic: string;
  sourceKind: SourceKind;
  config: Record<string, unknown>;
  enabled: boolean;
  scheduleMs: number | null;
  status: JobStatus;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderCredential {
  id: string;
  provider: FinancialProvider | string;
  label: string;
  apiKey: string | null;
  apiSecret: string | null;
  extra: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicProviderCredential extends Omit<ProviderCredential, "apiKey" | "apiSecret"> {
  apiKeyMasked: string | null;
  apiSecretMasked: string | null;
}

export interface HarvestedDocument {
  externalId: string;
  sourceName: string;
  sourceKind: SourceKind;
  topic: string;
  title: string;
  url: string;
  summary: string | null;
  author: string | null;
  publishedAt: Date | null;
  raw: unknown;
}

export interface StoredDocument extends HarvestedDocument {
  id: string;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  collectedAt: Date;
}

export interface MarketDataPoint {
  provider: FinancialProvider | string;
  sourceName: string;
  symbol: string;
  interval: MarketDataInterval | string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  raw: unknown;
}

export interface StoredMarketDataPoint extends MarketDataPoint {
  id: string;
  collectedAt: Date;
}

export interface HarvestResult {
  documents?: HarvestedDocument[];
  marketData?: MarketDataPoint[];
}
