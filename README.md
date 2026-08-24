# Slyorent

Slyorent, c’est mon client torrent Windows local. Le but est simple : ajouter un magnet ou un `.torrent`, télécharger dans une quarantaine, vérifier les pièces, lancer Microsoft Defender, puis déplacer ce qui est propre dans la médiathèque et commencer le partage.

Il n’y a pas de compte, pas de cloud et pas de télémétrie distante. L’interface, les réglages, les journaux et les médias restent sur le PC. Le P2P contacte évidemment les trackers et les pairs : ils peuvent voir ton adresse IP et les volumes échangés.

## Installer la V1

Télécharge `Slyorent-Setup-1.0.0.exe` dans la [release V1](https://github.com/Slyreus/Slyorent/releases/tag/v1.0.0), lance-le, puis ouvre Slyorent depuis le raccourci créé sur le bureau.

L’installateur est prévu pour Windows 10 et 11 en 64 bits. Microsoft Defender doit être disponible pour la validation complète. Cette première release n’a pas encore de certificat Authenticode, donc Windows peut afficher « éditeur inconnu ». Le SHA-256 publié avec la release permet de vérifier que le fichier téléchargé est bien celui que j’ai construit.

## Ce qu’il y a dans cette V1

- ajout de magnets et de fichiers `.torrent` ;
- choix du dossier final et du sous-dossier avant le téléchargement ;
- quarantaine locale, vérification BitTorrent et analyse Defender ;
- médiathèque regroupée par torrent, série, saison et épisode ;
- lecteur plein écran avec adaptation audio locale pour AC3, E-AC3, DTS et TrueHD ;
- partage global, limites individuelles, ratio et volume réellement envoyé ;
- diagnostic du port, des trackers, des pairs et des demandes de blocs ;
- carte P2P locale avec positions approximatives et adresses anonymisées avant affichage ;
- journal local chaîné pour rendre les altérations détectables.

Le moteur P2P est Transmission 4.1.3. Slyorent ne fabrique pas de trafic, ne force pas les pairs à choisir ce client et ne garantit aucun point ou ratio sur une communauté externe.

## Construire le projet

Il faut Node.js 24, Windows x64 et PowerShell 5.1 ou plus récent.

```powershell
npm ci
npm run engine:install
npm run check
npm run release:win
```

L’installateur sort dans `release/Slyorent-Setup-1.0.0.exe`. Le build utilise une liste blanche de fichiers : les torrents, journaux, profils, clés, contenus téléchargés, caches et chemins personnels ne sont pas intégrés.

Pour lancer simplement la version de développement locale :

```powershell
npm run local
```

## À savoir

Un hash BitTorrent confirme les pièces reçues, pas la légalité ni l’innocuité du contenu. Utilise seulement des contenus que tu as le droit de télécharger et de partager.

Un port fermé réduit les connexions entrantes mais n’empêche pas toutes les connexions sortantes. Un VPN n’est pas fourni par l’application. Si tu en utilises un, sa configuration et son coupe-circuit restent sous ta responsabilité.

Le code Slyorent est publié sous licence MIT. Le nom Slyorent, le nom Slyorus et la mascotte ne sont pas inclus dans cette licence. Les moteurs intégrés gardent leurs propres licences, détaillées dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Les failles ne doivent pas être mises directement dans une issue publique. La marche à suivre est dans [SECURITY.md](SECURITY.md).
