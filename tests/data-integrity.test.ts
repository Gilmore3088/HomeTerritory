import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import atlas from "../data/us-states.ts";

const adjacencyFile = JSON.parse(readFileSync(new URL("../data/adjacency.json", import.meta.url), "utf8")) as {
  adjacency: Record<string, string[]>;
};
const regionsFile = JSON.parse(readFileSync(new URL("../data/regions.json", import.meta.url), "utf8")) as {
  regions: Record<string, string[]>;
};

const STATE_COUNT = 50;
const states = Object.keys(atlas.paths).sort();

test("atlas has paths and centroids for all 50 states", () => {
  assert.equal(states.length, STATE_COUNT);
  for (const state of states) {
    assert.ok(atlas.paths[state].length > 0, `${state} has an empty path`);
    const centroid = atlas.centroids[state];
    assert.ok(Array.isArray(centroid) && centroid.length === 2, `${state} has no centroid`);
  }
});

test("adjacency covers all 50 states and is symmetric", () => {
  const adjacency = adjacencyFile.adjacency;
  assert.deepEqual(Object.keys(adjacency).sort(), states);
  for (const [state, neighbors] of Object.entries(adjacency)) {
    assert.ok(neighbors.length > 0, `${state} has no neighbors`);
    for (const neighbor of neighbors) {
      assert.ok(adjacency[neighbor], `${state} references unknown state ${neighbor}`);
      assert.ok(adjacency[neighbor].includes(state), `${state} -> ${neighbor} is not symmetric`);
      assert.notEqual(neighbor, state, `${state} is adjacent to itself`);
    }
  }
});

test("regions partition all 50 states with no overlap", () => {
  const assigned = Object.values(regionsFile.regions).flat().sort();
  assert.deepEqual(assigned, states, "every state belongs to exactly one region");
});
