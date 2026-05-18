import type { Sql } from "postgres";

export async function ensureSchema(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS collection_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      schedule_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      api_key TEXT,
      api_secret TEXT,
      extra JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      summary TEXT,
      author TEXT,
      published_at TIMESTAMPTZ,
      sentiment_score REAL NOT NULL DEFAULT 0,
      sentiment_label TEXT NOT NULL DEFAULT 'neutral',
      raw JSONB NOT NULL DEFAULT '{}',
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_name, external_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS market_data_points (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      source_name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      open DOUBLE PRECISION NOT NULL,
      high DOUBLE PRECISION NOT NULL,
      low DOUBLE PRECISION NOT NULL,
      close DOUBLE PRECISION NOT NULL,
      volume DOUBLE PRECISION,
      raw JSONB NOT NULL DEFAULT '{}',
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, symbol, interval, timestamp)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS market_data_backfills (
      provider TEXT NOT NULL,
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      start_time TIMESTAMPTZ,
      next_start_time TIMESTAMPTZ,
      latest_available_time TIMESTAMPTZ,
      last_batch_at TIMESTAMPTZ,
      last_fetched INTEGER NOT NULL DEFAULT 0,
      last_inserted INTEGER NOT NULL DEFAULT 0,
      total_fetched INTEGER NOT NULL DEFAULT 0,
      total_inserted INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, symbol, interval)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_documents_topic_time ON documents(topic, published_at DESC NULLS LAST, collected_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_documents_sentiment ON documents(topic, sentiment_label, collected_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_collection_jobs_topic ON collection_jobs(topic, source_kind)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider ON provider_credentials(provider)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_market_data_symbol_time ON market_data_points(symbol, interval, timestamp DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_market_data_backfills_status ON market_data_backfills(status, updated_at DESC)`;
}
