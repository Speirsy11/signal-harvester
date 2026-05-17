import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";

import { Repository } from "../db/repository";
import { ensureSchema } from "../db/schema";
import { JobRunner } from "../jobs/JobRunner";
import { createAdapters } from "../sources";
import { html } from "../ui/html";

export async function buildServer(sql: Sql) {
  await ensureSchema(sql);
  const repository = new Repository(sql);
  await repository.seedDefaults();
  const runner = new JobRunner(repository, createAdapters());
  const app = Fastify({ logger: true });
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

  app.get("/api/documents", async (request) => {
    const query = z
      .object({ topic: z.string().optional(), limit: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return repository.listDocuments(query);
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
