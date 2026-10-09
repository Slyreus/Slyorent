# Backend Slyorrent

Le processus principal Electron gère Transmission, les fichiers, les analyses et la lecture. L’interface passe par des méthodes IPC autorisées ; elle n’a ni accès Node.js ni identifiants Transmission.

La fenêtre utilise le sandbox, `contextIsolation` et `webSecurity`, sans `nodeIntegration`. Les navigations externes, les nouvelles fenêtres et les webviews sont bloquées. Les demandes IPC sont limitées à la fenêtre principale.

Transmission 4.1.3 démarre après vérification des empreintes de son exécutable et des DLL autorisées. Un fichier ajouté ou modifié bloque son lancement. Son API écoute sur `127.0.0.1`, avec des identifiants aléatoires et le contrôle de session Transmission.

Les téléchargements arrivent dans la quarantaine du profil local. Le dossier final vient du sélecteur Windows et reste enregistré dans une politique de stockage. L’interface reçoit un jeton lié à sa fenêtre, pas la possibilité d’ouvrir un chemin arbitraire. La bibliothèque par défaut est `Documents/Slyorrent`.

`verifyAndScan()` arrête le torrent, révoque les accès média, attend la fin de la vérification BitTorrent puis analyse les fichiers avec Defender. Après réussite, les données rejoignent le dossier final. Un registre signé par HMAC conserve leur emplacement et les métadonnées contrôlées. La validation est revérifiée au redémarrage.

Les URL `secutorrent-media://` sont temporaires et réservées à leur fenêtre. La lecture exige un fichier complet, validé, sous un chemin autorisé et avec une signature média reconnue. Sa taille et sa date de modification sont contrôlées avant ouverture. Révoquer un accès coupe aussi les flux ouverts.

FFmpeg et FFprobe inspectent les pistes et préparent les copies compatibles H.264/AAC. Les pistes audio peuvent être sélectionnées et les sous-titres texte sont extraits en WebVTT. Les dialogues passent dans le lecteur sans charger de polices, de styles ASS ni de ressources externes. Les conversions sont mises en cache et analysées par Defender. Les versions et empreintes des moteurs sont dans `media-adapter.mjs` et [THIRD_PARTY_MEDIA.md](THIRD_PARTY_MEDIA.md).

Le journal `audit.jsonl` est chaîné par HMAC-SHA-256 et synchronisé sur disque. Il ne contient ni secrets, ni magnets, ni adresses de trackers. Il permet de détecter des modifications, mais pas de résister à un attaquant qui contrôle le compte Windows et la clé locale.

La géolocalisation des pairs utilise la base embarquée de `geoip-lite`, hors ligne. Une base locale `GeoLite2-City.mmdb` peut être utilisée avec son lecteur MaxMind si les deux sont disponibles. Sans base utilisable, la position reste inconnue ; il n’y a pas de service GeoIP distant, de STUN ni de repli réseau.

Les adresses brutes des pairs ne sont envoyées ni à l’interface ni au journal. Un identifiant HMAC temporaire les remplace, avec une rotation toutes les quinze minutes. Les adresses privées et réservées sont filtrées et le nombre de pairs affichés est borné.

`locateSelf()` consulte la position Windows à la demande. Les coordonnées sont arrondies à 0,1° et ne sont ni enregistrées ni journalisées. Si Windows ne fournit pas de position, le placement manuel reste disponible. Le fuseau horaire n’est pas utilisé comme une localisation.

En production, Electron charge les fichiers de `dist/` sans serveur HTTP. Les variables suivantes concernent le développement ou une configuration explicite :

```text
SECUTORRENT_RENDERER_URL    Origine HTTP locale de développement
SECUTORRENT_DEVTOOLS=1      Outils développeur hors version empaquetée
SECUTORRENT_PEER_PORT       Port TCP/UDP des pairs, 51413 par défaut
SECUTORRENT_ENABLE_PORTMAP=1 Autorisation UPnP/NAT-PMP
```

Pendant un téléchargement, les pièces déjà validées peuvent être échangées pour conserver le fonctionnement du protocole. Le partage complet attend la vérification et l’analyse de fin. Cela ne garantit pas une absence totale d’envoi pendant la transition de fin du téléchargement.

Les adresses locales ou réservées des trackers sont refusées avant le démarrage. Ce contrôle ne remplace pas une règle de pare-feu : un pair annoncé plus tard peut venir du LAN. Slyorrent ne modifie pas le pare-feu automatiquement.

FFmpeg et Transmission tournent avec les droits du compte Windows, pas dans une machine virtuelle. Une courte course reste possible entre le scan Defender par chemin et l’ouverture du fichier. Les empreintes, les contrôles de chemins et l’isolation de l’interface réduisent les risques sans garantir qu’un contenu est inoffensif.
