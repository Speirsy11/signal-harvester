import { XMLParser } from "fast-xml-parser";

import type { CollectionJob, HarvestResult, HarvestedDocument } from "../types";

import type { SourceAdapter } from "./SourceAdapter";

interface RssFeedConfig {
  feeds?: Array<{ name: string; url: string }>;
}

interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { "#text"?: string };
  description?: string;
  pubDate?: string;
  author?: string;
  creator?: string;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) return String(value["#text"]);
  return undefined;
}

export class RssNewsSource implements SourceAdapter {
  readonly kind = "news-rss";
  private parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  async collect(job: CollectionJob): Promise<HarvestResult> {
    const config = job.config as RssFeedConfig;
    const feeds = config.feeds ?? [];
    const documents: HarvestedDocument[] = [];

    for (const feed of feeds) {
      const response = await fetch(feed.url, { headers: { "user-agent": "SignalHarvester/0.1" } });
      if (!response.ok) throw new Error(`RSS fetch failed for ${feed.name}: ${response.status}`);
      const xml = await response.text();
      const parsed = this.parser.parse(xml) as any;
      const items = asArray<RssItem>(parsed?.rss?.channel?.item ?? parsed?.feed?.entry);

      for (const item of items) {
        const title = text(item.title)?.trim();
        const url = text(item.link)?.trim();
        if (!title || !url) continue;
        const guid = text(item.guid) ?? url;
        const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
        documents.push({
          externalId: guid,
          sourceName: feed.name,
          sourceKind: "news-rss",
          topic: job.topic,
          title,
          url,
          summary: text(item.description) ?? null,
          author: text(item.author) ?? text(item.creator) ?? null,
          publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
          raw: item,
        });
      }
    }

    return { documents };
  }
}
