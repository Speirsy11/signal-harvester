import type { SentimentLabel } from "../types";

const positive = new Set([
  "gain", "gains", "gained", "rally", "rallies", "surge", "surges", "bull", "bullish",
  "breakout", "high", "record", "approve", "approved", "adoption", "inflow", "inflows",
  "buy", "buying", "strong", "optimism", "positive", "up", "rise", "rises", "green",
]);

const negative = new Set([
  "loss", "losses", "lost", "crash", "crashes", "plunge", "plunges", "bear", "bearish",
  "hack", "hacked", "exploit", "scam", "fraud", "lawsuit", "ban", "outflow", "outflows",
  "sell", "selling", "weak", "fear", "negative", "down", "fall", "falls", "red", "liquidation",
]);

export function scoreSentiment(text: string): { score: number; label: SentimentLabel } {
  const words = text.toLowerCase().match(/[a-z][a-z-']+/g) ?? [];
  if (words.length === 0) return { score: 0, label: "neutral" };

  let raw = 0;
  for (const word of words) {
    if (positive.has(word)) raw += 1;
    if (negative.has(word)) raw -= 1;
  }

  const score = Math.max(-1, Math.min(1, raw / Math.sqrt(words.length)));
  const label: SentimentLabel = score > 0.1 ? "positive" : score < -0.1 ? "negative" : "neutral";
  return { score: Number(score.toFixed(4)), label };
}
