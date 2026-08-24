import assert from "node:assert/strict";
import test from "node:test";
import { inspectMagnet } from "../lib/magnet.ts";

const HASH = "0123456789ABCDEF0123456789ABCDEF01234567";
const magnet = (params = "") => `magnet:?xt=urn:btih:${HASH}${params}`;

test("rejects malformed and oversized magnets", () => {
  assert.match(inspectMagnet("https://example.com").error ?? "", /magnet:/i);
  assert.match(inspectMagnet("magnet:?dn=sans-hash").error ?? "", /Infohash/i);
  assert.match(inspectMagnet(`magnet:?xt=urn:btih:${HASH}${"x".repeat(4100)}`).error ?? "", /4 096/);
});

test("accepts a valid public-tracker link without claiming its content is safe", () => {
  const inspected = inspectMagnet(magnet("&dn=Film+libre&tr=https%3A%2F%2Ftracker.example%2Fannounce"));
  assert.equal(inspected.error, undefined);
  assert.equal(inspected.result?.verdict, "clean");
  assert.equal(inspected.result?.score, 68);
  assert.equal(inspected.result?.name, "Film libre");
});

test("flags private trackers, webseeds, paths and bidi controls", () => {
  const suspiciousName = encodeURIComponent("../dossier/film\u202Egnp.exe");
  const inspected = inspectMagnet(magnet(`&dn=${suspiciousName}&tr=http%3A%2F%2F127.0.0.1%2Fannounce&ws=http%3A%2F%2F192.168.1.2%2Ffile`));
  assert.equal(inspected.result?.verdict, "blocked");
  assert.ok(inspected.result?.reasons.some((reason) => /tracker invalide/i.test(reason)));
  assert.ok(inspected.result?.reasons.some((reason) => /Webseed/i.test(reason)));
  assert.ok(inspected.result?.reasons.some((reason) => /chemin|traversée/i.test(reason)));
  assert.ok(inspected.result?.reasons.some((reason) => /Unicode/i.test(reason)));
  assert.doesNotMatch(inspected.result?.name ?? "", /[\\/]|\u202e/iu);
});

test("blocks deceptive double extensions", () => {
  const inspected = inspectMagnet(magnet("&dn=document.pdf.exe&tr=udp%3A%2F%2Ftracker.example%3A1337"));
  assert.equal(inspected.result?.verdict, "blocked");
  assert.deepEqual(inspected.result?.files, []);
  assert.match(inspected.result?.reasons.join(" ") ?? "", /extension/i);
});

test("never invents file metadata before the local engine resolves it", () => {
  const inspected = inspectMagnet(magnet("&dn=Archive+libre&tr=https%3A%2F%2Ftracker.example%2Fannounce"));
  assert.deepEqual(inspected.result?.files, []);
});
