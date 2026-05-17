import { describe, expect, it } from "vitest";

import { scoreSentiment } from "../src/sentiment/lexicon";

describe("scoreSentiment", () => {
  it("labels bullish text as positive", () => {
    const result = scoreSentiment("Bitcoin rally gains as bullish inflows surge");
    expect(result.label).toBe("positive");
    expect(result.score).toBeGreaterThan(0);
  });

  it("labels bearish text as negative", () => {
    const result = scoreSentiment("Bitcoin crash fear after hack and heavy outflows");
    expect(result.label).toBe("negative");
    expect(result.score).toBeLessThan(0);
  });
});
