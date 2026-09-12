const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function discardBody(response) {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedResponse(response) {
  const tooLarge = () => new TransmissionRpcError("Réponse Transmission trop volumineuse.", "RESPONSE_TOO_LARGE");
  const declaredSize = response.headers.get("content-length");
  if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > MAX_RESPONSE_BYTES) {
    await discardBody(response);
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (error instanceof TransmissionRpcError) throw error;
    throw new TransmissionRpcError("Réponse Transmission interrompue ou expirée.", "UNAVAILABLE");
  } finally { reader.releaseLock(); }
}

export class TransmissionRpcError extends Error {
  constructor(message, code = "RPC_ERROR") {
    super(message);
    this.name = "TransmissionRpcError";
    this.code = code;
  }
}

export class TransmissionRpcClient {
  #endpoint;
  #authorization;
  #sessionId = null;
  #tag = 0;

  constructor({ port, username, password }) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port RPC invalide.");
    this.#endpoint = new URL(`http://127.0.0.1:${port}/transmission/rpc`);
    this.#authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }

  async call(method, args = {}, timeoutMs = 15_000) {
    if (!/^[a-z][a-z0-9_]{1,80}$/.test(method)) throw new TransmissionRpcError("Méthode RPC invalide.", "INVALID_METHOD");
    const requestId = ++this.#tag;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: args, id: requestId });
    const signal = AbortSignal.timeout(timeoutMs);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        response = await fetch(this.#endpoint, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: this.#authorization,
            "Content-Type": "application/json",
            ...(this.#sessionId ? { "X-Transmission-Session-Id": this.#sessionId } : {}),
          },
          body: payload,
        });
      } catch (error) {
        throw new TransmissionRpcError(`Moteur Transmission indisponible: ${error.message}`, "UNAVAILABLE");
      }

      if (response.status === 409) {
        const sessionId = response.headers.get("x-transmission-session-id");
        await discardBody(response);
        if (!sessionId || sessionId.length > 512) throw new TransmissionRpcError("Jeton de session Transmission absent.", "BAD_SESSION");
        this.#sessionId = sessionId;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new TransmissionRpcError("Authentification Transmission refusée.", "AUTH_FAILED");
      }
      if (!response.ok) {
        await discardBody(response);
        throw new TransmissionRpcError(`Transmission a répondu HTTP ${response.status}.`, "HTTP_ERROR");
      }

      const text = await readBoundedResponse(response);
      let decoded;
      try { decoded = JSON.parse(text); } catch { throw new TransmissionRpcError("Réponse Transmission invalide.", "INVALID_RESPONSE"); }
      if (decoded?.jsonrpc !== "2.0" || decoded?.id !== requestId) throw new TransmissionRpcError("Enveloppe JSON-RPC Transmission invalide.", "INVALID_RESPONSE");
      if (decoded.error) throw new TransmissionRpcError(`Transmission: ${String(decoded.error.message || "échec inconnu")}`, String(decoded.error.code || "REMOTE_ERROR"));
      if (!("result" in decoded)) throw new TransmissionRpcError("Résultat JSON-RPC Transmission absent.", "INVALID_RESPONSE");
      return decoded.result ?? {};
    }
    throw new TransmissionRpcError("Négociation de session Transmission impossible.", "BAD_SESSION");
  }

  async waitUntilReady({ timeoutMs = 15_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return await this.call("session_get", { fields: ["rpc_version_semver", "version"] }, 2_000);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    throw new TransmissionRpcError(`Démarrage Transmission expiré: ${lastError?.message || "aucune réponse"}`, "START_TIMEOUT");
  }
}
