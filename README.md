# Slyorrent

Slyorrent, c’est mon client torrent Windows local. Le but est simple : ajouter un magnet ou un `.torrent`, télécharger dans une quarantaine, vérifier les pièces, lancer Microsoft Defender, puis déplacer ce qui est propre dans la médiathèque et commencer le partage.

Il n’y a pas de compte, pas de cloud et pas de télémétrie distante. L’interface, les réglages, les journaux et les médias restent sur le PC. Le P2P contacte évidemment les trackers et les pairs : ils peuvent voir ton adresse IP et les volumes échangés.

## Installer Slyorrent

Télécharge `Slyorrent-Setup-1.1.0.exe` dans la [release 1.1](https://github.com/Slyreus/Slyorent/releases/tag/v1.1.0), lance-le, puis ouvre Slyorrent depuis le raccourci créé sur le bureau.

Sur un fichier `.torrent`, fais un clic droit, « Ouvrir avec », puis choisis Slyorrent. Windows peut le ranger dans « Choisir une autre application ». L’installation ajoute ce choix sans remplacer ton application par défaut. Le fichier s’ouvre dans la fenêtre existante, avec le choix du dossier et la confirmation habituelle avant l’ajout en pause.

Slyorrent remplace le nom Slyorent. Le profil, les dossiers déjà choisis et les torrents restent au même endroit. Le dépôt GitHub garde son adresse.

L’installateur est prévu pour Windows 10 et 11 en 64 bits. Microsoft Defender doit être disponible pour la validation complète. Il n’y a pas encore de certificat Authenticode, donc Windows peut afficher « éditeur inconnu ». Le SHA-256 publié avec la release permet de vérifier que le fichier téléchargé est bien celui que j’ai construit.

## Ce qu’il y a dans l’application

- ajout de magnets et de fichiers `.torrent` ;
- choix du dossier final et du sous-dossier avant le téléchargement ;
- quarantaine locale, vérification BitTorrent et analyse Defender ;
- accès direct aux vidéos, filtres par torrent et saison, suivi de lecture et reprise ;
- lecteur plein écran avec adaptation audio locale pour AC3, E-AC3, DTS et TrueHD ;
- partage global, limites individuelles, ratio et volume réellement envoyé ;
- diagnostic du port, des trackers, des pairs et des demandes de blocs ;
- carte P2P locale avec positions approximatives et adresses anonymisées avant affichage ;
- journal local chaîné pour rendre les altérations détectables.

Le moteur P2P est Transmission 4.1.3. Slyorrent ne fabrique pas de trafic, ne force pas les pairs à choisir ce client et ne garantit aucun point ou ratio sur une communauté externe.

## Construire le projet

Il faut Node.js 24, Windows x64 et PowerShell 5.1 ou plus récent.

```powershell
npm ci
npm run engine:install
npm run check
npm run release:win
```

L’installateur sort dans `release/Slyorrent-Setup-1.1.0.exe`. Le build utilise une liste blanche de fichiers : les torrents, journaux, profils, clés, contenus téléchargés, caches et chemins personnels ne sont pas intégrés.

Pour lancer simplement la version de développement locale :

```powershell
npm run local
```

La médiathèque affiche les vidéos directement. Les torrents et les saisons restent disponibles en filtres. Le suivi garde la position de lecture sur le PC et propose de reprendre au même endroit. Il commence à partir de cette version, sans reconstituer les anciens visionnages.

Le lecteur prépare l’épisode suivant en arrière-plan. La première ouverture d’un MKV avec un son incompatible peut encore prendre du temps : la conversion et son analyse restent locales. Fermer le lecteur annule les préparations qui ne servent plus.

`npm run test:media-ui` teste le lecteur Electron avec une vidéo synthétique, dans un profil temporaire séparé. Il ne lance pas le moteur torrent et ne lit pas la bibliothèque personnelle.

La carte locale passe en vue stratégique, avec des tirs bleus à l’envoi et rouges à la réception, des traînées et des impacts. Le débit règle leur intensité. Les pairs sont regroupés par zone, le détail s’ouvre au clic et la carte passe en plein écran. Les tirs sont décoratifs : ce ne sont ni des paquets individuels, ni le chemin réel pris par les données. Sans transfert ou avec des données périmées, aucun tir.

La carte et la géolocalisation des pairs restent hors ligne. La base utilise seulement la position Windows demandée ou les coordonnées saisies. Les animations peuvent être figées ; elles s’arrêtent hors écran et respectent les réglages de réduction des mouvements. `npm run test:map-ui` vérifie la carte avec des données fictives, sans accéder au moteur ni aux positions personnelles.

## À savoir

Un hash BitTorrent confirme les pièces reçues, pas la légalité ni l’innocuité du contenu. Utilise seulement des contenus que tu as le droit de télécharger et de partager.

Un port fermé réduit les connexions entrantes mais n’empêche pas toutes les connexions sortantes. Un VPN n’est pas fourni par l’application. Si tu en utilises un, sa configuration et son coupe-circuit restent sous ta responsabilité.

Le code Slyorrent est publié sous licence MIT. Le nom Slyorrent, le nom Slyorus et la mascotte ne sont pas inclus dans cette licence. Les moteurs intégrés gardent leurs propres licences, détaillées dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Les failles ne doivent pas être mises directement dans une issue publique. La marche à suivre est dans [SECURITY.md](SECURITY.md).
