import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { NETWORK_ENGINE_DIRECTORY } from "../electron/network-runtime.mjs";

const engine = path.resolve(".runtime", "engine", NETWORK_ENGINE_DIRECTORY, "PFiles", "Transmission");
const execute = promisify(execFile);
test("OpenSSL corrigé et libcurl négocient TLS et refusent un certificat non approuvé", { skip: process.platform !== "win32" || !existsSync(engine), timeout: 60_000 }, async t => {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "slyorrent-tls-"));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("slyorrent-tls-"));
    await rm(resolved, { recursive: true, force: true });
  });
  const generator = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git/usr/bin/openssl.exe");
  for (const name of ["server", "other"]) await execute(generator, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=Slyorrent ${name} test`, "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(root, `${name}.key`), "-out", path.join(root, `${name}.crt`)], { windowsHide: true, timeout: 15_000 });
  const server = createServer({ key: await readFile(path.join(root, "server.key")), cert: await readFile(path.join(root, "server.crt")), minVersion: "TLSv1.2" }, (_request, response) => response.writeHead(200).end());
  server.on("tlsClientError", () => undefined);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `https://127.0.0.1:${server.address().port}/`;
  const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  for (const [certificate, expected] of [["server.crt", 0], ["other.crt", 60]]) {
    const { stdout } = await execute(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/probe-engine-tls.ps1"), "-EngineDirectory", engine, "-Url", url, "-CaFile", path.join(root, certificate)], { windowsHide: true, timeout: 20_000 });
    const result = JSON.parse(stdout);
    assert.match(result.openssl, /^OpenSSL 3\.5\.9\b/u);
    assert.match(result.curl, /OpenSSL\/3\.5\.9\b/u);
    assert.match(result.curl, /^libcurl\/8\.23\.0\b/u);
    assert.equal(result.code, expected);
    if (expected === 0) assert.equal(result.status, 200);
  }
});
