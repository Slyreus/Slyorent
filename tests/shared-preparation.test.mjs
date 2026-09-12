import assert from "node:assert/strict";
import test from "node:test";
import { SharedPreparations } from "../electron/shared-preparation.mjs";

test("diffuser la progression à chaque lecteur et arrêter les notifications après annulation", async () => {
  const jobs = new SharedPreparations(); const controller = new AbortController();
  const first = [], second = []; let report, done;
  const prepare = (_signal, notify) => { report = notify; return new Promise((resolve) => { done = resolve; }); };
  const left = jobs.run("film", controller.signal, prepare, (value) => first.push(value));
  await Promise.resolve(); report(20);
  const right = jobs.run("film", undefined, prepare, (value) => second.push(value));
  const cancelled = assert.rejects(left, { name: "AbortError" }); controller.abort(); await cancelled;
  report(80); done("ok"); await right;
  assert.deepEqual(first, [20]); assert.deepEqual(second, [20, 80]);
});

test("conserver la conversion tant qu'un lecteur l'attend", async () => {
  const jobs = new SharedPreparations();
  const first = new AbortController();
  let resolve;
  let sharedSignal;
  let calls = 0;
  const prepare = (signal) => { calls++; sharedSignal = signal; return new Promise((done) => { resolve = done; }); };
  const left = jobs.run("film", first.signal, prepare);
  const right = jobs.run("film", undefined, prepare);
  await Promise.resolve();
  const cancelled = assert.rejects(left, { name: "AbortError" });
  first.abort();
  await cancelled;
  assert.equal(sharedSignal.aborted, false);
  resolve("ready");
  assert.equal(await right, "ready");
  assert.equal(calls, 1);
});

test("arrêter le travail après le dernier départ et permettre une nouvelle demande", async () => {
  const jobs = new SharedPreparations();
  const controller = new AbortController();
  let signal;
  const first = jobs.run("film", controller.signal, (value) => {
    signal = value;
    return new Promise((_resolve, reject) => value.addEventListener("abort", () => reject(value.reason), { once: true }));
  });
  await Promise.resolve();
  const cancelled = assert.rejects(first, { name: "AbortError" });
  controller.abort();
  await cancelled;
  assert.equal(signal.aborted, true);
  assert.equal(await jobs.run("film", undefined, async () => "new"), "new");
});

test("ne pas démarrer un travail déjà annulé", () => {
  const jobs = new SharedPreparations();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => jobs.run("film", controller.signal, () => { throw new Error("Ne doit pas démarrer"); }), { name: "AbortError" });
});
