import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";

import { Repository } from "../db/repository";
import { ensureSchema } from "../db/schema";
import { JobRunner } from "../jobs/JobRunner";
import { startMarketBackfill } from "../marketBackfill";
import { createAdapters } from "../sources";
import { html } from "../ui/html";

export async function buildServer(sql: Sql) {
  await ensureSchema(sql);
  const repository = new Repository(sql);
  await repository.seedDefaults();
  const runner = new JobRunner(repository, createAdapters(repository));
  const backfill = startMarketBackfill(repository);
  const app = Fastify({ logger: true });
  app.addHook("onClose", async () => backfill.close());
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(html));

  app.get("/api/jobs", async () => repository.listJobs());

  app.post("/api/jobs", async (request, reply) => {
    const schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      topic: z.string().min(1),
      sourceKind: z.enum(["news-rss", "financial-api", "web-scrape"]),
      config: z.record(z.unknown()),
      scheduleMs: z.number().int().positive().nullable().optional(),
    });
    const input = schema.parse(request.body);
    const job = await repository.createJob(input);
    return reply.code(201).send(job);
  });

  app.post("/api/jobs/:id/run", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return runner.run(params.id);
  });

  app.get("/api/credentials", async () => repository.listCredentials());

  app.post("/api/credentials", async (request, reply) => {
    const schema = z.object({
      id: z.string().min(1).optional(),
      provider: z.string().min(1),
      label: z.string().min(1),
      apiKey: z.string().min(1).optional(),
      apiSecret: z.string().min(1).optional(),
      extra: z.record(z.unknown()).optional(),
    });
    const credential = await repository.upsertCredential(schema.parse(request.body));
    return reply.code(201).send(credential);
  });

  app.post("/api/financial-jobs", async (request, reply) => {
    const schema = z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      topic: z.string().min(1),
      provider: z.enum(["alpha-vantage", "binance"]),
      credentialId: z.string().min(1).optional(),
      symbols: z.array(z.string().min(1)).min(1),
      interval: z.literal("1m"),
      scheduleMs: z.number().int().positive().nullable().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "financial_job_validation_failed",
        message: "Signal Harvester collects 1m market-data candles only; derive higher intervals locally.",
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;
    const job = await repository.createJob({
      id: input.id,
      name: input.name,
      topic: input.topic,
      sourceKind: "financial-api",
      scheduleMs: input.scheduleMs,
      config: {
        provider: input.provider,
        credentialId: input.credentialId,
        symbols: input.symbols,
        interval: input.interval,
      },
    });
    return reply.code(201).send(job);
  });

  app.get("/api/documents", async (request) => {
    const query = z
      .object({ topic: z.string().optional(), limit: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return repository.listDocuments(query);
  });

  app.get("/api/market-data", async (request) => {
    const query = z
      .object({
        provider: z.string().optional(),
        symbol: z.string().optional(),
        interval: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return repository.listMarketData({
      provider: query.provider,
      symbol: query.symbol,
      interval: query.interval,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  });

  app.get("/api/market-data/summary", async () => repository.marketDataSummary());
  app.get("/api/market-data/coverage", async () => repository.listMarketCoverage());
  app.get("/api/market-data/backfills", async () => repository.listMarketBackfills());

  app.post("/api/market-data/backfills/run", async () => {
    await backfill.runOnce();
    return { ok: true };
  });

  app.get("/api/sentiment/summary", async (request) => {
    const query = z
      .object({ topic: z.string().default("BTC"), windowHours: z.coerce.number().positive().default(24) })
      .parse(request.query);
    return repository.sentimentSummary(query);
  });

  app.get("/api/context/events", async (request) => {
    const query = z
      .object({
        topic: z.string().default("BTC"),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return repository.contextEvents({
      topic: query.topic,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  });

  return app;
}
