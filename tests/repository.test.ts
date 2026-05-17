import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Repository } from "../src/db/repository";
import { ensureSchema } from "../src/db/schema";

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("Repository", () => {
  const sql = postgres(databaseUrl ?? "");
  const repo = new Repository(sql);

  beforeAll(async () => {
    await ensureSchema(sql);
    await sql`TRUNCATE documents, collection_jobs`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("stores documents idempotently and summarizes sentiment", async () => {
    await repo.storeDocuments([
      {
        externalId: "1",
        sourceName: "Example",
        sourceKind: "news-rss",
        topic: "BTC",
        title: "Bitcoin rally gains",
        url: "https://example.com/1",
        summary: "bullish inflows",
        author: null,
        publishedAt: new Date(),
        raw: {},
      },
    ]);
    await repo.storeDocuments([
      {
        externalId: "1",
        sourceName: "Example",
        sourceKind: "news-rss",
        topic: "BTC",
        title: "Bitcoin rally gains",
        url: "https://example.com/1",
        summary: "bullish inflows",
        author: null,
        publishedAt: new Date(),
        raw: {},
      },
    ]);

    const docs = await repo.listDocuments({ topic: "BTC" });
    const summary = await repo.sentimentSummary({ topic: "BTC", windowHours: 24 });
    expect(docs).toHaveLength(1);
    expect(summary.documents).toBe(1);
    expect(summary.average_score).toBeGreaterThan(0);
  });
});
