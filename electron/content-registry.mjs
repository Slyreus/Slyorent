import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isCanonicalInfohash, normalizeInfohash } from "./infohash.mjs";

const SCHEMA_VERSION = 1;
const KEY_BYTES = 32;
const MAX_ENTRIES = 2_048;
const MAX_FILES_PER_ENTRY = 8_192;
const MAX_TOTAL_FILES = 65_536;
const MAX_PATH_LENGTH = 32_767;
const MAX_FILE_NAME_LENGTH = 4_096;
const MAX_STORE_BYTES = 32 * 1_024 * 1_024;
const MAX_FILE_INDEX = 2_147_483_647;
const HMAC_PATTERN = /^[a-f0-9]{64}$/u;
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObjectShape(value, requiredKeys, optionalKeys = [], label = "Objet") {
  if (!isPlainObject(value)) throw new TypeError(`${label} invalide.`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contient des champs invalides.`);
  }
}

function normalizeHash(value) {
  return normalizeInfohash(value);
}

function validateStoredHash(value) {
  if (!isCanonicalInfohash(value)) throw new TypeError("Infohash enregistré invalide.");
  return value;
}

function normalizeLocalPath(value, label, maximumLength = MAX_PATH_LENGTH) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || PATH_CONTROL_CHARACTERS.test(value)
  ) {
    throw new TypeError(`${label} invalide.`);
  }
  return value;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} invalide.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) throw new TypeError(`${label} invalide.`);
  return value;
}

function normalizeFileNumber(value, label, { integer = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${label} invalide.`);
  }
  return value;
}

function normalizeFile(file, { stored = false } = {}) {
  assertObjectShape(
    file,
    stored ? ["index", "name", "size", "mtimeMs", "filePath"] : ["index", "name", "size", "mtimeMs"],
    stored ? [] : ["filePath"],
    "Fichier",
  );
  const filePath = file.filePath === undefined || file.filePath === null
    ? null
    : normalizeLocalPath(file.filePath, "Chemin du fichier");
  return {
    index: normalizeFileNumber(file.index, "Index du fichier", { integer: true, maximum: MAX_FILE_INDEX }),
    name: normalizeLocalPath(file.name, "Nom du fichier", MAX_FILE_NAME_LENGTH),
    size: normalizeFileNumber(file.size, "Taille du fichier", { integer: true }),
    mtimeMs: normalizeFileNumber(file.mtimeMs, "Date de modification du fichier"),
    filePath,
  };
}

function normalizeFiles(files, { stored = false } = {}) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_ENTRY) {
    throw new TypeError("Liste de fichiers invalide.");
  }
  const normalized = files.map((file) => normalizeFile(file, { stored }));
  if (stored && normalized.some((file, index) => index > 0 && normalized[index - 1].index >= file.index)) {
    throw new TypeError("Ordre des fichiers enregistré invalide.");
  }
  if (!stored) normalized.sort((left, right) => left.index - right.index);
  const indexes = new Set();
  const names = new Set();
  for (const file of normalized) {
    if (indexes.has(file.index) || names.has(file.name)) throw new TypeError("Liste de fichiers ambiguë.");
    indexes.add(file.index);
    names.add(file.name);
  }
  return normalized;
}

function normalizePlan(plan, { stored = false } = {}) {
  if (plan === null) return null;
  assertObjectShape(plan, ["libraryRoot", "createSubfolder", "updatedAt"], [], "Destination");
  if (typeof plan.createSubfolder !== "boolean") throw new TypeError("Choix du sous-dossier invalide.");
  return {
    libraryRoot: normalizeLocalPath(plan.libraryRoot, "Répertoire de destination"),
    createSubfolder: plan.createSubfolder,
    updatedAt: stored ? normalizeTimestamp(plan.updatedAt, "Date de destination") : plan.updatedAt,
  };
}

function normalizeSafeRecord(safe, { stored = false } = {}) {
  if (safe === null) return null;
  assertObjectShape(safe, ["finalDirectory", "validatedAt", "files"], [], "Validation");
  return {
    finalDirectory: normalizeLocalPath(safe.finalDirectory, "Répertoire final"),
    validatedAt: stored ? normalizeTimestamp(safe.validatedAt, "Date de validation") : safe.validatedAt,
    files: normalizeFiles(safe.files, { stored }),
  };
}

function normalizeStoredEntry(entry) {
  assertObjectShape(entry, ["hash", "plan", "safe"], [], "Entrée");
  return {
    hash: validateStoredHash(entry.hash),
    plan: normalizePlan(entry.plan, { stored: true }),
    safe: normalizeSafeRecord(entry.safe, { stored: true }),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function countFiles(entries) {
  return entries.reduce((total, entry) => total + (entry.safe?.files.length || 0), 0);
}

function validateStoredDocument(document) {
  assertObjectShape(document, ["schemaVersion", "revision", "entries", "hmac"], [], "Registre");
  if (document.schemaVersion !== SCHEMA_VERSION) throw new TypeError("Version de registre incompatible.");
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) throw new TypeError("Révision de registre invalide.");
  if (!Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES) throw new TypeError("Nombre d'entrées invalide.");
  if (typeof document.hmac !== "string" || !HMAC_PATTERN.test(document.hmac)) throw new TypeError("Signature de registre invalide.");

  const entries = document.entries.map(normalizeStoredEntry);
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].hash !== document.entries[index].hash) throw new TypeError("Entrée de registre non canonique.");
    if (index > 0 && entries[index - 1].hash >= entries[index].hash) throw new TypeError("Ordre des entrées invalide.");
  }
  if (countFiles(entries) > MAX_TOTAL_FILES) throw new TypeError("Nombre total de fichiers invalide.");
  return {
    unsigned: { schemaVersion: SCHEMA_VERSION, revision: document.revision, entries },
    hmac: document.hmac,
  };
}

async function fileInfo(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("NOT_REGULAR_FILE");
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function createPrivateKey(filePath, contents) {
  let handle;
  let created = false;
  try {
    handle = await open(filePath, "wx", 0o600);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicPrivateWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ContentRegistryIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ContentRegistryIntegrityError";
    this.code = "CONTENT_REGISTRY_INTEGRITY";
  }
}

export class ContentRegistry {
  #directory;
  #filePath;
  #keyPath;
  #clock;
  #key;
  #revision = 0;
  #records = new Map();
  #operationQueue = Promise.resolve();
  #initialized = false;

  constructor(directoryOrOptions) {
    const options = typeof directoryOrOptions === "string"
      ? { directory: directoryOrOptions }
      : directoryOrOptions;
    assertObjectShape(options, ["directory"], ["clock"], "Configuration du registre");
    if (typeof options.directory !== "string" || options.directory.length === 0) {
      throw new TypeError("Répertoire du registre invalide.");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") throw new TypeError("Horloge du registre invalide.");
    this.#directory = path.resolve(options.directory);
    this.#filePath = path.join(this.#directory, "content-registry.json");
    this.#keyPath = path.join(this.#directory, "content-registry.key");
    this.#clock = options.clock || (() => new Date());
  }

  async initialize() {
    if (this.#initialized) return this;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });

    try {
      const [storedInfo, keyInfo] = await Promise.all([fileInfo(this.#filePath), fileInfo(this.#keyPath)]);
      if (storedInfo && !keyInfo) throw new ContentRegistryIntegrityError("Clé du registre absente.");
      if (storedInfo && storedInfo.size > MAX_STORE_BYTES) throw new ContentRegistryIntegrityError("Registre trop volumineux.");
      if (keyInfo && keyInfo.size !== KEY_BYTES) throw new ContentRegistryIntegrityError("Clé du registre invalide.");

      if (!keyInfo) {
        const generatedKey = randomBytes(KEY_BYTES);
        try {
          await createPrivateKey(this.#keyPath, generatedKey);
          this.#key = generatedKey;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          this.#key = await readFile(this.#keyPath);
        }
      } else {
        this.#key = await readFile(this.#keyPath);
      }
      if (this.#key.length !== KEY_BYTES) throw new ContentRegistryIntegrityError("Clé du registre invalide.");

      if (storedInfo) {
        let parsed;
        try {
          parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
        } catch (error) {
          throw new ContentRegistryIntegrityError("Registre illisible.", { cause: error });
        }
        let validated;
        try {
          validated = validateStoredDocument(parsed);
        } catch (error) {
          throw new ContentRegistryIntegrityError("Schéma du registre invalide.", { cause: error });
        }
        const expected = this.#digest(validated.unsigned);
        const authentic = timingSafeEqual(Buffer.from(validated.hmac, "hex"), Buffer.from(expected, "hex"));
        if (!authentic) throw new ContentRegistryIntegrityError("Registre altéré.");
        this.#revision = validated.unsigned.revision;
        this.#records = new Map(validated.unsigned.entries.map((entry) => [entry.hash, entry]));
      }
    } catch (error) {
      this.#key = undefined;
      this.#records = new Map();
      this.#revision = 0;
      if (error instanceof ContentRegistryIntegrityError) throw error;
      throw new ContentRegistryIntegrityError("Initialisation sécurisée du registre impossible.", { cause: error });
    }

    this.#initialized = true;
    return this;
  }

  #digest(unsigned) {
    return createHmac("sha256", this.#key).update(canonicalJson(unsigned), "utf8").digest("hex");
  }

  #assertInitialized() {
    if (!this.#initialized) throw new Error("Le registre de contenu n'est pas initialisé.");
  }

  #timestamp() {
    const value = this.#clock();
    const timestamp = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw new Error("Horodatage du registre invalide.");
    return timestamp.toISOString();
  }

  #serialize(operation) {
    const run = this.#operationQueue.then(operation, operation);
    this.#operationQueue = run.catch(() => undefined);
    return run;
  }

  async #commit(records) {
    if (records.size > MAX_ENTRIES) throw new RangeError("Le registre a atteint sa capacité maximale.");
    const entries = [...records.values()].sort((left, right) => left.hash.localeCompare(right.hash));
    if (countFiles(entries) > MAX_TOTAL_FILES) throw new RangeError("Le registre contient trop de fichiers.");
    if (this.#revision >= Number.MAX_SAFE_INTEGER) throw new RangeError("Le registre a atteint sa révision maximale.");
    const unsigned = { schemaVersion: SCHEMA_VERSION, revision: this.#revision + 1, entries };
    const document = { ...unsigned, hmac: this.#digest(unsigned) };
    const serialized = `${canonicalJson(document)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) throw new RangeError("Le registre est trop volumineux.");
    await atomicPrivateWrite(this.#filePath, serialized);
    this.#records = records;
    this.#revision = unsigned.revision;
  }

  upsertPlan(input) {
    return this.#serialize(async () => {
      this.#assertInitialized();
      assertObjectShape(input, ["hash", "libraryRoot", "createSubfolder"], [], "Destination");
      const hash = normalizeHash(input.hash);
      const libraryRoot = normalizeLocalPath(input.libraryRoot, "Répertoire de destination");
      if (typeof input.createSubfolder !== "boolean") throw new TypeError("Choix du sous-dossier invalide.");
      const previous = this.#records.get(hash);
      const unchanged = previous?.plan?.libraryRoot === libraryRoot
        && previous.plan.createSubfolder === input.createSubfolder;
      const entry = unchanged
        ? previous
        : {
            hash,
            plan: { libraryRoot, createSubfolder: input.createSubfolder, updatedAt: this.#timestamp() },
            safe: null,
          };
      if (unchanged) return clone(entry);
      const records = new Map(this.#records);
      records.set(hash, entry);
      await this.#commit(records);
      return clone(entry);
    });
  }

  markSafe(input) {
    return this.#serialize(async () => {
      this.#assertInitialized();
      assertObjectShape(input, ["hash", "finalDirectory", "files"], [], "Validation");
      const hash = normalizeHash(input.hash);
      const previous = this.#records.get(hash);
      const entry = {
        hash,
        plan: previous?.plan || null,
        safe: {
          finalDirectory: normalizeLocalPath(input.finalDirectory, "Répertoire final"),
          validatedAt: this.#timestamp(),
          files: normalizeFiles(input.files),
        },
      };
      const records = new Map(this.#records);
      records.set(hash, entry);
      await this.#commit(records);
      return clone(entry);
    });
  }

  get(hash) {
    this.#assertInitialized();
    const entry = this.#records.get(normalizeHash(hash));
    return entry ? clone(entry) : null;
  }

  entries() {
    this.#assertInitialized();
    return [...this.#records.values()]
      .sort((left, right) => left.hash.localeCompare(right.hash))
      .map(clone);
  }

  invalidate(hash) {
    return this.#serialize(async () => {
      this.#assertInitialized();
      const normalized = normalizeHash(hash);
      const previous = this.#records.get(normalized);
      if (!previous?.safe) return false;
      const records = new Map(this.#records);
      records.set(normalized, { ...previous, safe: null });
      await this.#commit(records);
      return true;
    });
  }

  remove(hash) {
    return this.#serialize(async () => {
      this.#assertInitialized();
      const normalized = normalizeHash(hash);
      if (!this.#records.has(normalized)) return false;
      const records = new Map(this.#records);
      records.delete(normalized);
      await this.#commit(records);
      return true;
    });
  }
}
