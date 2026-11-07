Electron passe en 45.2.3, Transmission en 4.1.4 et FFmpeg/FFprobe en 9.0.2. Les dépendances ont été mises à jour. L’audit npm ne signale plus de vulnérabilité, y compris dans les outils de développement. Le paquet officiel de Transmission contient encore OpenSSL 3.5.4 : ce point reste à corriger chez le fournisseur.

Protection affiche maintenant chaque problème avec le nom du transfert, la cause et le détail du moteur. On peut ouvrir le transfert, consulter le journal ou relancer le contrôle depuis l’alerte. Un disque plein ou un problème de dossier n’est plus confondu avec une détection antivirus.

Les longs noms de torrents pouvaient bloquer le déplacement après téléchargement avec l’erreur Windows 206. Le dossier ajouté par Slyorrent est désormais raccourci quand c’est possible. Pour les chemins qui restent longs, le rangement passe par le moteur de fichiers local. Les originaux restent en quarantaine jusqu’à confirmation du nouvel emplacement. Les fichiers existants ne sont pas remplacés. Un contrôle en échec attend une relance manuelle au lieu de recommencer en boucle.

Les noms des fichiers restent intacts et le partage attend toujours la vérification et le scan Defender. La conversion HDR vers SDR conserve aussi les bonnes informations de couleur avec le nouveau moteur média.

Pour la mise à jour, ferme Slyorrent et lance `Slyorrent-Setup-1.1.11.exe`. Les torrents, les réglages et le suivi restent en place. FFmpeg, FFprobe et Transmission sont inclus dans le setup.

L’installateur n’est pas encore signé : Windows peut afficher « éditeur inconnu ». Les empreintes sont dans `SHA256SUMS.txt`. Les archives de sources jointes ne sont pas nécessaires à l’installation.
