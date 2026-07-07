!macro customInit
  ; Force-close any running Voxel Client processes before install so the
  ; installer never has to ask the user to close the app themselves.
  nsExec::Exec 'taskkill /F /IM "Voxel Client.exe" /T'
!macroend
