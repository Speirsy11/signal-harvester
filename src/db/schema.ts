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

  await sql`CREATE INDEX IF NOT EXISTS idx_documents_topic_time ON documents(topic, published_at DESC NULLS LAST, collected_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_documents_sentiment ON documents(topic, sentiment_label, collected_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_collection_jobs_topic ON collection_jobs(topic, source_kind)`;
}
