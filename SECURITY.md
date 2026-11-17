# Signaler une faille

Pour une faille, utilise « Security > Report a vulnerability » sur GitHub plutôt qu’une issue publique.

Indique la version de Slyorrent et de Windows, les étapes pour reproduire le problème et ce qui se passe. Ne joins pas de torrent privé, de magnet réel, de passkey, de média personnel ni de journal non nettoyé.

Un problème qui expose un fichier, une adresse, un chemin personnel ou permet l’exécution de code doit rester privé pendant sa correction.

La branche 1.x reçoit les corrections de sécurité critiques.

## Composants de la 1.1.12

Electron 45.3.3 embarque Chromium 156.0.8078.100 et Node.js 24.22.3. Le moteur P2P est Transmission 4.1.4 et le lecteur utilise FFmpeg/FFprobe 9.0.2. [Notes Electron](https://releases.electronjs.org/release/v45.3.3)

Le moteur utilise OpenSSL 3.5.9 et libcurl 8.23.0 avec zlib 1.4 intégré. Les archives officielles et chaque DLL sont vérifiées par SHA-256. La compilation est attestée sur GitHub. Les recettes sont dans `scripts/build-openssl.ps1` et `scripts/build-curl.ps1`. [Correctifs zlib 1.4](https://github.com/madler/zlib/releases/tag/v1.4)

Le moteur reçoit un environnement réduit et OpenSSL ne charge pas automatiquement le fichier global `openssl.cnf`. Le contrôle TLS vérifie aussi la décompression d’une réponse gzip et le refus d’un certificat non approuvé.

Au 17 novembre 2026, l’audit npm signale un avis sur picomatch sans correctif publié. Il touche les outils de compilation. La CI vérifie que tous les paquets concernés sont réservés au développement et bloque les autres avis. Le contrôle de l’installateur vérifie aussi l’absence de picomatch. [Avis picomatch](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

ESLint 9 et TypeScript 6 restent les versions compatibles avec les plugins de vérification du projet.
