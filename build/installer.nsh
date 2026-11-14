# 覆盖安装：检测到旧版本时沿用原安装目录，避免新旧版本并存。
# 扫描结果和设置保存在 %LOCALAPPDATA%\DiskOrganizer，安装程序不会修改或删除。
!macro customInit
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R9 != ""
  ${AndIf} ${FileExists} "$R9\*.*"
    StrCpy $INSTDIR $R9
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION|MB_SETFOREGROUND "检测到已安装的旧版本，将覆盖安装到：$\r$\n$INSTDIR$\r$\n$\r$\n之前的扫描结果和设置会保留。"
    ${EndIf}
  ${EndIf}
!macroend
