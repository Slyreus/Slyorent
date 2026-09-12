# Revue 1.1.3

Contrôle du 12 septembre 2026. Périmètre : lecteur et médiathèque, accès aux fichiers, validation et partage, échanges avec Transmission, isolation Electron, journaux, dépendances, carte P2P et paquet Windows. Revue du code et tests locaux, sans test d’intrusion ni garantie d’absence de faille.

## Lecture

Le refus venait d’une limite du lecteur : il convertissait le son E-AC3 mais exigeait une vidéo déjà compatible avec Chromium. Une source HEVC était donc refusée avant même la lecture.

La préparation accepte maintenant HEVC 10 bits, H.264 non compatible et les pistes audio à convertir. Elle produit un MP4 H.264/AAC, choisit le français lorsqu’il existe et ignore les images de couverture comme piste vidéo principale. Le HDR est adapté en SDR. Une accélération NVIDIA est tentée après un test local, avec repli CPU.

La progression est limitée à la fenêtre qui a demandé le média. La fermeture annule les travaux inutilisés. Une seule conversion tourne à la fois. Le cache est plafonné à 12 Gio, avec contrôle de l’espace libre et protection des copies en cours de lecture. Une sortie tronquée est refusée. L’original n’est pas modifié et la copie est analysée par Defender avant d’être servie.

La première conversion peut prendre plusieurs minutes selon la durée du média et le processeur. Les ouvertures suivantes réutilisent la copie tant qu’elle reste dans le cache. Les tests reproductibles utilisent des vidéos synthétiques, sans contenu personnel.

## Stabilité et accès locaux

Les réponses RPC sont lues par morceaux et interrompues au-delà de 16 Mio, au lieu d’être chargées intégralement avant contrôle. Le délai couvre aussi la lecture du corps et la négociation de session. Les corps HTTP abandonnés sont libérés.

Les rafraîchissements de l’interface partagent une seule requête en cours. Une modification impose une nouvelle lecture à sa suite. Cela évite les réponses concurrentes qui remplaçaient des données récentes par un ancien état.

La révocation d’un accès média coupe désormais les flux ouverts. Les fichiers sont fermés sur tous les chemins d’erreur. Les URL altérées, fenêtres non propriétaires, demandes déjà annulées et ouvertures pendant une nouvelle analyse sont refusées.

## Contrôles

Les suites couvrent notamment la quarantaine, la persistance des validations, les erreurs Defender, les limites de partage, les infohashs, les chemins et liens interdits, le masquage des secrets, le journal chaîné et le suivi de lecture.

Le lecteur est testé dans Electron sur un profil séparé : décodage audio et vidéo, pause, reprise, expiration de l’accès, volume, épisode suivant, progression et annulation. Le test du paquet charge les modules depuis le véritable ASAR, avec les exécutables FFmpeg et FFprobe dépaquetés.

Le paquet 1.1.3 a passé le contrôle de contenu et le test HEVC/E-AC3 synthétique : conversion, réutilisation du cache, lecture vidéo et décodage de la piste française.

Résultat : 180 tests réussis, aucun échec. Le test conditionnel du refus en l’absence de Defender est ignoré lorsque Defender est actif ; le scan réel est alors testé. Les tests d’interface du lecteur et de la carte passent séparément. Les contrôles du lecteur utilisent aussi les modules de l’application installée, dans un profil de test isolé.

La carte est testée avec des données fictives : animation, zoom, plein écran, sélection clavier, débit nul, données périmées, mouvements réduits et 512 pairs. Le test neutralise uniquement la mise en veille des fenêtres recouvertes ; le comportement de l’application reste inchangé.

L’audit npm des dépendances de production ne signale aucune vulnérabilité connue à cette date. Cela ne couvre pas à lui seul les moteurs natifs embarqués ni les failles encore inconnues. Le paquet est contrôlé pour exclure profils, torrents, journaux, clés et chemins personnels.

## Limites

La première conversion reste une opération complète, pas un streaming immédiat. Les copies ne contiennent pas les sous-titres ni les pistes alternatives. Les formats de vignette non décodables par Chromium peuvent encore afficher une icône de film. Les caches peuvent être reconstruits après éviction.

FFmpeg et Transmission restent des programmes natifs exécutés avec les droits du compte Windows, pas dans une machine virtuelle. Les empreintes des binaires, l’isolation du renderer et Defender réduisent les risques sans rendre un fichier inoffensif par définition. Un contrôle BitTorrent valide des pièces, pas la sécurité du contenu.

Le journal n’a pas encore de rotation. Sa croissance peut ralentir sa lecture sur une longue période. Une évolution devra conserver la vérification de la chaîne entre archives.

Aucun réglage de VPN, pare-feu, port ou ratio n’a été modifié dans cette correction. Le P2P expose toujours l’adresse utilisée aux trackers et aux pairs. L’installateur reste non signé Authenticode.

Références techniques : [progression et limites FFmpeg](https://ffmpeg.org/ffmpeg.html), [protocoles autorisés](https://www.ffmpeg.org/ffmpeg-protocols.html), [fenêtres Electron et animations en arrière-plan](https://www.electronjs.org/docs/latest/api/browser-window).
