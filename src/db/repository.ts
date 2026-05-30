import crypto from "node:crypto";

import type { Sql } from "postgres";

import {
  buildRollupPoint,
  closedRollupWindowsBetween,
  closedRollupWindowsForPoint,
  isRollupMarketInterval,
  nextRollupWindow,
  ROLLUP_MARKET_INTERVALS,
  rollupWindowForTimestamp,
  SOURCE_MARKET_INTERVAL,
  type RollupMarketInterval,
  type RollupWindow,
} from "../marketRollups";
import { scoreSentiment } from "../sentiment/lexicon";
import type {
  CollectionJob,
  FinancialProvider,
  HarvestedDocument,
  MarketBackfillState,
  MarketDataPoint,
  MarketRollupBackfillState,
  ProviderCredential,
  PublicProviderCredential,
  SourceKind,
  StoredDocument,
  StoredMarketDataPoint,
} from "../types";

const DEFAULT_FINANCIAL_SCHEDULE_MS = 60_000;

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

function rowToMarketRollupBackfill(row: any): MarketRollupBackfillState {
  return {
    provider: row.provider,
    symbol: row.symbol,
    interval: row.interval,
    status: row.status,
    startTime: row.start_time,
    nextStartTime: row.next_start_time,
    latestAvailableTime: row.latest_available_time,
    lastBatchAt: row.last_batch_at,
    lastInserted: Number(row.last_inserted ?? 0),
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
    await this.ensureFinancialJobSchedules();
  }

  async ensureFinancialJobSchedules(defaultScheduleMs = DEFAULT_FINANCIAL_SCHEDULE_MS) {
    await this.sql`
      UPDATE collection_jobs
      SET schedule_ms = ${defaultScheduleMs},
          next_run_at = COALESCE(next_run_at, NOW()),
          updated_at = NOW()
      WHERE source_kind = 'financial-api'
        AND enabled = true
        AND schedule_ms IS NULL
    `;
  }

  async listJobs() {
    const rows = await this.sql`SELECT * FROM collection_jobs ORDER BY created_at DESC`;
    return rows.map(rowToJob);
  }

  async listDueJobs(limit = 50) {
    const rows = await this.sql`
      SELECT * FROM collection_jobs
      WHERE enabled = true
        AND schedule_ms IS NOT NULL
        AND status != 'running'
        AND (next_run_at IS NULL OR next_run_at <= NOW())
      ORDER BY COALESCE(next_run_at, created_at) ASC
      LIMIT ${limit}
    `;
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
    if (points.length === 0) return 0;

    const directRows = await this.insertMarketData(points);
    await this.storeClosedMarketRollups(points);

    return directRows;
  }

  private async insertMarketData(points: MarketDataPoint[]) {
    if (points.length === 0) return 0;

    const payload = points.map((point) => ({
      provider: point.provider,
      source_name: point.sourceName,
      symbol: point.symbol,
      interval: point.interval,
      timestamp: point.timestamp.toISOString(),
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      volume: point.volume,
      raw: point.raw,
    }));

    const rows = await this.sql`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${this.sql.json(payload as any)}::jsonb) AS point(
          provider text,
          source_name text,
          symbol text,
          interval text,
          timestamp timestamptz,
          open double precision,
          high double precision,
          low double precision,
          close double precision,
          volume double precision,
          raw jsonb
        )
      )
      INSERT INTO market_data_points (
        provider, source_name, symbol, interval, timestamp, open, high, low, close, volume, raw
      )
      SELECT provider, source_name, symbol, interval, timestamp, open, high, low, close, volume, raw
      FROM input
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

    return rows.length;
  }

  private async storeClosedMarketRollups(points: MarketDataPoint[]) {
    const sourcePoints = points.filter((point) => point.interval === SOURCE_MARKET_INTERVAL);
    if (sourcePoints.length === 0) return 0;

    const groupedWindows = new Map<
      string,
      { provider: string; symbol: string; windows: Map<string, RollupWindow> }
    >();

    for (const point of sourcePoints) {
      const groupKey = `${point.provider}\0${point.symbol}`;
      let group = groupedWindows.get(groupKey);
      if (!group) {
        group = { provider: point.provider, symbol: point.symbol, windows: new Map() };
        groupedWindows.set(groupKey, group);
      }

      for (const window of closedRollupWindowsForPoint(point)) {
        group.windows.set(`${window.interval}\0${window.start.toISOString()}`, window);
      }
    }

    let rollupsStored = 0;
    for (const group of groupedWindows.values()) {
      if (group.windows.size === 0) continue;
      rollupsStored += await this.storeRollupWindows(group.provider, group.symbol, [...group.windows.values()]);
    }

    return rollupsStored;
  }

  async refreshClosedMarketRollups(options: { lookbackDays?: number } = {}) {
    const lookbackDays = Math.min(Math.max(options.lookbackDays ?? 45, 1), 370);
    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60_000);
    const targetRows = await this.sql`
      SELECT DISTINCT provider, symbol
      FROM market_data_points
      WHERE interval = ${SOURCE_MARKET_INTERVAL}
        AND timestamp >= ${from}
      ORDER BY provider, symbol
    `;

    let rollupsStored = 0;
    for (const target of targetRows) {
      const windows = ROLLUP_MARKET_INTERVALS.flatMap((interval) =>
        closedRollupWindowsBetween(interval, from, now)
      );
      rollupsStored += await this.storeRollupWindows(target.provider, target.symbol, windows);
    }

    return {
      targets: targetRows.length,
      lookbackDays,
      rollupsStored,
    };
  }

  private async storeRollupWindows(provider: string, symbol: string, windows: RollupWindow[]) {
    if (windows.length === 0) return 0;

    const minStart = new Date(Math.min(...windows.map((window) => window.start.getTime())));
    const maxEnd = new Date(Math.max(...windows.map((window) => window.end.getTime())));

    const rows = await this.sql`
      SELECT *
      FROM market_data_points
      WHERE provider = ${provider}
        AND symbol = ${symbol}
        AND interval = ${SOURCE_MARKET_INTERVAL}
        AND timestamp >= ${minStart}
        AND timestamp < ${maxEnd}
      ORDER BY timestamp ASC
    `;
    const storedPoints = rows.map(rowToMarketData);
    const storedPointsByTimestamp = new Map(storedPoints.map((point) => [point.timestamp.getTime(), point]));
    const rollups: MarketDataPoint[] = [];

    for (const window of windows) {
      const bucketPoints: MarketDataPoint[] = [];
      for (let timestamp = window.start.getTime(); timestamp < window.end.getTime(); timestamp += 60_000) {
        const point = storedPointsByTimestamp.get(timestamp);
        if (!point) break;
        bucketPoints.push(point);
      }
      const rollup = buildRollupPoint(window, bucketPoints);
      if (rollup) rollups.push(rollup);
    }

    return this.insertMarketData(rollups);
  }

  async seedMarketRollupBackfillStates() {
    const rows = await this.sql`
      SELECT provider, symbol, MIN(timestamp) AS earliest_timestamp, MAX(timestamp) AS latest_timestamp
      FROM market_data_points
      WHERE interval = ${SOURCE_MARKET_INTERVAL}
      GROUP BY provider, symbol
      ORDER BY provider, symbol
    `;

    let seeded = 0;
    for (const row of rows) {
      const earliest = row.earliest_timestamp as Date | null;
      const latest = row.latest_timestamp as Date | null;
      if (!earliest || !latest) continue;

      for (const interval of ROLLUP_MARKET_INTERVALS) {
        const firstWindow = rollupWindowForTimestamp(interval, earliest);
        const values = await this.sql`
          INSERT INTO market_rollup_backfills (
            provider, symbol, interval, status, start_time, next_start_time, latest_available_time
          ) VALUES (
            ${row.provider}, ${row.symbol}, ${interval}, 'idle', ${firstWindow.start}, ${firstWindow.start}, ${latest}
          )
          ON CONFLICT (provider, symbol, interval) DO UPDATE SET
            latest_available_time = EXCLUDED.latest_available_time,
            status = CASE
              WHEN market_rollup_backfills.status = 'complete'
               AND market_rollup_backfills.next_start_time < EXCLUDED.latest_available_time
              THEN 'idle'
              ELSE market_rollup_backfills.status
            END,
            updated_at = NOW()
          RETURNING provider
        `;
        seeded += values.length;
      }
    }

    return seeded;
  }

  async runMarketRollupBackfillBatches(options: { maxBatches?: number; batchWindows?: number } = {}) {
    const maxBatches = Math.min(Math.max(options.maxBatches ?? 1, 1), 10_000);
    const batchWindows = Math.min(Math.max(options.batchWindows ?? 1_000, 1), 10_000_000);
    await this.seedMarketRollupBackfillStates();

    let batchesRun = 0;
    let rollupsStored = 0;
    let completed = 0;
    let failed = 0;

    for (let index = 0; index < maxBatches; index += 1) {
      const result = await this.runOneMarketRollupBackfillBatch(batchWindows);
      if (!result) break;
      batchesRun += 1;
      rollupsStored += result.rollupsStored;
      if (result.status === "complete") completed += 1;
      if (result.status === "failed") failed += 1;
    }

    const summary = await this.marketRollupBackfillSummary();
    return { batchesRun, rollupsStored, completed, failed, summary };
  }

  private async runOneMarketRollupBackfillBatch(batchWindows: number) {
    const rows = await this.sql`
      UPDATE market_rollup_backfills
      SET status = 'running', updated_at = NOW(), last_error = NULL
      WHERE (provider, symbol, interval) IN (
        SELECT provider, symbol, interval
        FROM market_rollup_backfills
        WHERE status IN ('idle', 'failed', 'running')
        ORDER BY updated_at ASC, provider, symbol, interval
        LIMIT 1
      )
      RETURNING *
    `;
    const row = rows[0];
    if (!row) return null;

    const state = rowToMarketRollupBackfill(row);
    if (!isRollupMarketInterval(state.interval)) {
      await this.markMarketRollupBackfillFailed(state.provider, state.symbol, state.interval, "Unknown rollup interval");
      return { status: "failed" as const, rollupsStored: 0 };
    }

    const nextStartTime = state.nextStartTime ?? state.startTime;
    const latestAvailableTime = state.latestAvailableTime;
    if (!nextStartTime || !latestAvailableTime) {
      await this.markMarketRollupBackfillFailed(
        state.provider,
        state.symbol,
        state.interval,
        "Rollup backfill state is missing cursor or latest available time"
      );
      return { status: "failed" as const, rollupsStored: 0 };
    }

    const currentWindow = rollupWindowForTimestamp(state.interval, nextStartTime);
    if (currentWindow.end > latestAvailableTime) {
      await this.completeMarketRollupBackfill(state.provider, state.symbol, state.interval, latestAvailableTime);
      return { status: "complete" as const, rollupsStored: 0 };
    }

    const endWindow = this.endRollupWindowForBatch(state.interval, currentWindow, latestAvailableTime, batchWindows);

    const inserted = await this.insertRollupsForRange(
      state.provider,
      state.symbol,
      state.interval,
      currentWindow.start,
      endWindow.start
    );
    const status = endWindow.end > latestAvailableTime ? "complete" : "idle";
    await this.upsertMarketRollupBackfillState({
      provider: state.provider,
      symbol: state.symbol,
      interval: state.interval,
      status,
      nextStartTime: endWindow.start,
      latestAvailableTime,
      lastInserted: inserted,
      totalInsertedDelta: inserted,
      lastError: null,
    });

    return { status, rollupsStored: inserted };
  }

  private endRollupWindowForBatch(
    interval: RollupMarketInterval,
    currentWindow: RollupWindow,
    latestAvailableTime: Date,
    batchWindows: number
  ) {
    let endWindow = currentWindow;
    let processedWindows = 0;
    while (processedWindows < batchWindows && endWindow.end <= latestAvailableTime) {
      endWindow = nextRollupWindow(interval, endWindow);
      processedWindows += 1;
    }
    return endWindow;
  }

  private async insertRollupsForRange(
    provider: string,
    symbol: string,
    interval: RollupMarketInterval,
    start: Date,
    end: Date
  ) {
    const expectedPoints = rollupWindowForTimestamp(interval, start).expectedPoints;
    const bucketExpression =
      interval === "1W"
        ? this.sql`date_trunc('week', timestamp)`
        : interval === "1M"
          ? this.sql`date_trunc('month', timestamp)`
          : this.sql`date_bin(${expectedPoints * 60_000} * interval '1 millisecond', timestamp, TIMESTAMPTZ '1970-01-01')`;
    const expectedExpression =
      interval === "1M"
        ? this.sql`(EXTRACT(EPOCH FROM ((bucket + interval '1 month') - bucket)) / 60)::int`
        : this.sql`${expectedPoints}::int`;
    const bucketEndExpression =
      interval === "1M"
        ? this.sql`timestamp + interval '1 month'`
        : this.sql`timestamp + ${expectedPoints * 60_000} * interval '1 millisecond'`;

    const rows = await this.sql`
      WITH bucketed AS (
        SELECT
          provider,
          source_name,
          symbol,
          ${bucketExpression} AS bucket,
          timestamp,
          open,
          high,
          low,
          close,
          volume
        FROM market_data_points
        WHERE provider = ${provider}
          AND symbol = ${symbol}
          AND interval = ${SOURCE_MARKET_INTERVAL}::text
          AND timestamp >= ${start}
          AND timestamp < ${end}
      ),
      rolled AS (
        SELECT
          provider,
          symbol,
          ${interval}::text AS interval,
          bucket AS timestamp,
          (array_agg(source_name ORDER BY timestamp ASC))[1] AS source_name,
          (array_agg(open ORDER BY timestamp ASC))[1] AS open,
          MAX(high) AS high,
          MIN(low) AS low,
          (array_agg(close ORDER BY timestamp DESC))[1] AS close,
          CASE WHEN COUNT(volume) = 0 THEN NULL ELSE SUM(COALESCE(volume, 0)) END AS volume,
          COUNT(*)::int AS source_points,
          ${expectedExpression} AS expected_points
        FROM bucketed
        GROUP BY provider, symbol, bucket
      )
      INSERT INTO market_data_points (
        provider, source_name, symbol, interval, timestamp, open, high, low, close, volume, raw
      )
      SELECT
        provider,
        source_name,
        symbol,
        interval,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        jsonb_build_object(
          'derivedFromInterval', ${SOURCE_MARKET_INTERVAL}::text,
          'sourcePoints', source_points,
          'bucketStart', timestamp,
          'bucketEnd', ${bucketEndExpression},
          'rollupInterval', ${interval}::text
        )
      FROM rolled
      WHERE source_points = expected_points
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

    return rows.length;
  }

  private async upsertMarketRollupBackfillState(input: {
    provider: string;
    symbol: string;
    interval: string;
    status: MarketRollupBackfillState["status"];
    nextStartTime?: Date | null;
    latestAvailableTime?: Date | null;
    lastInserted?: number;
    totalInsertedDelta?: number;
    lastError?: string | null;
  }) {
    const rows = await this.sql`
      INSERT INTO market_rollup_backfills (
        provider, symbol, interval, status, next_start_time, latest_available_time,
        last_batch_at, last_inserted, total_inserted, last_error
      ) VALUES (
        ${input.provider}, ${input.symbol}, ${input.interval}, ${input.status},
        ${input.nextStartTime ?? null}, ${input.latestAvailableTime ?? null},
        NOW(), ${input.lastInserted ?? 0}, ${input.totalInsertedDelta ?? 0}, ${input.lastError ?? null}
      )
      ON CONFLICT (provider, symbol, interval) DO UPDATE SET
        status = EXCLUDED.status,
        next_start_time = COALESCE(EXCLUDED.next_start_time, market_rollup_backfills.next_start_time),
        latest_available_time = COALESCE(EXCLUDED.latest_available_time, market_rollup_backfills.latest_available_time),
        last_batch_at = EXCLUDED.last_batch_at,
        last_inserted = EXCLUDED.last_inserted,
        total_inserted = market_rollup_backfills.total_inserted + EXCLUDED.total_inserted,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
      RETURNING *
    `;
    return rowToMarketRollupBackfill(rows[0]);
  }

  private async completeMarketRollupBackfill(provider: string, symbol: string, interval: string, latestAvailableTime: Date) {
    await this.sql`
      UPDATE market_rollup_backfills
      SET status = 'complete',
          latest_available_time = ${latestAvailableTime},
          last_batch_at = NOW(),
          last_inserted = 0,
          last_error = NULL,
          updated_at = NOW()
      WHERE provider = ${provider}
        AND symbol = ${symbol}
        AND interval = ${interval}
    `;
  }

  private async markMarketRollupBackfillFailed(provider: string, symbol: string, interval: string, error: string) {
    await this.sql`
      UPDATE market_rollup_backfills
      SET status = 'failed',
          last_error = ${error},
          updated_at = NOW()
      WHERE provider = ${provider}
        AND symbol = ${symbol}
        AND interval = ${interval}
    `;
  }

  async listMarketRollupBackfills() {
    await this.seedMarketRollupBackfillStates();
    const rows = await this.sql`SELECT * FROM market_rollup_backfills ORDER BY symbol, interval, provider`;
    return rows.map(rowToMarketRollupBackfill);
  }

  private async marketRollupBackfillSummary() {
    const rows = await this.sql`
      SELECT status, COUNT(*)::int AS count
      FROM market_rollup_backfills
      GROUP BY status
      ORDER BY status
    `;
    return rows;
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

  async listLatestMarketDataPerSymbol() {
    const rows = await this.sql`
      WITH targets AS (
        SELECT DISTINCT config->>'provider' AS provider, symbols.symbol, config->>'interval' AS interval
        FROM collection_jobs,
          LATERAL jsonb_array_elements_text(config->'symbols') AS symbols(symbol)
        WHERE source_kind = 'financial-api'
          AND enabled = true
          AND config->>'provider' IS NOT NULL
          AND config->>'interval' IS NOT NULL
        UNION
        SELECT DISTINCT provider, symbol, interval
        FROM market_data_backfills
      )
      SELECT point.*
      FROM targets
      CROSS JOIN LATERAL (
        SELECT *
        FROM market_data_points
        WHERE provider = targets.provider
          AND symbol = targets.symbol
          AND interval = targets.interval
        ORDER BY timestamp DESC
        LIMIT 1
      ) AS point
      ORDER BY point.symbol, point.interval, point.provider
    `;
    return rows.map(rowToMarketData);
  }

  async getLatestMarketDataPoint(provider: string, symbol: string, interval: string) {
    const rows = await this.sql`
      SELECT * FROM market_data_points
      WHERE provider = ${provider}
        AND symbol = ${symbol}
        AND interval = ${interval}
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    return rows[0] ? rowToMarketData(rows[0]) : null;
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
        start_time = COALESCE(market_data_backfills.start_time, EXCLUDED.start_time),
        next_start_time = GREATEST(
          COALESCE(EXCLUDED.next_start_time, market_data_backfills.next_start_time),
          COALESCE(market_data_backfills.next_start_time, EXCLUDED.next_start_time)
        ),
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

  async markMarketBackfillFailed(provider: string, symbol: string, interval: string, error: string) {
    await this.sql`
      UPDATE market_data_backfills
      SET status = 'failed', last_error = ${error}, updated_at = NOW()
      WHERE provider = ${provider} AND symbol = ${symbol} AND interval = ${interval}
    `;
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
