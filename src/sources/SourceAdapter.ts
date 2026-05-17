import type { CollectionJob, HarvestedDocument } from "../types";

export interface SourceAdapter {
  readonly kind: string;
  collect(job: CollectionJob): Promise<HarvestedDocument[]>;
}
