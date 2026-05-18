import crypto from "node:crypto";

import type { Sql } from "postgres";

import { scoreSentiment } from "../sentiment/lexicon";
import type {
  CollectionJob,
  FinancialProvider,
  HarvestedDocument,
  MarketBackfillState,
  MarketDataPoint,
  ProviderCredential,
  PublicProviderCredential,
  SourceKind,
  StoredDocument,
  StoredMarketDataPoint,
} from "../types";

function rowToJob(row: any): CollectionJob {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    sourceKind: row.source_kind as SourceKind,
    config: row.config,
    enabled: row.enabled,
    scheduleMs: row.schedule_ms,
    status: row.status,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCredential(row: any): ProviderCredential {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    apiKey: row.api_key,
    apiSecret: row.api_secret,
    extra: row.extra ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskSecret(value: string | null) {
  if (!value) return null;
  if (value.length <= 6) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

function toPublicCredential(credential: ProviderCredential): PublicProviderCredential {
  return {
    id: credential.id,
    provider: credential.provider,
    label: credential.label,
    extra: credential.extra,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    apiKeyMasked: maskSecret(credential.apiKey),
    apiSecretMasked: maskSecret(credential.apiSecret),
  };
}

function rowToDocument(row: any): StoredDocument {
  return {
    id: row.id,
    externalId: row.external_id,
    sourceName: row.source_name,
    sourceKind: row.source_kind,
    topic: row.topic,
    title: row.title,
    url: row.url,
    summary: row.summary,
    author: row.author,
    publishedAt: row.published_at,
    raw: row.raw,
    sentimentScore: Number(row.sentiment_score),
    sentimentLabel: row.sentiment_label,
    collectedAt: row.collected_at,
  };
}

function rowToMarketData(row: any): StoredMarketDataPoint {
  return {
    id: row.id,
    provider: row.provider,
    sourceName: row.source_name,
    symbol: row.symbol,
    interval: row.interval,
    timestamp: row.timestamp,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume === null ? null : Number(row.volume),
    raw: row.raw,
    collectedAt: row.collected_at,
  };
}

function rowToMarketBackfill(row: any): MarketBackfillState {
  return {
    provider: row.provider,
    symbol: row.symbol,
    interval: row.interval,
    status: row.status,
    startTime: row.start_time,
    nextStartTime: row.next_start_time,
    latestAvailableTime: row.latest_available_time,
    lastBatchAt: row.last_batch_at,
    lastFetched: Number(row.last_fetched ?? 0),
    lastInserted: Number(row.last_inserted ?? 0),
    totalFetched: Number(row.total_fetched ?? 0),
    totalInserted: Number(row.total_inserted ?? 0),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function stableId(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export class Repository {
  constructor(private readonly sql: Sql) {}

  async seedDefaults() {
    const existing = await this.getJob("btc-news");
    if (!existing) {
      await this.createJob({
        id: "btc-news",
        name: "BTC news sentiment",
        topic: "BTC",
        sourceKind: "news-rss",
        scheduleMs: 15 * 60_000,
        config: {
          feeds: [
            {
              name: "Google News BTC",
              url: "https://news.google.com/rss/search?q=BTC%20OR%20Bitcoin%20when:1d&hl=en-GB&gl=GB&ceid=GB:en",
            },
            { name: "Cointelegraph Bitcoin", url: "https://cointelegraph.com/rss/tag/bitcoin" },
            { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
          ],
        },
      });
    }

    // Financial collection is configured by downstream clients, such as the
    // trading-bot-platform worker. Avoid seeding demo market jobs here because
    // stale symbols/jobs make the Signal Harvester UI look like it is collecting
    // assets that are no longer active.
  }

  async listJobs() {
    const rows = await this.sql`SELECT * FROM collection_jobs ORDER BY created_at DESC`;
    return rows.map(rowToJob);
  }

  async getJob(id: string) {
    const rows = await this.sql`SELECT * FROM collection_jobs WHERE id = ${id}`;
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async createJob(input: {
    id?: string;
    name: string;
    topic: string;
    sourceKind: SourceKind;
    config: Record<string, unknown>;
    scheduleMs?: number | null;
  }) {
    const id = input.id ?? stableId(`${input.name}:${input.topic}:${input.sourceKind}`).slice(0, 18);
    const rows = await this.sql`
      INSERT INTO collection_jobs (id, name, topic, source_kind, config, schedule_ms)
      VALUES (${id}, ${input.name}, ${input.topic}, ${input.sourceKind}, ${this.sql.json(input.config as any)}, ${input.scheduleMs ?? null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        topic = EXCLUDED.topic,
        source_kind = EXCLUDED.source_kind,
        config = EXCLUDED.config,
        schedule_ms = EXCLUDED.schedule_ms,
        updated_at = NOW()
      RETURNING *
    `;
    return rowToJob(rows[0]);
  }

  async listCredentials() {
    const rows = await this.sql`SELECT * FROM provider_credentials ORDER BY provider, label`;
    return rows.map(rowToCredential).map(toPublicCredential);
  }

  async getCredential(id: string) {
    const rows = await this.sql`SELECT * FROM provider_credentials WHERE id = ${id}`;
    return rows[0] ? rowToCredential(rows[0]) : null;
  }

  async upsertCredential(input: {
    id?: string;
    provider: FinancialProvider | string;
    label: string;
    apiKey?: string | null;
    apiSecret?: string | null;
    extra?: Record<string, unknown>;
  }) {
    const id = input.id ?? stableId(`${input.provider}:${input.label}`).slice(0, 18);
    const rows = await this.sql`
      INSERT INTO provider_credentials (id, provider, label, api_key, api_secret, extra)
      VALUES (${id}, ${input.provider}, ${input.label}, ${input.apiKey ?? null}, ${input.apiSecret ?? null}, ${this.sql.json((input.extra ?? {}) as any)})
      ON CONFLICT (id) DO UPDATE SET
        provider = EXCLUDED.provider,
        label = EXCLUDED.label,
        api_key = COALESCE(EXCLUDED.api_key, provider_credentials.api_key),
        api_secret = COALESCE(EXCLUDED.api_secret, provider_credentials.api_secret),
        extra = EXCLUDED.extra,
        updated_at = NOW()
      RETURNING *
    `;
    return toPublicCredential(rowToCredential(rows[0]));
  }

  async markJobRunning(jobId: string) {
    await this.sql`
      UPDATE collection_jobs SET status = 'running', last_error = NULL, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }

  async markJobFinished(jobId: string, inserted: number) {
    await this.sql`
      UPDATE collection_jobs
      SET status = 'idle', last_run_at = NOW(), last_error = NULL,
          next_run_at = CASE WHEN schedule_ms IS NULL THEN NULL ELSE NOW() + (schedule_ms || ' milliseconds')::interval END,
          updated_at = NOW()
      WHERE id = ${jobId}
    `;
    return inserted;
  }

  async markJobFailed(jobId: string, error: string) {
    await this.sql`
      UPDATE collection_jobs SET status = 'failed', last_error = ${error}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }

  async storeDocuments(documents: HarvestedDocument[]) {
    let inserted = 0;
    for (const doc of documents) {
      const sentiment = scoreSentiment(`${doc.title} ${doc.summary ?? ""}`);
      const rows = await this.sql`
        INSERT INTO documents (
          external_id, source_name, source_kind, topic, title, url, summary, author, published_at,
          sentiment_score, sentiment_label, raw
        ) VALUES (
          ${doc.externalId}, ${doc.sourceName}, ${doc.sourceKind}, ${doc.topic}, ${doc.title}, ${doc.url},
          ${doc.summary}, ${doc.author}, ${doc.publishedAt}, ${sentiment.score}, ${sentiment.label}, ${this.sql.json(doc.raw as any)}
        )
        ON CONFLICT (source_name, external_id) DO NOTHING
        RETURNING id
      `;
      if (rows.length > 0) inserted += 1;
    }
    return inserted;
  }

  async storeMarketData(points: MarketDataPoint[]) {
    let inserted = 0;
    for (const point of points) {
      const rows = await this.sql`
        INSERT INTO market_data_points (
          provider, source_name, symbol, interval, timestamp, open, high, low, close, volume, raw
        ) VALUES (
          ${point.provider}, ${point.sourceName}, ${point.symbol}, ${point.interval}, ${point.timestamp},
          ${point.open}, ${point.high}, ${point.low}, ${point.close}, ${point.volume}, ${this.sql.json(point.raw as any)}
        )
        ON CONFLICT (provider, symbol, interval, timestamp) DO UPDATE SET
          source_name = EXCLUDED.source_name,
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          raw = EXCLUDED.raw,
          collected_at = NOW()
        RETURNING id
      `;
      if (rows.length > 0) inserted += 1;
    }
    return inserted;
  }

  async listDocuments(options: { topic?: string; limit?: number }) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = options.topic
      ? await this.sql`SELECT * FROM documents WHERE topic = ${options.topic} ORDER BY published_at DESC NULLS LAST, collected_at DESC LIMIT ${limit}`
      : await this.sql`SELECT * FROM documents ORDER BY published_at DESC NULLS LAST, collected_at DESC LIMIT ${limit}`;
    return rows.map(rowToDocument);
  }

  async listMarketData(options: {
    provider?: string;
    symbol?: string;
    interval?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = await this.sql`
      SELECT * FROM market_data_points
      WHERE (${options.provider ?? null}::text IS NULL OR provider = ${options.provider ?? null})
        AND (${options.symbol ?? null}::text IS NULL OR symbol = ${options.symbol ?? null})
        AND (${options.interval ?? null}::text IS NULL OR interval = ${options.interval ?? null})
        AND (${options.from ?? null}::timestamptz IS NULL OR timestamp >= ${options.from ?? null})
        AND (${options.to ?? null}::timestamptz IS NULL OR timestamp <= ${options.to ?? null})
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToMarketData);
  }

  async marketDataSummary() {
    const rows = await this.sql`
      SELECT
        COUNT(*)::int AS points,
        COUNT(DISTINCT symbol)::int AS symbols,
        MAX(timestamp) AS latest_timestamp
      FROM market_data_points
    `;
    return rows[0];
  }

  async listMarketCoverage() {
    const rows = await this.sql`
      SELECT
        provider,
        symbol,
        interval,
        COUNT(*)::int AS points,
        MIN(timestamp) AS earliest_timestamp,
        MAX(timestamp) AS latest_timestamp,
        MAX(collected_at) AS last_collected_at
      FROM market_data_points
      GROUP BY provider, symbol, interval
      ORDER BY symbol, interval, provider
    `;
    return rows;
  }

  async listMarketBackfillTargets() {
    const rows = await this.sql`
      SELECT DISTINCT config->>'provider' AS provider, symbols.symbol, config->>'interval' AS interval
      FROM collection_jobs,
        LATERAL jsonb_array_elements_text(config->'symbols') AS symbols(symbol)
      WHERE source_kind = 'financial-api'
        AND enabled = true
        AND config->>'provider' = 'binance'
        AND config->>'interval' = '1m'
      ORDER BY symbol
    `;
    return rows.map((row) => ({ provider: row.provider, symbol: row.symbol, interval: row.interval }));
  }

  async getMarketBackfillState(provider: string, symbol: string, interval: string) {
    const rows = await this.sql`
      SELECT * FROM market_data_backfills
      WHERE provider = ${provider} AND symbol = ${symbol} AND interval = ${interval}
    `;
    return rows[0] ? rowToMarketBackfill(rows[0]) : null;
  }

  async upsertMarketBackfillState(input: {
    provider: string;
    symbol: string;
    interval: string;
    status: MarketBackfillState["status"];
    startTime?: Date | null;
    nextStartTime?: Date | null;
    latestAvailableTime?: Date | null;
    lastBatchAt?: Date | null;
    lastFetched?: number;
    lastInserted?: number;
    totalFetchedDelta?: number;
    totalInsertedDelta?: number;
    lastError?: string | null;
  }) {
    const rows = await this.sql`
      INSERT INTO market_data_backfills (
        provider, symbol, interval, status, start_time, next_start_time, latest_available_time,
        last_batch_at, last_fetched, last_inserted, total_fetched, total_inserted, last_error
      ) VALUES (
        ${input.provider}, ${input.symbol}, ${input.interval}, ${input.status}, ${input.startTime ?? null},
        ${input.nextStartTime ?? null}, ${input.latestAvailableTime ?? null}, ${input.lastBatchAt ?? null},
        ${input.lastFetched ?? 0}, ${input.lastInserted ?? 0}, ${input.totalFetchedDelta ?? 0},
        ${input.totalInsertedDelta ?? 0}, ${input.lastError ?? null}
      )
      ON CONFLICT (provider, symbol, interval) DO UPDATE SET
        status = EXCLUDED.status,
        start_time = COALESCE(EXCLUDED.start_time, market_data_backfills.start_time),
        next_start_time = COALESCE(EXCLUDED.next_start_time, market_data_backfills.next_start_time),
        latest_available_time = COALESCE(EXCLUDED.latest_available_time, market_data_backfills.latest_available_time),
        last_batch_at = COALESCE(EXCLUDED.last_batch_at, market_data_backfills.last_batch_at),
        last_fetched = EXCLUDED.last_fetched,
        last_inserted = EXCLUDED.last_inserted,
        total_fetched = market_data_backfills.total_fetched + EXCLUDED.total_fetched,
        total_inserted = market_data_backfills.total_inserted + EXCLUDED.total_inserted,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
      RETURNING *
    `;
    return rowToMarketBackfill(rows[0]);
  }

  async markOldestMarketBackfillFailed(error: string) {
    await this.sql`
      UPDATE market_data_backfills
      SET status = 'failed', last_error = ${error}, updated_at = NOW()
      WHERE (provider, symbol, interval) IN (
        SELECT provider, symbol, interval FROM market_data_backfills
        WHERE status = 'running'
        ORDER BY updated_at ASC
        LIMIT 1
      )
    `;
  }

  async listMarketBackfills() {
    const rows = await this.sql`SELECT * FROM market_data_backfills ORDER BY symbol, interval, provider`;
    return rows.map(rowToMarketBackfill);
  }

  async sentimentSummary(options: { topic: string; windowHours: number }) {
    const rows = await this.sql`
      SELECT
        COUNT(*)::int AS documents,
        COALESCE(AVG(sentiment_score), 0)::float AS average_score,
        COUNT(*) FILTER (WHERE sentiment_label = 'positive')::int AS positive,
        COUNT(*) FILTER (WHERE sentiment_label = 'neutral')::int AS neutral,
        COUNT(*) FILTER (WHERE sentiment_label = 'negative')::int AS negative,
        MAX(published_at) AS latest_published_at
      FROM documents
      WHERE topic = ${options.topic}
        AND COALESCE(published_at, collected_at) >= NOW() - (${options.windowHours} || ' hours')::interval
    `;
    return rows[0];
  }

  async contextEvents(options: { topic: string; from?: Date; to?: Date; limit?: number }) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const from = options.from ?? new Date(0);
    const to = options.to ?? new Date();
    const rows = await this.sql`
      SELECT * FROM documents
      WHERE topic = ${options.topic}
        AND COALESCE(published_at, collected_at) BETWEEN ${from} AND ${to}
      ORDER BY COALESCE(published_at, collected_at) ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToDocument).map((doc) => ({
      id: doc.id,
      source: doc.sourceName,
      kind: "news_sentiment",
      asset: doc.topic,
      symbol: `${doc.topic}/USDT`,
      publishedAt: doc.publishedAt?.toISOString() ?? doc.collectedAt.toISOString(),
      receivedAt: doc.collectedAt.toISOString(),
      title: doc.title,
      url: doc.url,
      score: doc.sentimentScore,
      confidence: Math.min(1, Math.abs(doc.sentimentScore) + 0.25),
      payload: {
        label: doc.sentimentLabel,
        summary: doc.summary,
        author: doc.author,
      },
    }));
  }
}
