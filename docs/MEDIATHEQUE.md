# Médiathèque

La médiathèque classe les fichiers d’après leurs noms et ceux des torrents. Elle ne renomme rien, ne déplace rien et ne consulte pas de catalogue en ligne.

La vue Titres réunit les saisons d’une série, même sur plusieurs torrents. Elle rapproche les différences simples de casse, d’accents et de ponctuation, ainsi que « and », « et » et « & ». Les années restent dans les titres pour distinguer deux versions d’un film. Des noms traduits ou très différents peuvent donc rester séparés.

Dans un pack de films, chaque film a sa fiche. Les fichiers audio restent regroupés par torrent. Si tu as plusieurs copies d’un épisode, elles restent visibles avec leur source ; l’enchaînement ne rejoue pas les doublons.

Le bouton Lire ouvre le premier épisode prêt et non vu, ou reprend l’épisode en cours. Le titre de la fiche donne accès aux fichiers et aux saisons. La vue Liste permet de parcourir les fichiers directement, avec un regroupement par titre, par torrent ou sans regroupement.

Tu peux combiner la recherche avec les catégories, les favoris, l’état de visionnage, la disponibilité, le torrent et la saison. « saison 2 épisode 3 » et « S02E03 » trouvent les mêmes numéros. La recherche ignore les accents.

Le tri peut se faire par titre, date d’ajout du torrent, dernière lecture ou taille. Pour un groupe, il utilise la date la plus récente et la taille totale des fichiers affichés. Si le moteur ne fournit pas de date, elle reste inconnue.

L’affichage, le tri, le regroupement et les favoris restent enregistrés. Les filtres temporaires repartent à zéro quand tu rouvres la médiathèque. Les préférences sont dans `library-preferences.json` et le suivi dans `watch-history.json`, dans le profil local. Un fichier de préférences illisible n’est pas écrasé.

Le lecteur propose la reprise, le plein écran, le choix audio et les sous-titres intégrés. Les menus de pistes sont sur la barre Précédent / Suivant. Pour une VO, les sous-titres français complets sont préférés ; pour du son français, seuls les sous-titres français forcés s’activent automatiquement. Tu peux toujours choisir autre chose.

Les fichiers incomplets ou non validés restent visibles, mais ne peuvent pas être lus. « Dossiers et vérifications » donne accès à « Vérifier et analyser » et au dossier de chaque torrent.

Les vues et filtres s’inspirent des bibliothèques [Plex](https://support.plex.tv/articles/200392126-using-the-library-view/) et [Jellyfin](https://jellyfin.org/docs/general/server/libraries/). Ici, tout reste dans une application locale.
