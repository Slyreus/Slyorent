import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertLibraryPathBudget, libraryFolderName } from "../electron/library-destination.mjs";
import { protectionAlerts } from "../lib/protection-alerts.ts";

test("raccourcir le dossier ajouté sans renommer les fichiers du torrent", () => {
  const root = "C:\\Documents\\Bibliotheque", name = "Serie.avec.un.titre.tres.long.".repeat(3);
  const files = [{ name: `${name}/${"episode-01-".repeat(8)}.mkv` }];
  const original = structuredClone(files);
  const options = { root, name, hash: "a".repeat(40), files, platform: "win32" };
  for (const suffix of [1, 2, 1000]) {
    const folder = libraryFolderName({ ...options, suffix });
    assert.ok(folder.includes("aaaaaaaa"));
    assert.ok(path.win32.join(root, folder, files[0].name).length <= 259);
  }
  assert.deepEqual(files, original);
  assert.throws(() => libraryFolderName({ ...options, root: `C:\\${"racine".repeat(35)}` }), { code: "DESTINATION_PATH_TOO_LONG" });
  assert.throws(() => assertLibraryPathBudget(root, [{ name: "../fichier.mkv" }], "win32"), /interdit/u);
  assert.equal(libraryFolderName({ ...options, name: "Serie Test", files: [{ name: "episode.mkv" }] }), "Serie Test");
});

test("expliquer le badge Protection avec le transfert et le motif exact", () => {
  const torrents = [{ id: 7, name: "Serie Test", percentDone: 1, errorString: "Could not move: Nom de fichier ou extension trop long. (206)", files: [] }];
  const alerts = protectionAlerts(torrents);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].torrentId, 7);
  assert.equal(alerts[0].title, "Chemin Windows trop long"); assert.equal(alerts[0].danger, false); assert.equal(alerts[0].canValidate, true);
  assert.match(alerts[0].detail, /206/u);
  torrents[0].errorString = "No space left on device";
  assert.equal(protectionAlerts(torrents)[0].title, "Stockage insuffisant");
  assert.equal(protectionAlerts([]).length, 0);
  assert.equal(protectionAlerts([], "Connexion au moteur refusée")[0].name, "Moteur local");
  const blocked = protectionAlerts([{ id: 8, name: "Contenu bloqué", files: [{ name: "programme.exe", scanStatus: "blocked" }] }])[0];
  assert.equal(blocked.title, "Contrôle des fichiers bloqué"); assert.equal(blocked.danger, false);
});
