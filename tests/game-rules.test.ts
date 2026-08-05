import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttackTerritory,
  isTerritoryActionBlocked,
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

// Finding 4: fortify spends one of the day's moves (game_begin_action charges it
// alongside claim and attack), but the sheet only disabled the button for claim
// and attack, so the fortify button stayed enabled at zero moves and threw.
test("fortify is blocked at zero moves, like claim and attack", () => {
  const own = { contested: false, sharesBorder: false, actionsRemaining: 0 };
  assert.equal(isTerritoryActionBlocked({ kind: "fortify", ...own }), true);
  assert.equal(isTerritoryActionBlocked({ kind: "claim", ...own, sharesBorder: true }), true);
  assert.equal(isTerritoryActionBlocked({ kind: "attack", ...own, sharesBorder: true }), true);
});

// A player's own state is not necessarily adjacent to another of their states,
// so the border rule must not be applied to fortify.
test("fortify does not require a shared border, but claim and attack do", () => {
  assert.equal(
    isTerritoryActionBlocked({ kind: "fortify", contested: false, sharesBorder: false, actionsRemaining: 1 }),
    false,
  );
  assert.equal(
    isTerritoryActionBlocked({ kind: "claim", contested: false, sharesBorder: false, actionsRemaining: 3 }),
    true,
  );
});

test("a contested state blocks every action, and defense never spends a move", () => {
  assert.equal(
    isTerritoryActionBlocked({ kind: "defend", contested: true, sharesBorder: false, actionsRemaining: 3 }),
    true,
  );
  assert.equal(
    isTerritoryActionBlocked({ kind: "defend", contested: false, sharesBorder: false, actionsRemaining: 0 }),
    false,
  );
  assert.equal(
    isTerritoryActionBlocked({ kind: "home", contested: false, sharesBorder: false, actionsRemaining: 0 }),
    false,
  );
});

test("off-turn players are blocked from move-spending actions but never from defending", () => {
  const base = { contested: false, sharesBorder: true, actionsRemaining: 3 };
  assert.equal(isTerritoryActionBlocked({ kind: "claim", ...base, isMyTurn: false }), true);
  assert.equal(isTerritoryActionBlocked({ kind: "attack", ...base, isMyTurn: false }), true);
  assert.equal(isTerritoryActionBlocked({ kind: "fortify", ...base, isMyTurn: false }), true);
  assert.equal(isTerritoryActionBlocked({ kind: "defend", ...base, isMyTurn: false }), false);
  assert.equal(isTerritoryActionBlocked({ kind: "claim", ...base, isMyTurn: true }), false);
  // Omitting the flag (non-test leagues) keeps the old behavior.
  assert.equal(isTerritoryActionBlocked({ kind: "claim", ...base }), false);
});
