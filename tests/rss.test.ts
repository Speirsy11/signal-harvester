import { describe, expect, it, vi } from "vitest";

import { RssNewsSource } from "../src/sources/RssNewsSource";
import type { CollectionJob } from "../src/types";

const job: CollectionJob = {
  id: "test",
  name: "Test",
  topic: "BTC",
  sourceKind: "news-rss",
  config: { feeds: [{ name: "Example", url: "https://example.com/rss" }] },
  enabled: true,
  scheduleMs: null,
  status: "idle",
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("RssNewsSource", () => {
  it("normalizes RSS items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => `<?xml version="1.0"?><rss><channel><item><title>Bitcoin rally</title><link>https://example.com/a</link><guid>a</guid><description>bullish gains</description><pubDate>Sun, 17 May 2026 12:00:00 GMT</pubDate></item></channel></rss>`,
      }))
    );

    const result = await new RssNewsSource().collect(job);
    expect(result.documents).toHaveLength(1);
    expect(result.documents?.[0]).toMatchObject({
      title: "Bitcoin rally",
      topic: "BTC",
      sourceName: "Example",
    });
  });
});
