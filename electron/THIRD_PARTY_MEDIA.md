# Moteur média local

Slyorent utilise uniquement en local les paquets `ffmpeg-static@5.3.0` et
`@derhuerst/ffprobe-static@5.3.0`, distribués sous licence GPL-3.0-or-later.

- Projet et code source : https://github.com/eugeneware/ffmpeg-static
- FFmpeg : https://ffmpeg.org/

Sous Windows x64, l'application refuse de démarrer le moteur média si les
empreintes SHA-256 des exécutables ne correspondent pas aux valeurs épinglées
dans `media-adapter.mjs`. Les processus sont lancés sans shell, sans entrée
standard et sans accès réseau demandé par l'application.
