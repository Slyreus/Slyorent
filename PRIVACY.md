# Données et réseau

Slyorrent ne demande pas de compte et n’envoie pas de télémétrie à Slyreus. Les réglages, torrents, médias, fichiers temporaires, journaux et clés de contrôle restent sur le PC.

Les connexions BitTorrent passent par les trackers et les pairs. Ils peuvent voir l’adresse IP utilisée, le client et les volumes échangés. Slyorrent ne fournit pas de VPN et ne rend pas le P2P anonyme. Les règles des trackers restent les mêmes.

La carte affiche des pairs réellement connectés, avec une position approximative calculée localement. Leurs adresses brutes ne sont pas transmises à l’interface ni écrites dans le journal.

La position Windows n’est demandée qu’à ton initiative. Les coordonnées sont arrondies et ne sont pas conservées.

Les fichiers terminés et les copies de lecture passent par Microsoft Defender. Slyorrent ne les envoie pas à un service d’analyse distant.

Le cast ouvre temporairement un accès HTTP sur une seule interface privée du PC. L’appareil choisi reçoit la vidéo et les sous-titres sélectionnés, pas le catalogue ni les commandes du moteur torrent. Le mode navigateur demande un code à usage unique, valable deux minutes, puis limite la session à une adresse locale. Les jetons d’accès ne sont pas enregistrés dans les journaux. L’arrêt du cast ferme le serveur et révoque les accès.

Les flux Cast et DLNA restent sur le réseau local, mais la vidéo en HTTP n’est pas chiffrée. Utilise un réseau de confiance, pas un Wi-Fi public ou partagé avec des personnes inconnues. La connexion de commande Google Cast accepte le certificat auto-signé du récepteur choisi ; ce n’est pas une vérification cryptographique de son identité. Aucune règle de pare-feu ni redirection de port n’est créée automatiquement.
