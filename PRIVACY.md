# Données et réseau

Slyorrent ne demande pas de compte et n’envoie pas de télémétrie à Slyreus. Les réglages, journaux, clés HMAC, torrents, fichiers temporaires et médias restent sur le PC.

BitTorrent n’est pas anonyme. Les trackers et les pairs contactés peuvent voir l’adresse IP utilisée, le client P2P et les volumes échangés. Les règles de chaque tracker continuent de s’appliquer.

La carte P2P reçoit du moteur les pairs réellement connectés, mais l’adresse brute ne passe pas dans l’interface et n’est pas écrite dans le journal. La géolocalisation est approximative et locale. La position Windows n’est demandée qu’après une action explicite, elle est arrondie et n’est pas conservée.

Microsoft Defender analyse localement les fichiers terminés. Slyorrent ne transmet pas les fichiers à un service d’analyse distant.
