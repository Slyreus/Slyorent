# Signaler une faille

Pour une faille, utilise « Security > Report a vulnerability » sur GitHub plutôt qu’une issue publique.

Indique la version de Slyorrent et de Windows, les étapes pour reproduire le problème et ce qui se passe. Ne joins pas de torrent privé, de magnet réel, de passkey, de média personnel ni de journal non nettoyé.

Un problème qui expose un fichier, une adresse, un chemin personnel ou permet l’exécution de code doit rester privé pendant sa correction.

La branche 1.x reçoit les corrections de sécurité critiques.

## Composants de la 1.1.11

Vérification du 7 novembre 2026 : Electron 45.2.3, Transmission 4.1.4 et FFmpeg/FFprobe 9.0.2. L’audit npm porte sur les dépendances de production et de développement. Il ne couvre pas les bibliothèques intégrées aux exécutables.

Le paquet Windows officiel de Transmission 4.1.4 contient encore OpenSSL 3.5.4, alors que la branche 3.5 a reçu des correctifs depuis. Cette limite reste ouverte côté fournisseur. Les DLL officielles et leurs empreintes sont conservées ensemble ; elles ne sont pas remplacées par celles d’un autre logiciel. Voir les [correctifs OpenSSL 3.5](https://www.openssl-library.org/news/openssl-3.5-notes/index.html).

ESLint reste sur la dernière révision 9.x compatible avec les plugins React et accessibilité du projet. Ce choix concerne les outils de développement ; la version 10 demande leur mise à niveau.
