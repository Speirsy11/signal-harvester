import type { SourceAdapter } from "./SourceAdapter";
import { RssNewsSource } from "./RssNewsSource";

export function createAdapters(): Map<string, SourceAdapter> {
  return new Map([["news-rss", new RssNewsSource()]]);
}
