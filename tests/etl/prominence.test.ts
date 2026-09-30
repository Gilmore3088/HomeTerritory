// The prominence blend: pageview medians (partial current month dropped)
// and the weighted score the difficulty engine consumes.
import assert from "node:assert/strict";
import test from "node:test";
import { blendScore, medianMonthlyViews, titleQuery } from "../../etl/sources/wikipedia-prominence.ts";

test("the partial current month never skews the median", () => {
  const now = new Date(Date.UTC(2025, 11, 15)); // mid-December 2025
  const items = [
    { timestamp: "2025100100", views: 71721 },
    { timestamp: "2025110100", views: 58926 },
    { timestamp: "2025120100", views: 1282 }, // partial month -- dropped
  ];
  assert.equal(medianMonthlyViews(items, now), Math.round((71721 + 58926) / 2));
  assert.equal(medianMonthlyViews([{ timestamp: "2025120100", views: 9 }], now), null,
    "only a partial month means no signal");
  assert.equal(medianMonthlyViews([], now), null);
});

test("only the twelve most recent full months count", () => {
  const now = new Date(Date.UTC(2026, 0, 10));
  const items = Array.from({ length: 20 }, (_, index) => ({
    timestamp: `${2024 + Math.floor((index + 4) / 12)}${String(((index + 4) % 12) + 1).padStart(2, "0")}0100`,
    views: index < 8 ? 1_000_000 : 100, // the old spike must age out
  }));
  const median = medianMonthlyViews(items, now);
  assert.equal(median, 100, "a spike older than 12 months does not linger");
});

test("the blend ranks a legend above a journeyman and renormalizes without pageviews", () => {
  const legend = blendScore({ pvMedian: 67000, sitelinks: 60, hof: true, awardCount: 3, careerYears: 18 });
  const solid = blendScore({ pvMedian: 2500, sitelinks: 20, hof: false, awardCount: 1, careerYears: 12 });
  const obscure = blendScore({ pvMedian: null, sitelinks: 6, hof: false, awardCount: 0, careerYears: 4 });
  assert.ok(legend > 0.85, `legend ${legend}`);
  assert.ok(solid > obscure, `${solid} > ${obscure}`);
  assert.ok(obscure < 0.45, `obscure ${obscure}`);
  assert.ok(legend <= 1 && obscure >= 0);
});

test("titles resolve by QID, never by guessed name", () => {
  const query = titleQuery(["Q220677", "Q311977"]);
  assert.ok(query.includes("wd:Q220677 wd:Q311977"));
  assert.ok(query.includes("schema:isPartOf <https://en.wikipedia.org/>"));
});
