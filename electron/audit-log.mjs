import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const ZERO_HASH = "0".repeat(64);
const MAX_STRING_LENGTH = 2_048;
const REDACTED_KEY = /(authorization|credential|magnet|metainfo|pass(?:word|key)?|secret|token|tracker|url)/i;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function sanitize(value, depth = 0) {
  if (depth > 6) return "[depth-limit]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_STRING_LENGTH);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitize(entry, depth + 1));
  if (!value || typeof value !== "object") return String(value).slice(0, MAX_STRING_LENGTH);

  const cleaned = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    cleaned[key] = REDACTED_KEY.test(key) ? "[redacted]" : sanitize(entry, depth + 1);
  }
  return cleaned;
}

async function atomicPrivateWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, filePath);
}

export class AuditIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditIntegrityError";
  }
}

export class AuditLog {
  #directory;
  #filePath;
  #keyPath;
  #key;
  #lastHash = ZERO_HASH;
  #sequence = 0;
  #writeQueue = Promise.resolve();

  constructor(directory) {
    this.#directory = path.resolve(directory);
    this.#filePath = path.join(this.#directory, "audit.jsonl");
    this.#keyPath = path.join(this.#directory, "audit.key");
  }

  async initialize() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    try {
      this.#key = await readFile(this.#keyPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#key = randomBytes(32);
      await atomicPrivateWrite(this.#keyPath, this.#key);
    }
    if (this.#key.length !== 32) throw new AuditIntegrityError("Clé d'audit invalide.");
    await this.#verifyExistingChain();
    return this;
  }

  #digest(recordWithoutHash) {
    return createHmac("sha256", this.#key)
      .update(recordWithoutHash.prevHash, "utf8")
      .update("\n", "utf8")
      .update(canonicalJson(recordWithoutHash), "utf8")
      .digest("hex");
  }

  async #verifyExistingChain() {
    try {
      await open(this.#filePath, "r").then((handle) => handle.close());
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    const input = createReadStream(this.#filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;

    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new AuditIntegrityError(`Journal d'audit illisible à la séquence ${expectedSequence}.`);
      }
      const { hash, ...unsigned } = record;
      const expectedHash = this.#digest(unsigned);
      const comparable = typeof hash === "string" && hash.length === expectedHash.length;
      if (
        record.seq !== expectedSequence ||
        record.prevHash !== previousHash ||
        !comparable ||
        !timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash))
      ) {
        throw new AuditIntegrityError(`Chaîne d'audit altérée à la séquence ${expectedSequence}.`);
      }
      previousHash = hash;
      expectedSequence += 1;
    }

    this.#sequence = expectedSequence - 1;
    this.#lastHash = previousHash;
  }

  append(event, details = {}, actor = "local-user") {
    const operation = async () => {
      const unsigned = {
        v: 1,
        seq: this.#sequence + 1,
        ts: new Date().toISOString(),
        event: String(event).slice(0, 120),
        actor: String(actor).slice(0, 120),
        details: sanitize(details),
        prevHash: this.#lastHash,
      };
      const record = { ...unsigned, hash: this.#digest(unsigned) };
      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.write(`${canonicalJson(record)}\n`, null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#sequence = record.seq;
      this.#lastHash = record.hash;
      return record;
    };

    const result = this.#writeQueue.then(operation, operation);
    this.#writeQueue = result.catch(() => undefined);
    return result;
  }

  async recent(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100));
    const records = [];
    try {
      const input = createReadStream(this.#filePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        records.push(record);
        if (records.length > safeLimit) records.shift();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return records.reverse();
  }
}
