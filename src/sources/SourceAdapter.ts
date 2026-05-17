import type { CollectionJob, HarvestResult } from "../types";

export interface SourceAdapter {
  readonly kind: string;
  collect(job: CollectionJob): Promise<HarvestResult>;
}
