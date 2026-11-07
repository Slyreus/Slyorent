# Composants tiers

Slyorrent distribue plusieurs composants qui gardent leur licence d’origine. Ce fichier ne remplace pas leurs textes de licence, présents dans les paquets ou dans les liens source indiqués ici.

## Transmission 4.1.4

Le moteur P2P est un sous-ensemble du paquet Windows x64 officiel Transmission 4.1.4 : le daemon, ses DLL et ses plugins Qt nécessaires. Transmission est distribué sous GNU GPL v2 ou version ultérieure, avec certains composants sous licences compatibles.

- Projet et source exacte : https://github.com/transmission/transmission/tree/4.1.4
- Publication officielle : https://github.com/transmission/transmission/releases/tag/4.1.4
- Licence : https://github.com/transmission/transmission/blob/4.1.4/COPYING
- SHA-256 du MSI utilisé : `cf51e5772f39a3ead3c8f763b689399b9b4b8b016a4c0ca68ab5d6c634be2e1c`

## FFmpeg et FFprobe 9.0.2

Le lecteur utilise les exécutables Windows x64 du build Gyan 9.0.2 Essentials, sous GNU GPL v3. Les fichiers de licence et de configuration du build sont conservés à côté des exécutables dans l’application installée. L’archive et chaque exécutable ont une empreinte SHA-256 épinglée ; aucun outil du PATH n’est utilisé.

- Fournisseur : https://www.gyan.dev/ffmpeg/builds/
- Binaires et textes de licence : https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- Source FFmpeg exacte indiquée par le fournisseur : https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- Licence FFmpeg : https://github.com/FFmpeg/FFmpeg/blob/946fcce07b/COPYING.GPLv3
- SHA-256 de l’archive utilisée : `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`

## Interface et données locales

- Electron : MIT — https://github.com/electron/electron
- React et React DOM : MIT — https://github.com/facebook/react
- Lucide : ISC — https://github.com/lucide-icons/lucide
- geoip-lite : code Apache-2.0 — https://github.com/geoip-lite/node-geoip
- Les données GeoLite2 incluses par `geoip-lite` ont été créées par MaxMind et sont distribuées sous CC BY-SA 4.0 : https://www.maxmind.com
- Géométrie Natural Earth : domaine public. La conversion `world-atlas` conserve sa notice ISC dans `app/components/WORLD_GEOMETRY_LICENSE.md`.

Les archives de source exactes de Transmission et FFmpeg utilisées par cette V1 sont jointes à la release GitHub afin de garder le code correspondant accessible au même endroit que l’installateur.
