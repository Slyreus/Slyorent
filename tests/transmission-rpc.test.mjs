import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { TransmissionRpcClient, TransmissionRpcError } from "../electron/transmission-rpc.mjs";

async function listenOnLoopback(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return { server, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("Transmission RPC négocie le jeton 409 puis envoie une enveloppe JSON-RPC 2.0", async (t) => {
  const requests = [];
  const { server, port } = await listenOnLoopback(async (request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      sessionId: request.headers["x-transmission-session-id"],
      body: JSON.parse(await requestBody(request)),
    });

    if (requests.length === 1) {
      response.writeHead(409, { "X-Transmission-Session-Id": "session-test-123" });
      response.end();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: requests.at(-1).body.id,
      result: { version: "4.1.3", rpc_version_semver: "6.0.0" },
    }));
  });
  t.after(() => closeServer(server));

  const client = new TransmissionRpcClient({ port, username: "local-user", password: "local-secret" });
  const result = await client.call("session_get", { fields: ["version"] });

  assert.deepEqual(result, { version: "4.1.3", rpc_version_semver: "6.0.0" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].authorization, `Basic ${Buffer.from("local-user:local-secret").toString("base64")}`);
  assert.equal(requests[0].sessionId, undefined);
  assert.equal(requests[1].sessionId, "session-test-123");
  assert.deepEqual(requests[1].body, {
    jsonrpc: "2.0",
    method: "session_get",
    params: { fields: ["version"] },
    id: 1,
  });
});

test("Transmission RPC refuse deux négociations 409 consécutives", async (t) => {
  const { server, port } = await listenOnLoopback((_request, response) => {
    response.writeHead(409, { "X-Transmission-Session-Id": "toujours-invalide" });
    response.end();
  });
  t.after(() => closeServer(server));

  const client = new TransmissionRpcClient({ port, username: "u", password: "p" });
  await assert.rejects(
    client.call("session_get"),
    (error) => error instanceof TransmissionRpcError && error.code === "BAD_SESSION",
  );
});

test("Transmission RPC refuse une réponse dont l'identifiant ne correspond pas", async (t) => {
  const { server, port } = await listenOnLoopback(async (request, response) => {
    await requestBody(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
  });
  t.after(() => closeServer(server));

  const client = new TransmissionRpcClient({ port, username: "u", password: "p" });
  await assert.rejects(
    client.call("torrent_get"),
    (error) => error instanceof TransmissionRpcError && error.code === "INVALID_RESPONSE",
  );
});
