!macro customInstall
  ; libcurl intègre zlib depuis la 1.1.12.
  IfFileExists "$INSTDIR\resources\.runtime\engine\transmission-4.1.3\PFiles\Transmission\z.dll" 0 +2
  Delete "$INSTDIR\resources\.runtime\engine\transmission-4.1.3\PFiles\Transmission\z.dll"

  ; Proposer Slyorrent dans « Ouvrir avec » sans modifier le choix par défaut.
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent" "" "Fichier BitTorrent"
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent" "FriendlyTypeName" "Fichier BitTorrent"
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent\DefaultIcon" "" '$\"$INSTDIR\resources\slyorrent.ico$\",0'
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent\shell\open" "" "Ouvrir avec Slyorrent"
  WriteRegStr HKCU "Software\Classes\Slyorrent.Torrent\shell\open\command" "" '$\"$INSTDIR\Slyorrent.exe$\" $\"%1$\"'
  WriteRegNone HKCU "Software\Classes\.torrent\OpenWithProgids" "Slyorrent.Torrent"
  WriteRegStr HKCU "Software\Classes\Applications\Slyorrent.exe" "FriendlyAppName" "Slyorrent"
  WriteRegExpandStr HKCU "Software\Classes\Applications\Slyorrent.exe\DefaultIcon" "" '$\"$INSTDIR\resources\slyorrent.ico$\",0'
  WriteRegStr HKCU "Software\Classes\Applications\Slyorrent.exe\SupportedTypes" ".torrent" ""
  WriteRegStr HKCU "Software\Classes\Applications\Slyorrent.exe\shell\open\command" "" '$\"$INSTDIR\Slyorrent.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Slyorrent\Capabilities" "ApplicationName" "Slyorrent"
  WriteRegStr HKCU "Software\Slyorrent\Capabilities" "ApplicationDescription" "Client BitTorrent local"
  WriteRegStr HKCU "Software\Slyorrent\Capabilities" "ApplicationIcon" '$\"$INSTDIR\resources\slyorrent.ico$\",0'
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
