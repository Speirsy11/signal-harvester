import { describe, expect, it, vi } from "vitest";

import { JobRunner } from "../src/jobs/JobRunner";
import type { CollectionJob, HarvestedDocument } from "../src/types";

function makeJob(overrides: Partial<CollectionJob> = {}): CollectionJob {
  return {
    id: "btc-news",
    name: "BTC News",
    topic: "BTC",
    sourceKind: "news-rss",
    enabled: true,
    config: { urls: ["https://example.com/rss"] },
    scheduleMs: null,
    status: "idle",
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeDoc(): HarvestedDocument {
  return {
    externalId: "doc-1",
    sourceName: "test-rss",
    sourceKind: "news-rss",
    topic: "BTC",
    url: "https://example.com/story",
    title: "Bitcoin rallies after ETF inflows",
    summary: "BTC momentum improved after institutional demand increased.",
    publishedAt: new Date("2026-01-01T00:05:00Z"),
    author: null,
    raw: {},
  };
}

describe("JobRunner", () => {
  it("runs a configured adapter, stores documents, and marks success", async () => {
    const job = makeJob();
    const doc = makeDoc();
    const repository = {
      getJob: vi.fn().mockResolvedValue(job),
      markJobRunning: vi.fn().mockResolvedValue(undefined),
      storeDocuments: vi.fn().mockResolvedValue(1),
      storeMarketData: vi.fn().mockResolvedValue(0),
      markJobFinished: vi.fn().mockResolvedValue(undefined),
      markJobFailed: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = { collect: vi.fn().mockResolvedValue({ documents: [doc] }) };

    const runner = new JobRunner(repository as never, new Map([["news-rss", adapter as never]]));
    const result = await runner.run(job.id);

    expect(repository.markJobRunning).toHaveBeenCalledWith(job.id);
    expect(adapter.collect).toHaveBeenCalledWith(job);
    expect(repository.storeDocuments).toHaveBeenCalledWith([doc]);
    expect(repository.storeMarketData).toHaveBeenCalledWith([]);
    expect(repository.markJobFinished).toHaveBeenCalledWith(job.id, 1);
    expect(repository.markJobFailed).not.toHaveBeenCalled();
    expect(result).toEqual({
      fetched: 1,
      inserted: 1,
      documents: { fetched: 1, inserted: 1 },
      marketData: { fetched: 0, inserted: 0 },
    });
  });

  it("marks a job failed when collection throws", async () => {
    const job = makeJob();
    const repository = {
      getJob: vi.fn().mockResolvedValue(job),
      markJobRunning: vi.fn().mockResolvedValue(undefined),
      storeDocuments: vi.fn(),
      storeMarketData: vi.fn(),
      markJobFinished: vi.fn(),
      markJobFailed: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = { collect: vi.fn().mockRejectedValue(new Error("rss unavailable")) };

    const runner = new JobRunner(repository as never, new Map([["news-rss", adapter as never]]));

    await expect(runner.run(job.id)).rejects.toThrow("rss unavailable");
    expect(repository.markJobFailed).toHaveBeenCalledWith(job.id, "rss unavailable");
    expect(repository.markJobFinished).not.toHaveBeenCalled();
  });
});
