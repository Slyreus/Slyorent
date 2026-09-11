!macro customInstall
  ; Proposer Slyorrent dans « Ouvrir avec » sans modifier le choix par défaut.
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent" "" "Fichier BitTorrent"
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent" "FriendlyTypeName" "Fichier BitTorrent"
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent\DefaultIcon" "" '$\"$INSTDIR\Slyorrent.exe$\",0'
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent\shell\open" "" "Ouvrir avec Slyorrent"
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent\shell\open\command" "" '$\"$INSTDIR\Slyorrent.exe$\" $\"%1$\"'
  WriteRegNone HKCU "Software\Classes\.torrent\OpenWithProgids" "Slyorrent.Torrent"
  WriteRegStr HKCU "Software\Classes\Applications\Slyorrent.exe" "FriendlyAppName" "Slyorrent"
  WriteRegStr HKCU "Software\Classes\Applications\Slyorrent.exe\SupportedTypes" ".torrent" ""
  WriteRegStr HKCU "Software\Classes\Applications\Slyorrent.exe\shell\open\command" "" '$\"$INSTDIR\Slyorrent.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Slyorrent\Capabilities" "ApplicationName" "Slyorrent"
  WriteRegStr HKCU "Software\Slyorrent\Capabilities" "ApplicationDescription" "Client BitTorrent local"
  WriteRegStr HKCU "Software\Slyorrent\Capabilities\FileAssociations" ".torrent" "Slyorrent.Torrent"
  WriteRegStr HKCU "Software\RegisteredApplications" "Slyorrent" "Software\Slyorrent\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "Slyorrent.Torrent"
  DeleteRegKey HKCU "Software\Classes\Slyorrent.Torrent"
  DeleteRegKey HKCU "Software\Classes\Applications\Slyorrent.exe"
  DeleteRegKey HKCU "Software\Slyorrent\Capabilities"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Slyorrent"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
