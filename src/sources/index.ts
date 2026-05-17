import type { Repository } from "../db/repository";

import { FinancialApiSource } from "./FinancialApiSource";
import { RssNewsSource } from "./RssNewsSource";
import type { SourceAdapter } from "./SourceAdapter";

export function createAdapters(repository: Repository): Map<string, SourceAdapter> {
  const adapters: Array<[string, SourceAdapter]> = [
    ["news-rss", new RssNewsSource()],
    ["financial-api", new FinancialApiSource(repository)],
  ];
  return new Map(adapters);
}
