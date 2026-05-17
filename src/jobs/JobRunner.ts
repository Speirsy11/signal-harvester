import type { Repository } from "../db/repository";
import type { SourceAdapter } from "../sources/SourceAdapter";

export class JobRunner {
  constructor(
    private readonly repository: Repository,
    private readonly adapters: Map<string, SourceAdapter>
  ) {}

  async run(jobId: string) {
    const job = await this.repository.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const adapter = this.adapters.get(job.sourceKind);
    if (!adapter) throw new Error(`No adapter registered for ${job.sourceKind}`);

    await this.repository.markJobRunning(job.id);
    try {
      const docs = await adapter.collect(job);
      const inserted = await this.repository.storeDocuments(docs);
      await this.repository.markJobFinished(job.id, inserted);
      return { fetched: docs.length, inserted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.markJobFailed(job.id, message);
      throw error;
    }
  }
}
