import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttackTerritory,
  normalizeAnswer,
  refreshedActions,
  requiredCorrectForSteal,
  tierForSteal,
} from "../lib/game-rules.ts";

test("steal requirements scale by hold level", () => {
  assert.equal(requiredCorrectForSteal(1, false), 2);
  assert.equal(requiredCorrectForSteal(2, false), 3);
  assert.equal(requiredCorrectForSteal(3, false), 3);
  assert.equal(tierForSteal(3), 3);
});

test("underdog discount never drops below one", () => {
  assert.equal(requiredCorrectForSteal(1, true), 1);
  assert.equal(requiredCorrectForSteal(2, true), 2);
});

test("answers normalize punctuation and case", () => {
  assert.equal(normalizeAnswer("  Ohio-State!! "), "ohio state");
  assert.equal(normalizeAnswer("José Altuve"), "jose altuve");
});

test("adjacency is required after a player owns territory", () => {
  const adjacency = { WA: ["OR", "ID"], OR: ["WA", "ID", "CA"] };
  assert.equal(
    canAttackTerritory({ targetId: "OR", ownedTerritoryIds: ["WA"], adjacencyByTerritory: adjacency }),
    true,
  );
  assert.equal(
    canAttackTerritory({ targetId: "TX", ownedTerritoryIds: ["WA"], adjacencyByTerritory: adjacency }),
    false,
  );
  assert.equal(
    canAttackTerritory({ targetId: "TX", ownedTerritoryIds: [], adjacencyByTerritory: adjacency }),
    true,
  );
});

test("actions replenish by three per elapsed day with a cap of five", () => {
  assert.equal(refreshedActions({ currentActions: 0, elapsedDays: 1 }), 3);
  assert.equal(refreshedActions({ currentActions: 4, elapsedDays: 2 }), 5);
});

test("refreshedActions ignores negative elapsed days and respects the cap", () => {
  assert.equal(refreshedActions({ currentActions: 2, elapsedDays: -3 }), 2);
  assert.equal(refreshedActions({ currentActions: 5, elapsedDays: 0 }), 5);
  assert.equal(refreshedActions({ currentActions: 0, elapsedDays: 100 }), 5);
});

test("normalizeAnswer flattens whitespace runs and strips symbols", () => {
  assert.equal(normalizeAnswer("  L.A.\tLakers \n"), "l a lakers");
  assert.equal(normalizeAnswer("49ers!"), "49ers");
  assert.equal(normalizeAnswer(""), "");
});

test("canAttackTerritory treats missing adjacency entries as no border", () => {
  assert.equal(
    canAttackTerritory({ targetId: "HI", ownedTerritoryIds: ["CA"], adjacencyByTerritory: {} }),
    false,
  );
});
