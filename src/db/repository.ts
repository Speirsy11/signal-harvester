import crypto from "node:crypto";

import type { Sql } from "postgres";

import { scoreSentiment } from "../sentiment/lexicon";
import type { CollectionJob, HarvestedDocument, SourceKind, StoredDocument } from "../types";

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

export function stableId(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export class Repository {
  constructor(private readonly sql: Sql) {}

  async seedDefaults() {
    const existing = await this.getJob("btc-news");
    if (existing) return;

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

  async listDocuments(options: { topic?: string; limit?: number }) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = options.topic
      ? await this.sql`SELECT * FROM documents WHERE topic = ${options.topic} ORDER BY published_at DESC NULLS LAST, collected_at DESC LIMIT ${limit}`
      : await this.sql`SELECT * FROM documents ORDER BY published_at DESC NULLS LAST, collected_at DESC LIMIT ${limit}`;
    return rows.map(rowToDocument);
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
