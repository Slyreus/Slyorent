import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { CastGateway } from "../electron/cast-gateway.mjs";
import { CastService, castQueue } from "../electron/cast-service.mjs";
import { castDeviceId, castNetworks, dnsRecords, localDeviceUrl, privateAddress, rendererDescription, sameNetwork } from "../electron/cast-network.mjs";
import { decodeCastMessage, encodeCastMessage, googleCastMediaStatus } from "../electron/cast-clients.mjs";
import { analyzeProbe, conversionVideoArgs } from "../electron/media-profile.mjs";

test("borner le réseau, les descriptions et les messages Cast", () => {
  const network = { address: "192.168.1.10", netmask: "255.255.255.0" };
  assert.equal(sameNetwork("192.168.1.20", network), true);
  for (const ip of ["127.0.0.1", "8.8.8.8", "169.254.1.1", "192.168.2.20", "192.168.1.255"]) assert.equal(sameNetwork(ip, network), false);
  assert.equal(privateAddress("172.20.1.2"), true);
  const locationAddress = "http://192.168.1.20:1400/description";
  const location = new URL(locationAddress);
  for (const url of ["http://example.test/", "http://127.0.0.1/", "http://192.168.1.20:445/", "http://192.168.1.21/", "file:///video"]) assert.throws(() => localDeviceUrl(url, location.hostname, network));
  const xml = '<root><friendlyName>Salon &amp; TV</friendlyName><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service></root>';
  assert.equal(rendererDescription(xml, location, network).name, "Salon & TV");
  assert.throws(() => rendererDescription(`<!DOCTYPE test>${xml}`, location, network));
  assert.throws(() => rendererDescription(xml.replace("/control", "http://127.0.0.1/control"), location, network));
  assert.deepEqual(dnsRecords(Buffer.alloc(9001)), []);
  const frame = encodeCastMessage("urn:test", "receiver-0", { type: "LOAD", requestId: 1 });
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  assert.deepEqual(decodeCastMessage(frame.subarray(4)).payload, { type: "LOAD", requestId: 1 });
  assert.throws(() => decodeCastMessage(Buffer.from([50, 255, 255, 255, 255, 255])));
  assert.throws(() => castQueue([{ id: 1, fileIndex: 0 }, { id: 1, fileIndex: 0 }]));
  assert.equal(castDeviceId("chromecast", "192.168.1.20", { id: "home" }), castDeviceId("chromecast", "192.168.1.20", { id: "home" }));
  assert.notEqual(castDeviceId("chromecast", "192.168.1.20", { id: "home" }), castDeviceId("dlna", "192.168.1.20", { id: "home" }));
  const awaiting = googleCastMediaStatus({ playerState: "IDLE" });
  assert.equal(awaiting.stopped, false); assert.equal(awaiting.awaitingMedia, true);
  assert.equal(googleCastMediaStatus({ playerState: "IDLE", idleReason: "FINISHED" }).ended, true);
  assert.equal(googleCastMediaStatus({ playerState: "PLAYING", volume: { level: .4 } }).volume, .4);
  assert.throws(() => googleCastMediaStatus({ playerState: "IDLE", idleReason: "ERROR" }), { code: "CAST_MEDIA_ERROR" });
  const analysis = analyzeProbe({ format: { duration: 60 }, streams: [{ index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 }] }, { cast: true });
  assert.equal(analysis.videoAdapted, true); assert.ok(conversionVideoArgs(analysis, "libx264", 2).includes("4.1"));
});

const send = (url, { headers = {}, method = "GET", body } = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method, headers }, (response) => { const chunks = []; response.on("data", (data) => chunks.push(data)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })); }); request.on("error", reject); request.end(body);
});
test("apparier un écran et limiter le relais aux capacités du lecteur", async (t) => {
  const network = castNetworks()[0]; if (!network) { t.skip("Aucune interface LAN privée"); return; }
  let released = false, calls = 0;
  const vault = { renew: async (_url, owner) => { assert.equal(owner, 7); if (released) throw new Error("Révoqué"); }, handle: async (request) => { calls++; assert.equal(request.webContentsId, 7); assert.equal(request.headers.get("range"), "bytes=0-2"); return new Response("abc", { status: 206, headers: { "Content-Range": "bytes 0-2/10", "Content-Type": "video/mp4" } }); } };
  const gateway = new CastGateway({ network, vault, owner: 7, state: () => ({ epoch: "test" }), report: () => undefined });
  try {
    await gateway.start(); const origin = new URL(gateway.receiverUrl).origin;
    const media = gateway.addMedia({ url: `secutorrent-media://stream/${"a".repeat(43)}` }, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nBonjour\n");
    assert.equal((await send(gateway.receiverUrl)).status, 200);
    assert.equal((await send(media.url)).status, 404);
    assert.equal((await send(gateway.receiverUrl, { headers: { Host: "evil.test" } })).status, 403);
    const pair = await send(`${origin}/api/pair`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: gateway.code }) });
    assert.equal(pair.status, 200); const token = JSON.parse(pair.body).token;
    assert.equal((await send(`${origin}/api/state`, { method: "POST", headers: { Origin: "http://evil.test", Authorization: `Bearer ${token}` }, body: "{}" })).status, 403);
    assert.equal((await send(`${origin}/api/state`, { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}` }, body: "{}" })).status, 200);
    assert.equal((await send(media.url, { headers: { Range: "bytes=0-2" } })).body, "abc"); assert.equal(calls, 1);
    assert.deepEqual(gateway.delivery(media.resourceId), { requests: 1, accepted: 1, lastStatus: 206 });
    assert.equal((await send(media.subtitleUrl)).headers["content-type"], "text/vtt; charset=utf-8");
    released = true; assert.equal((await send(media.url)).status, 400);
  } finally { await gateway.close(); }
  await assert.rejects(send(gateway.receiverUrl));
});

test("conserver l’épisode et le motif après un arrêt de la TV", async () => {
  for (const idleReason of ["ERROR", "CANCELLED"]) {
    const network = { id: "home", address: "192.168.1.10", netmask: "255.255.255.0" }, events = [];
    let releaseClose;
    const closing = new Promise(resolve => { releaseClose = resolve; });
    const queue = [{ id: 1, fileIndex: 0, title: "Épisode 1" }];
    const service = new CastService({
      networks: () => [network], discover: async () => [{ id: "tv", kind: "chromecast", name: "TV de test", network, seenAt: Date.now() }],
      gateway: () => ({ start: async () => undefined, addMedia: () => ({ url: "local-media", resourceId: "token" }), delivery: () => ({ requests: 0, accepted: 0, lastStatus: null }), remove: () => undefined, close: () => closing }),
      client: () => ({ connect: async () => undefined, load: async () => googleCastMediaStatus({ playerState: "IDLE", idleReason }), stop: async () => undefined }),
      service: { mediaPreparation: () => null, cancelMediaPreparation: () => undefined, mediaReference: async ({ fileIndex }) => ({ hash: "a".repeat(40), fileIndex }), openMedia: async () => ({ url: "local-capability", duration: 20, mimeType: "video/mp4", audioTracks: [], subtitleTracks: [] }) },
      vault: { release: () => undefined, renew: async () => undefined },
      history: { update: async (_hash, _index, record) => record }, audit: { append: async (event, details) => { events.push({ event, details }); } },
    });
    try {
      await service.discover();
      await service.start({ deviceId: "tv", queue, index: 0, position: 8, autoNext: false }, 7);
      await until(() => service.status(7).active === false);
      const failed = service.status(7);
      assert.equal(failed.item.title, "Épisode 1"); assert.deepEqual(failed.queue, queue);
      assert.equal(failed.position, 8); assert.equal(failed.deviceName, "TV de test"); assert.equal(failed.loading, false);
      assert.ok(failed.error); assert.equal(service.status(8).item, undefined);
      if (idleReason === "ERROR") assert.match(failed.error, /Aucune demande vidéo/u);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(service.status(7).error, failed.error, "Le suivi disparaît pendant la fermeture du relais");
      releaseClose();
      await until(() => events.some(item => item.event === "cast.failed"));
      assert.equal(events.find(item => item.event === "cast.stopped").details.reason, idleReason === "ERROR" ? "CAST_MEDIA_ERROR" : "CAST_REMOTE_STOPPED");
      await service.control({ action: "stop" }, 7);
      assert.deepEqual(service.status(7), { active: false });
    } finally { releaseClose(); await service.close(); }
  }
});

const until = async (check) => { const start = Date.now(); while (!check()) { if (Date.now() - start > 3000) throw new Error("Session non prête"); await new Promise((resolve) => setTimeout(resolve, 5)); } };
test("attendre le lecteur distant et suivre les commandes et la file", async () => {
  const network = { id: "home", address: "192.168.1.10", netmask: "255.255.255.0" }, commands = [], loads = [];
  let releaseLoad, releasePoll;
  const pending = new Promise(resolve => { releaseLoad = resolve; });
  const queue = Array.from({ length: 3 }, (_, fileIndex) => ({ id: 1, fileIndex, title: `Épisode ${fileIndex + 1}` }));
  const service = new CastService({
    networks: () => [network], discover: async () => [{ id: "tv", kind: "chromecast", name: "TV de test", network, seenAt: Date.now() }],
    gateway: () => ({ start: async () => undefined, addMedia: () => ({ url: "local-media", resourceId: "token" }), remove: () => undefined, close: async () => undefined }),
    client: () => ({ connect: async () => undefined, load: async (media, position) => { loads.push(media.title); if (loads.length === 1) await pending; return { playing: true, position, duration: 20 }; }, command: async (action, value) => { commands.push({ action, value }); }, status: () => new Promise(resolve => { releasePoll = resolve; }), stop: async () => undefined }),
    service: { mediaPreparation: () => null, cancelMediaPreparation: () => undefined, mediaReference: async ({ fileIndex }) => ({ hash: "a".repeat(40), fileIndex }), openMedia: async ({ fileIndex }) => ({ url: String(fileIndex), duration: 20, mimeType: "video/mp4", audioTracks: [], subtitleTracks: [] }) },
    vault: { release: () => undefined, renew: async () => undefined }, history: { update: async (_hash, _index, record) => record }, audit: { append: async () => undefined },
  });
  await service.discover();
  try {
    await service.start({ deviceId: "tv", queue, index: 1, position: 3, autoNext: false, subtitleTrack: null }, 7);
    await until(() => service.status(7).phase === "loading");
    assert.equal(service.status(7).loading, true); assert.equal(service.status(7).playing, false);
    assert.deepEqual(service.status(7).queue, queue); assert.equal(service.status(8).queue, undefined);
    await assert.rejects(service.control({ action: "play" }, 7), /préparation/u);
    releaseLoad(); await until(() => !service.status(7).loading);
    assert.equal(service.status(7).playing, true); assert.equal(service.status(7).position, 3);
    await service.control({ action: "pause" }, 7); assert.equal(service.status(7).playing, false);
    await service.control({ action: "volume", value: .25 }, 7); assert.equal(service.status(7).volume, .25);
    await assert.rejects(service.control({ action: "volume", value: 2 }, 7));
    await assert.rejects(service.control({ action: "episode", value: 1.5 }, 7));
    await assert.rejects(service.control({ action: "episode", value: 3 }, 7));
    await assert.rejects(service.control({ action: "episode", value: 0 }, 8));
    await service.control({ action: "episode", value: 2 }, 7);
    await until(() => service.status(7).index === 2 && !service.status(7).loading);
    assert.equal(service.status(7).item.title, "Épisode 3"); assert.equal(service.status(7).position, 0);
    assert.deepEqual(loads, ["Épisode 2", "Épisode 3"]); assert.ok(commands.some(command => command.action === "pause"));
    await until(() => Boolean(releasePoll));
    await service.control({ action: "pause" }, 7);
    releasePoll({ playing: true, position: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.status(7).playing, false, "Un ancien état de l’appareil annule la pause");
  } finally { releaseLoad(); releasePoll?.({ playing: false, position: 0 }); await service.close(); }
});
test("enchaîner une seule fois, conserver le suivi et fermer la session", async () => {
  const network = { id: "home", address: "192.168.1.10", netmask: "255.255.255.0" };
  const records = [], accesses = [], revoked = []; let receiver, closed = false;
  const service = new CastService({
    networks: () => [network], discover: async () => [],
    gateway: (options) => { receiver = options; return { code: undefined, paired: true, receiverUrl: "local", start: async () => undefined, addMedia: () => ({ url: "local-media", resourceId: "token" }), remove: () => undefined, close: async () => { closed = true; } }; },
    service: { mediaPreparation: () => null, cancelMediaPreparation: () => undefined, mediaReference: async ({ fileIndex }) => ({ hash: "a".repeat(40), fileIndex }), openMedia: async (options) => { assert.equal(options.purpose, "cast"); accesses.push(options.fileIndex); return { url: String(options.fileIndex), duration: 20, mimeType: "video/mp4", audioTracks: [], subtitleTracks: [] }; } },
    vault: { release: (url) => revoked.push(url), renew: async () => undefined },
    history: { update: async (_hash, fileIndex, values) => { records.push({ fileIndex, ...values }); return { ...values, updatedAt: Date.now(), key: `a:${fileIndex}` }; } }, audit: { append: async () => undefined },
  });
  await service.discover();
  await service.start({ kind: "browser", networkId: "home", queue: [{ id: 1, fileIndex: 0, title: "Épisode 1" }, { id: 1, fileIndex: 1, title: "Épisode 2" }], index: 0, position: 8, autoNext: true, subtitleTrack: null }, 7);
  try {
    await until(() => !service.status(7).loading); assert.equal(service.status(7).position, 8);
    assert.equal(service.status(8).active, false);
    const state = receiver.state();
    const ended = { epoch: state.epoch, version: state.version, playing: false, ended: true, position: 20 };
    receiver.report(ended); receiver.report(ended);
    await until(() => service.status(7).index === 1 && !service.status(7).loading);
    assert.equal(records.filter((value) => value.fileIndex === 0 && value.completed).length >= 1, true);
    assert.deepEqual(accesses, [0, 1]); assert.ok(revoked.includes("0"));
    await assert.rejects(service.control({ action: "seek", value: -2 }, 7));
    await service.control({ action: "pause" }, 7); assert.equal(service.status(7).playing, false);
    await service.control({ action: "stop" }, 7); assert.equal(service.status(7).active, false); assert.equal(closed, true); assert.ok(revoked.includes("1"));
  } finally { await service.close(); }
});
