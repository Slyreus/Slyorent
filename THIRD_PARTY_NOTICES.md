# Composants tiers

Slyorrent distribue plusieurs composants qui gardent leur licence d’origine. Ce fichier ne remplace pas leurs textes de licence, présents dans les paquets ou dans les liens source indiqués ici.

## Transmission 4.1.3

Le moteur P2P est un sous-ensemble du paquet Windows x64 officiel Transmission 4.1.3 : le daemon, ses DLL et ses plugins Qt nécessaires. Transmission est distribué sous GNU GPL v2 ou version ultérieure, avec certains composants sous licences compatibles.

- Projet et source exacte : https://github.com/transmission/transmission/tree/4.1.3
- Publication officielle : https://github.com/transmission/transmission/releases/tag/4.1.3
- Licence : https://github.com/transmission/transmission/blob/4.1.3/COPYING
- SHA-256 du MSI utilisé : `c8ea492d8f46fadac26e0c05b244cabba556201d5fe348dfcf1cf036621741f8`

## FFmpeg et FFprobe 6.1.1

Le lecteur utilise les exécutables Windows x64 fournis par `ffmpeg-static@5.3.0` et `@derhuerst/ffprobe-static@5.3.0`, release b6.1.1. Le build Gyan est sous GNU GPL v3. Les fichiers de licence et de configuration du build sont conservés à côté des exécutables dans l’application installée.

- Paquet : https://github.com/eugeneware/ffmpeg-static/tree/5.3.0
- Binaires et textes de licence : https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- Source FFmpeg exacte indiquée par le fournisseur : https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- Licence FFmpeg : https://github.com/FFmpeg/FFmpeg/blob/e38092ef93/COPYING.GPLv3

## Interface et données locales

- Electron : MIT — https://github.com/electron/electron
- React et React DOM : MIT — https://github.com/facebook/react
- Lucide : ISC — https://github.com/lucide-icons/lucide
- geoip-lite : code Apache-2.0 — https://github.com/geoip-lite/node-geoip
- Les données GeoLite2 incluses par `geoip-lite` ont été créées par MaxMind et sont distribuées sous CC BY-SA 4.0 : https://www.maxmind.com
- Géométrie Natural Earth : domaine public. La conversion `world-atlas` conserve sa notice ISC dans `app/components/WORLD_GEOMETRY_LICENSE.md`.

Les archives de source exactes de Transmission et FFmpeg utilisées par cette V1 sont jointes à la release GitHub afin de garder le code correspondant accessible au même endroit que l’installateur.
