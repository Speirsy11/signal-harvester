import type { Repository } from "../db/repository";
import { JobRunner } from "./JobRunner";

export interface JobSchedulerOptions {
  intervalMs?: number;
  enabled?: boolean;
  maxConcurrentRuns?: number;
}

const DEFAULT_SCHEDULER_INTERVAL_MS = 5_000;

export function startJobScheduler(
  repository: Repository,
  runner: JobRunner,
  options: JobSchedulerOptions = {}
) {
  const enabled = options.enabled ?? process.env["JOB_SCHEDULER_ENABLED"] !== "0";
  const intervalMs = Math.max(500, options.intervalMs ?? Number(process.env["JOB_SCHEDULER_INTERVAL_MS"] ?? DEFAULT_SCHEDULER_INTERVAL_MS));
  const maxConcurrentRuns = Math.max(1, options.maxConcurrentRuns ?? Number(process.env["JOB_SCHEDULER_MAX_CONCURRENT_RUNS"] ?? 4));
  const active = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastError: string | null = null;

  const tick = async (manual = false) => {
    if ((!enabled && !manual) || stopped) return;
    try {
      const capacity = maxConcurrentRuns - active.size;
      if (capacity <= 0) return;
      const jobs = await repository.listDueJobs(capacity);
      for (const job of jobs) {
        if (active.has(job.id)) continue;
        active.add(job.id);
        void runner.run(job.id)
          .catch((error) => {
            lastError = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            active.delete(job.id);
          });
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  };

  if (enabled) {
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
  }

  return {
    runOnce: () => tick(true),
    getMetrics: () => ({
      enabled,
      intervalMs,
      maxConcurrentRuns,
      active: active.size,
      activeJobs: [...active],
      lastError,
    }),
    close: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
