# Classement de la médiathèque

Le classement est local. Les titres et les saisons viennent des noms des fichiers et des torrents. Aucune recherche de jaquette, aucun envoi du catalogue et aucun déplacement de fichier.

La vue Titres rassemble les saisons d’une même série. Les variantes simples de ponctuation, de casse et d’accents sont rapprochées, ainsi que « and », « et » et « & ». Les années sont conservées pour distinguer les reprises d’un film. Des titres traduits ou très différents ne sont pas fusionnés automatiquement.

Un pack de films produit plusieurs titres. Les fichiers audio sont regroupés d’après leur torrent. Les copies d’un épisode restent visibles avec leur source ; la lecture enchaînée évite de rejouer les doublons. Le bouton Lire passe au premier épisode prêt et non vu, ou reprend le dernier épisode en cours.

La vue Liste affiche les fichiers, avec ou sans regroupement par titre ou torrent. Les catégories, favoris, états de visionnage, disponibilité, torrent et saison se combinent avec la recherche. « saison 2 épisode 3 » et « S02E03 » ciblent les mêmes numéros. La recherche ignore les accents et accepte plusieurs mots.

Le tri porte sur le titre, la date d’ajout du torrent, la dernière lecture connue ou la taille. Pour une fiche regroupée, la date la plus récente et la taille totale des fichiers affichés sont utilisées. Sans date fournie par le moteur, aucune date n’est inventée.

L’affichage, le regroupement, le tri et les favoris sont enregistrés dans `library-preferences.json`, dans le profil de l’application. Les filtres temporaires sont réinitialisés à la réouverture de la médiathèque. Un fichier de préférences illisible est conservé sans être écrasé. Le suivi reste dans son fichier existant, `watch-history.json`.

Les fichiers incomplets ou non validés restent visibles, mais leur lecture est verrouillée. « Dossiers et vérifications » conserve l’accès à Vérifier et analyser et au dossier de chaque torrent. Le nouveau classement ne modifie ni la quarantaine, ni Defender, ni les réglages de partage.

Les vues et filtres s’inspirent de la [bibliothèque Plex](https://support.plex.tv/articles/200392126-using-the-library-view/) et de la [séparation des contenus de Jellyfin](https://jellyfin.org/docs/general/server/libraries/), adaptés ici à une bibliothèque locale de torrents, sans serveur distant ni compte.
