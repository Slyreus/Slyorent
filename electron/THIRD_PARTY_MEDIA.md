# Moteur média local

Slyorrent utilise en local FFmpeg et FFprobe 9.0.2, build Gyan Essentials,
distribués sous licence GPL-3.0-or-later.

- Binaires et configuration : https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- Code source exact : https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- FFmpeg : https://ffmpeg.org/

Sous Windows x64, l'application refuse de démarrer le moteur média si les
empreintes SHA-256 des exécutables ne correspondent pas aux valeurs épinglées
dans `media-binaries.mjs`. Les processus sont lancés sans shell, sans entrée
standard et sans accès réseau demandé par l'application.
