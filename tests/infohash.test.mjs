import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeInfohash,
  isCanonicalInfohash,
  normalizeInfohash,
} from "../electron/infohash.mjs";

const V1 = "a".repeat(40);
const V2 = "b".repeat(64);
const V2_MULTIHASH = `1220${V2}`;

test("les infohashs v1, v2 et multihash v2 partagent une forme canonique", () => {
  assert.equal(canonicalizeInfohash(V1.toUpperCase()), V1);
  assert.equal(canonicalizeInfohash(V2.toUpperCase()), V2);
  assert.equal(canonicalizeInfohash(V2_MULTIHASH.toUpperCase()), V2);
  assert.equal(isCanonicalInfohash(V1), true);
  assert.equal(isCanonicalInfohash(V2), true);
  assert.equal(isCanonicalInfohash(V2_MULTIHASH), false);
});

test("les préfixes multihash et longueurs non autorisés restent refusés", () => {
  assert.equal(canonicalizeInfohash(`1221${V2}`), null);
  assert.equal(canonicalizeInfohash(`1220${"c".repeat(62)}`), null);
  assert.equal(canonicalizeInfohash(` ${V1}`), null);
  assert.throws(() => normalizeInfohash("not-an-infohash"), /Infohash invalide/u);
});
