# Logo Slyorrent

Un hibou blanc sans bec, sur un carré bleu aux coins arrondis. Aucun effet, aucune texture. Le contour est transparent. La mascotte Slyorus reste dans les grands visuels de l’application.

La transparence des coins est définie dans le SVG et conservée dans les fichiers PNG et ICO.

## Fichiers

`public/slyorrent-logo.svg` est la source vectorielle. `npm run icons:build` la rend localement avec Electron, dans un profil temporaire isolé, puis produit `public/slyorrent-logo.png` et `public/slyorrent.ico`. Aucun téléchargement ni appel à un service d’image pendant le build.

Le PNG mesure 1024 × 1024 pixels. L’ICO contient sept résolutions : 16, 24, 32, 48, 64, 128 et 256 pixels. Le PNG de l’interface, le logo de la fenêtre, le raccourci, l’exécutable, l’installateur et les associations Windows utilisent ce même dessin.

## Format Windows

Les images PNG intégrées à un ICO doivent être en RGBA 32 bits. L’ancienne icône était en RGB 24 bits : les ressources étaient présentes, mais Windows refusait leur extraction. La contrainte est décrite dans la [documentation Microsoft](https://devblogs.microsoft.com/oldnewthing/20101022-00/?p=12473). Les tests vérifient le format, les coins transparents, l’absence du bec et l’extracteur natif Windows.

Les chemins d’icône sont enregistrés dans les clés propres à Slyorrent, conformément à la [documentation des associations Windows](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration). Le choix de l’application par défaut n’est pas modifié.

## Origine du dessin

La proposition initiale a été créée avec un outil de génération d’images. Le dessin retenu a ensuite été repris en vectoriel, avec validation de l’auteur. Le logo et la mascotte restent soumis aux conditions précisées dans `LICENSE`.
