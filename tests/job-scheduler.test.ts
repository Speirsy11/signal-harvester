import { describe, expect, it, vi } from "vitest";

import { startJobScheduler } from "../src/jobs/JobScheduler";

describe("JobScheduler", () => {
  it("runs due jobs without overlapping the same active job", async () => {
    const job = { id: "market-1" };
    const repository = {
      listDueJobs: vi.fn().mockResolvedValue([job]),
    };
    let release: () => void = () => undefined;
    const runner = {
      run: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
    };
    const scheduler = startJobScheduler(repository as never, runner as never, { enabled: false, maxConcurrentRuns: 2 });

    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(runner.run).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(scheduler.getMetrics().active).toBe(0));
    await scheduler.runOnce();
    scheduler.close();

    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});
