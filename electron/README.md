# Backend local de Slyorrent

Ce dossier contient le processus principal Electron, son preload minimal et le moteur P2P local. Le renderer n'obtient jamais Node.js ni les identifiants Transmission.

## Frontières de sécurité

- `BrowserWindow`: `sandbox`, `contextIsolation`, `webSecurity`, aucun `nodeIntegration`, aucune navigation ou fenêtre externe.
- JSON-RPC 2.0 local sur IPC avec liste blanche de méthodes et contrôle strict du `webContents` principal.
- Transmission 4.1.3, ses 18 DLL/plugins et son `qt.conf` sont vérifiés par une liste fermée d'empreintes SHA-256 avant exécution; toute DLL ajoutée bloque le démarrage. Son JSON-RPC 2.0 HTTP est lié à `127.0.0.1`, protégé par Basic Auth aléatoire et gère le défi HTTP 409 `X-Transmission-Session-Id`.
- Le profil, les données temporaires et l'audit restent confinés dans `app.getPath("userData")`. Transmission télécharge toujours dans la quarantaine interne. La destination finale vient du sélecteur natif Windows, est canonisée et enregistrée dans une politique bornée ; le renderer ne reçoit qu'un jeton éphémère lié à sa fenêtre. La bibliothèque par défaut est `Documents/Slyorrent`.
- Les trackers littéraux ou résolus vers une adresse locale/réservée sont refusés avant démarrage.
- Le journal `audit.jsonl` est écrit en ajout par l'application, chaîné par HMAC-SHA-256 et synchronisé sur disque. Il détecte les altérations, mais n'est pas immuable face à un attaquant contrôlant complètement le même compte Windows puisque sa clé locale est stockée à côté. Secrets, magnets et trackers n'y sont jamais écrits.
- Une URL interne `secutorrent-media://` opaque et temporaire n'est émise qu'après arrêt du torrent, contrôle de chemin, analyse Defender propre et vérification de la signature du média. Si Defender détecte une menace, sa politique de remédiation Windows reste active et le fichier peut être mis en quarantaine système.
- `verifyAndScan()` verrouille le torrent, révoque ses accès média, attend la fin réelle de `torrent_verify`, contrôle que toutes les données voulues sont encore complètes, puis lance Defender. Après succès seulement, `torrent_set_location(move:true)` déplace les données, le registre HMAC atomique mémorise la destination et les métadonnées contrôlées, puis le partage reprend. Cet état est revérifié au redémarrage.
- Le renderer peut demander un sélecteur de dossier, ouvrir le dossier courant ou fournir un identifiant de torrent. Il ne peut jamais transmettre un chemin libre à `shell.openPath`; le processus principal résout le répertoire réel sous une racine préalablement autorisée.
- Les pistes AC3, E-AC3, DTS et TrueHD des conteneurs Matroska sont adaptées localement en AAC stéréo pour le lecteur Chromium. La vidéo H.264 est copiée sans perte, la piste française est préférée, le résultat MP4 est mis en cache, contrôlé par signature puis analysé par Defender avant émission de l'URL éphémère. Les binaires FFmpeg/FFprobe sont épinglés par version et SHA-256; voir `THIRD_PARTY_MEDIA.md`.
- La télémétrie ne transmet jamais l'adresse d'un pair au renderer ni au journal. Elle ignore les adresses privées, réservées, de documentation et IPv4-mappées, ne conserve qu'un identifiant HMAC éphémère (rotation toutes les 15 minutes) et borne strictement le nombre de pairs. La géolocalisation est un lookup local uniquement; aucun repli HTTP, DNS GeoIP ou STUN n'existe.

## Base GeoIP hors ligne optionnelle

Le backend recherche uniquement `.runtime/geoip/GeoLite2-City.mmdb` et reste honnêtement en état `unavailable` si le lecteur ou la base manque. Le lecteur officiel MaxMind vérifié le 19 août 2026 est `@maxmind/geoip2-node@7.1.0` (Node 22+, compatible avec le projet). L'ajout recommandé, volontairement non appliqué ici, est `npm install --save-exact @maxmind/geoip2-node@7.1.0`, puis l'installation hors ligne d'une base MaxMind `GeoLite2-City.mmdb` obtenue conformément à sa licence. Le runtime n'instancie jamais `WebServiceClient` et ne possède aucun repli réseau. Le fichier doit être un fichier régulier canonique entre 1 et 256 Mo; il doit être renouvelé avec les versions de l'application pour limiter l'obsolescence géographique.

`locateSelf()` est séparé du snapshot et ne s'exécute qu'à la demande du renderer. Il consulte Windows Location Service via un processus PowerShell système borné, arrondit latitude/longitude à 0,1°, ne fait aucun géocodage inverse et ne persiste ni ne journalise le résultat. Si le service est désactivé, refusé ou indisponible, l'API renvoie un état explicite autorisant un placement manuel approximatif. Le fuseau local (`Europe/Paris` en repli) reste une simple métadonnée sans latitude/longitude : il n'est jamais affiché comme position réelle.

## Variables locales

- Sans variable, le renderer de production est chargé directement depuis `dist/index.html`; aucun serveur HTTP n'est lancé.
- `SECUTORRENT_RENDERER_URL`: origine HTTP de boucle locale explicitement réservée au développement.
- `SECUTORRENT_PEER_PORT`: port pair TCP/UDP fixe, par défaut `51413`.
- `SECUTORRENT_ENABLE_PORTMAP=1`: autorise explicitement UPnP/NAT-PMP. Désactivé par défaut.
- `SECUTORRENT_DEVTOOLS=1`: ouvre les outils développeur. Ne pas activer en production.

## Limites assumées

Les pièces validées par leurs hashes BitTorrent peuvent être échangées pendant le téléchargement afin de conserver la réciprocité du protocole. Dès que la complétion est détectée, le backend arrête le torrent, vérifie l'ensemble des pièces puis lance Defender ; le seeding complet ne reprend qu'après déplacement et persistance HMAC du statut sûr. Une garantie formelle d'absence d'envoi pendant la courte transition de fin exigerait un moteur adapté ou une isolation réseau privilégiée.

La validation DNS avant démarrage réduit les risques de tracker SSRF, mais seule une règle de pare-feu Windows sortante, installée avec privilèges administrateur, peut garantir que le processus pair ne contacte jamais une adresse LAN annoncée ultérieurement par DHT, PEX ou un tracker. Le backend ne modifie pas silencieusement le pare-feu.

Le jeton média mémorise la taille et la date de modification issues du scan, puis le protocole ouvre un descripteur et les revérifie avant chaque flux. Il reste une courte fenêtre de course entre l'analyse Defender par chemin et l'ouverture de ce descripteur; l'éliminer totalement demanderait une isolation de volume ou un service privilégié capable de scanner un handle verrouillé.

La production charge déjà les assets embarqués de `dist` sans serveur. `SECUTORRENT_RENDERER_URL` affaiblit volontairement cette frontière pour le développement et ne doit jamais être définie lors d'un usage normal.
