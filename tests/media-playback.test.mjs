import assert from "node:assert/strict";
import test from "node:test";
import { canResume, formatMediaTime, isLocalMediaUrl, MediaPlaybackSession, watchPercentage } from "../lib/media-playback.ts";

const episode = (index = 0) => ({ key: `1:${index}`, torrentId: 1, fileIndex: index, playable: true });
const access = (letter = "a") => ({ url: `secutorrent-media://stream/${letter.repeat(43)}`, mimeType: "video/mp4", expiresAt: "" });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function bridge() {
  return { calls: [], released: [], cancelled: [], openMedia(options) { this.calls.push(options); return Promise.resolve(access(String.fromCharCode(97 + options.fileIndex))); }, renewMedia: async () => ({ expiresAt: "" }), releaseMedia(url) { this.released.push(url); return Promise.resolve({ ok: true }); }, cancelMediaPreparation(requestId) { this.cancelled.push(requestId); return Promise.resolve({ ok: true }); } };
}

test("distinguer progression, reprise et fin réelle", () => {
  const record = { position: 99.99, duration: 100, completed: false, updatedAt: 1 };
  assert.equal(watchPercentage(record), 99);
  assert.equal(canResume(record), true);
  assert.equal(watchPercentage({ ...record, completed: true }), 100);
  assert.equal(canResume({ ...record, completed: true }), false);
  assert.equal(canResume({ ...record, position: 0 }), false);
  assert.equal(watchPercentage(), 0);
  assert.equal(watchPercentage({ ...record, duration: NaN }), 0);
  assert.equal(formatMediaTime(3725), "1:02:05");
  assert.equal(formatMediaTime(NaN), "0:00");
});

test("refuser les sources distantes et les jetons altérés", () => {
  assert.equal(isLocalMediaUrl(access().url), true);
  for (const value of ["https://example.test/stream", "file:///video", access().url + "?leak=1", access().url + "#fragment", "secutorrent-media://other/" + "a".repeat(43)]) assert.equal(isLocalMediaUrl(value), false);
});

test("réutiliser la préparation suivante même encore en cours", async () => {
  const api = bridge();
  const waiting = deferred();
  api.openMedia = (options) => { api.calls.push(options); return waiting.promise; };
  const session = new MediaPlaybackSession(api);
  const warming = session.prewarm(episode(1));
  const playing = session.take(episode(1));
  waiting.resolve(access("b"));
  assert.equal(await warming, true);
  assert.equal((await playing).url, access("b").url);
  assert.equal(api.calls.length, 1);
  session.dispose();
  assert.deepEqual(api.released, [access("b").url]);
});

test("révoquer le résultat d'une ouverture terminée après fermeture", async () => {
  const api = bridge();
  const waiting = deferred();
  api.openMedia = () => waiting.promise;
  const session = new MediaPlaybackSession(api);
  const pending = session.take(episode());
  session.dispose();
  waiting.resolve(access());
  await assert.rejects(pending, /fermé/);
  assert.deepEqual(api.released, [access().url]);
  assert.equal(api.cancelled.length, 1);
});

test("renouveler une préparation expirée au lieu de la lire", async () => {
  const api = bridge();
  const session = new MediaPlaybackSession(api);
  await session.prewarm(episode(1));
  api.renewMedia = async () => { throw new Error("expired"); };
  await session.take(episode(1));
  assert.equal(api.calls.length, 2);
  assert.equal(api.released.length, 1);
  session.dispose();
});

test("libérer une préparation remplacée sans couper la lecture courante", async () => {
  const api = bridge();
  const session = new MediaPlaybackSession(api);
  await session.take(episode());
  await session.prewarm(episode(1));
  await session.prewarm(episode(2));
  assert.deepEqual(api.released, [access("b").url]);
  await session.reopen(episode());
  assert.equal(api.released.includes(access("c").url), false);
  session.dispose();
});
