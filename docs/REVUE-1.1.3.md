# Slyorrent 1.1.3

Cette note concerne la version 1.1.3, contrôlée le 12 septembre 2026. Elle décrit cette version, pas l’état des versions suivantes.

Le lecteur prend en charge la préparation des vidéos HEVC 10 bits et des pistes E-AC3 en H.264/AAC. Le français est préféré lorsqu’il est présent. Les images de couverture ne servent pas de piste vidéo, les sources HDR sont adaptées en SDR et une carte NVIDIA compatible peut accélérer la conversion.

Une seule conversion tourne à la fois. Le cache est limité à 12 Gio, avec contrôle de l’espace disponible et protection des copies en lecture. Fermer le lecteur annule les travaux inutilisés. Une copie tronquée est refusée ; une copie terminée passe par Defender. L’original reste intact.

La première préparation peut prendre plusieurs minutes. La copie est ensuite réutilisée tant qu’elle reste en cache. Dans cette version, les sous-titres et les pistes alternatives ne sont pas accessibles dans la copie de lecture.

Les réponses Transmission sont limitées à 16 Mio. Les délais couvrent la lecture du corps et la négociation de session. Les rafraîchissements de l’interface n’empilent pas les requêtes et une réponse ancienne ne remplace pas un état plus récent.

La révocation d’un accès média interrompt les flux déjà ouverts. Les URL altérées, les fenêtres non propriétaires, les demandes annulées et les lectures pendant une nouvelle analyse sont refusées.

Les vérifications de cette version ont donné 180 tests réussis et aucun échec. Le scan réel a été testé avec Defender actif ; le test conditionnel de son absence a été ignoré. Le lecteur, la carte et le paquet Windows ont aussi été testés dans des profils séparés, avec des médias et des pairs fictifs. L’audit npm ne signalait pas de vulnérabilité connue parmi les dépendances de production à cette date.

Ces contrôles ne sont pas un test d’intrusion et ne garantissent pas l’absence de faille. FFmpeg et Transmission sont des programmes natifs avec les droits du compte Windows. Le contrôle BitTorrent valide les pièces, pas la sécurité du contenu.

Le journal n’a pas de rotation dans cette version. La première conversion reste complète, pas immédiate, et certaines vignettes ne sont pas décodables par Chromium. L’installateur n’est pas signé Authenticode. Le P2P expose l’adresse IP utilisée aux trackers et aux pairs.

Références : [FFmpeg](https://ffmpeg.org/ffmpeg.html), [protocoles FFmpeg](https://www.ffmpeg.org/ffmpeg-protocols.html), [BrowserWindow Electron](https://www.electronjs.org/docs/latest/api/browser-window).
