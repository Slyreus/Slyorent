# Slyorrent

J’ai créé Slyorrent pour télécharger et partager mes torrents, puis retrouver mes vidéos au même endroit. C’est une application Windows, avec une médiathèque et un lecteur intégré. Elle fonctionne en local, sans compte ni cloud. Slyorus, le hibou, est la mascotte.

Pour l’installer, prends le setup dans la [dernière release](https://github.com/Slyreus/Slyorent/releases/latest). Lance-le, puis ouvre Slyorrent avec le raccourci du bureau. FFmpeg, FFprobe et Transmission sont déjà inclus. Il n’y a rien à installer en plus. Les archives de sources jointes à la release ne sont pas nécessaires pour utiliser l’application.

Il faut Windows 10 ou 11 en 64 bits. L’installateur n’est pas encore signé avec un certificat Authenticode : Windows peut donc afficher « éditeur inconnu ». Le fichier `SHA256SUMS.txt` contient les empreintes de l’installateur et des archives.

Tu peux ajouter un magnet ou un fichier `.torrent`. Au moment de l’ajout, tu choisis le dossier final et si tu veux un sous-dossier. Par défaut, la bibliothèque est dans `Documents/Slyorrent`. Les téléchargements passent d’abord par la quarantaine. Une fois terminés, les pièces sont vérifiées et les fichiers analysés par Microsoft Defender, avant le déplacement dans le dossier choisi et le partage complet.

Pour ouvrir un `.torrent` depuis Windows, fais un clic droit, « Ouvrir avec », puis choisis Slyorrent. Ton application par défaut ne change pas. Si Slyorrent est déjà ouvert, le fichier arrive dans la même fenêtre.

La médiathèque réunit les saisons d’une série, même quand elles viennent de plusieurs torrents. Tu peux chercher un titre ou un épisode, trier, filtrer et mettre des titres en favoris. La vue Liste donne directement accès aux fichiers. Le suivi indique ce que tu as regardé et le lecteur te propose de reprendre là où tu t’es arrêté. Le classement ne renomme pas les fichiers et ne cherche pas de jaquettes en ligne. Les détails sont dans [Médiathèque](docs/MEDIATHEQUE.md).

La langue audio et les sous-titres se choisissent dans la barre du lecteur, à côté de Précédent et Suivant. En VO, le français s’active par défaut lorsqu’il est disponible. Le texte s’adapte à la taille du lecteur, avec un fond arrondi et des lignes qui utilisent la largeur de la vidéo. Les sous-titres texte intégrés ASS, SSA, SRT, WebVTT et mov_text sont pris en charge, mais pas encore les pistes sous forme d’images ni les fichiers de sous-titres séparés.

Le bouton Caster permet de lancer la vidéo sur un Chromecast, une Google TV ou un appareil DLNA. Pour un autre écran, il y a un lecteur à ouvrir dans son navigateur, avec un code de connexion. Le PC garde les commandes, le suivi et l’option pour passer automatiquement à l’épisode suivant. Les appareils doivent être sur le même réseau privé et Slyorrent doit rester ouvert. Les fonctions DLNA varient selon la TV ; AirPlay et Miracast ne sont pas pris en charge. [Cast](docs/CAST.md) explique les limites et le réglage du pare-feu.

Certains formats, comme le HEVC ou le son E-AC3, demandent une conversion pour le lecteur. Elle se fait sur le PC, sans modifier l’original. La première lecture peut prendre quelques minutes ; les suivantes réutilisent la copie en cache. Une carte NVIDIA compatible peut accélérer la conversion. Le cache est limité à 12 Go et les copies passent aussi par Defender.

Pour le partage, tu peux définir des paramètres globaux, garder des limites par torrent ou tout arrêter. Le volume envoyé est affiché en plus du ratio. Le diagnostic permet de vérifier le port, les trackers et les connexions. Le moteur est Transmission 4.1.3 : le débit dépend aussi de la demande et des autres pairs. Aucun client ne peut garantir du partage ou des points sur un tracker.

La carte P2P est un gadget. Les tirs bleus représentent l’envoi, les rouges la réception, avec une intensité liée au débit. Les pairs sont réels, leurs positions approximatives. Ce n’est pas le trajet exact des données.

Les réglages, le suivi de lecture et les journaux restent sur le PC. Il n’y a pas de VPN fourni avec Slyorrent. Comme avec les autres clients torrent, les pairs et les trackers voient l’adresse IP utilisée. Un contrôle BitTorrent valide les pièces reçues, pas la sécurité du contenu, et un antivirus ne garantit pas qu’un fichier est sans risque. Utilise des contenus que tu as le droit de télécharger et de partager. [Données et réseau](PRIVACY.md) donne les détails.

Pour lancer le projet, il faut Windows x64, Node.js 24 et PowerShell 5.1 ou plus récent :

```powershell
npm ci
npm run engine:install
npm run local
```

Pour les vérifications et l’installateur :

```powershell
npm run check
npm run release:win
```

Le setup est créé dans `release/`. Les profils, torrents, médias, journaux et clés locales ne sont pas inclus. Les commandes `test:media-ui`, `test:catalog-ui`, `test:map-ui` et `test:packaged-media` utilisent des données fictives dans des profils séparés.

Le code est sous licence MIT. Le nom Slyorrent, le nom Slyorus et la mascotte gardent leurs propres conditions, précisées dans [LICENSE](LICENSE). Les licences des moteurs sont dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Pour signaler une faille, consulte [SECURITY.md](SECURITY.md).

Le projet s’appelait auparavant Slyorent. Le nom a changé, pas l’adresse du dépôt. Les mises à jour conservent les torrents, les dossiers choisis et le suivi de lecture.
