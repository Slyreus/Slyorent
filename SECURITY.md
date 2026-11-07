# Signaler une faille

Pour une faille, utilise « Security > Report a vulnerability » sur GitHub plutôt qu’une issue publique.

Indique la version de Slyorrent et de Windows, les étapes pour reproduire le problème et ce qui se passe. Ne joins pas de torrent privé, de magnet réel, de passkey, de média personnel ni de journal non nettoyé.

Un problème qui expose un fichier, une adresse, un chemin personnel ou permet l’exécution de code doit rester privé pendant sa correction.

La branche 1.x reçoit les corrections de sécurité critiques.

## Composants de la 1.1.11

Vérification du 7 novembre 2026 : Electron 45.2.3, Transmission 4.1.4 et FFmpeg/FFprobe 9.0.2. L’audit npm porte sur les dépendances de production et de développement. Il ne couvre pas les bibliothèques intégrées aux exécutables.

Le moteur utilise OpenSSL 3.5.9 et libcurl 8.23.0, compilés depuis les archives officielles vérifiées. Ces versions remplacent OpenSSL 3.5.4 et libcurl 8.16.0 du MSI Transmission. Les empreintes des archives et de chaque DLL sont épinglées. La compilation possède une attestation GitHub liée au code source du workflow. Les recettes sont dans `scripts/build-openssl.ps1` et `scripts/build-curl.ps1`.

OpenSSL ne charge pas automatiquement le fichier global `openssl.cnf`. Le moteur reçoit un environnement réduit, sans variables permettant de désactiver la vérification TLS. Les tests contrôlent la version chargée, une connexion HTTPS locale approuvée et le refus d’un certificat non approuvé. Les DLL Qt inutilisées par le daemon ne sont plus distribuées.

Références : [correctifs OpenSSL 3.5](https://www.openssl-library.org/news/openssl-3.5-notes/index.html), [avis libcurl 8.23.0](https://curl.se/docs/vuln-8.23.0.html). Ces contrôles ne constituent pas une garantie d’absence de faille inconnue.

ESLint reste sur la dernière révision 9.x compatible avec les plugins React et accessibilité du projet. Ce choix concerne les outils de développement ; la version 10 demande leur mise à niveau.
