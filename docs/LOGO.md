# Logo Slyorrent

Le logo reprend Slyorus sous la forme d’un hibou blanc sans bec, sur un carré bleu arrondi. Les coins sont transparents. La mascotte détaillée reste utilisée dans les grands visuels de l’application.

Le dessin source est dans `public/slyorrent-logo.svg`. La commande `npm run icons:build` génère le PNG et l’icône Windows avec Electron, sans service d’image externe.

Le PNG mesure 1024 × 1024 pixels. L’ICO contient les tailles 16, 24, 32, 48, 64, 128 et 256 pixels. Le même dessin sert à la fenêtre, au raccourci, à l’exécutable, à l’installateur et aux fichiers associés.

Les images de l’ICO sont en RGBA 32 bits, avec les coins transparents. Ce format est nécessaire à leur lecture par Windows ; voir la [documentation Microsoft](https://devblogs.microsoft.com/oldnewthing/20101022-00/?p=12473).

L’installation enregistre l’icône dans les clés de Slyorrent, sans changer l’application par défaut. Les [associations Windows](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration) sont gérées séparément du choix de l’utilisateur.

Les conditions d’utilisation du logo et de la mascotte sont précisées dans [LICENSE](../LICENSE).
