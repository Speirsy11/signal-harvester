export type SourceKind = "news-rss" | "financial-api" | "web-scrape";
export type JobStatus = "idle" | "running" | "failed";
export type SentimentLabel = "positive" | "neutral" | "negative";

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
