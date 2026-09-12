import assert from "node:assert/strict";
import test from "node:test";
import { RefreshQueue } from "../lib/refresh-queue.ts";

test("regrouper les rafraîchissements et relire après une modification", async () => {
  const queue = new RefreshQueue();
  let calls = 0, active = 0, peak = 0, finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  const action = async () => { calls++; active++; peak = Math.max(peak, active); await wait; active--; };
  const first = queue.run(action);
  await Promise.resolve();
  assert.equal(queue.run(action), first);
  queue.run(action, true);
  queue.run(action, true);
  finish();
  await first;
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  await queue.run(action);
  assert.equal(calls, 3);
});

test("libérer la file après une erreur", async () => {
  const queue = new RefreshQueue();
  await assert.rejects(queue.run(async () => { throw new Error("indisponible"); }), /indisponible/);
  let calls = 0;
  await queue.run(async () => { calls++; });
  assert.equal(calls, 1);
});
