!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!macro customPageAfterChangeDir
Var qqSetupDialog
Var qqUseDownload
Var qqUseFolder
Var qqFolderEntry
Var qqFolderBrowse
Var qqFolder
Var qqChoice

Function NapCatChoiceChanged
  Pop $0
  ${NSD_GetState} $qqUseFolder $1
  ${If} $1 == ${BST_CHECKED}
    StrCpy $qqChoice "directory"
  ${Else}
    StrCpy $qqChoice "download"
  ${EndIf}
FunctionEnd

Function NapCatFolderChanged
  Pop $0
  ${NSD_GetText} $qqFolderEntry $qqFolder
FunctionEnd

Function SelectNapCatFolder
  Pop $0
  nsDialogs::SelectFolderDialog "选择已解压的 NapCat 安装目录" "$qqFolder"
  Pop $0
  ${If} $0 != error
    StrCpy $qqFolder $0
    ${NSD_SetText} $qqFolderEntry $0
    ${NSD_Check} $qqUseFolder
    StrCpy $qqChoice "directory"
  ${EndIf}
FunctionEnd

Function ChatDSQQSetupPage
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "连接普通 QQ" "选择 ChatDS 首次启动时使用的 NapCat。"
  nsDialogs::Create 1018
  Pop $qqSetupDialog
  ${If} $qqSetupDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "NapCat 使用本机 Windows QQ 客户端登录。安装完成后启动 ChatDS，用手机 QQ 扫码，即可连接。"
  Pop $0
  ${NSD_CreateRadioButton} 0 34u 100% 15u "由 ChatDS 下载并校验 NapCat Shell 4.18.42（约 35 MB）"
  Pop $qqUseDownload
  ${NSD_CreateRadioButton} 0 58u 100% 15u "使用已经安装的 NapCat"
  Pop $qqUseFolder
  ${NSD_CreateText} 10u 77u 72% 14u "$qqFolder"
  Pop $qqFolderEntry
  ${NSD_OnChange} $qqFolderEntry NapCatFolderChanged
  ${NSD_CreateButton} 78% 76u 22% 16u "选择目录…"
  Pop $qqFolderBrowse
  ${NSD_OnClick} $qqFolderBrowse SelectNapCatFolder
  ${NSD_OnClick} $qqUseFolder NapCatChoiceChanged
  ${NSD_OnClick} $qqUseDownload NapCatChoiceChanged
  ${If} $qqChoice == "directory"
    ${NSD_Check} $qqUseFolder
  ${Else}
    ${NSD_Check} $qqUseDownload
  ${EndIf}
  ${NSD_CreateLabel} 0 106u 100% 35u "下载来源为 GitHub 社区留档，ChatDS 会核对原发布包的 SHA-256。以后打开 ChatDS 会自动检查并启动已关联的 NapCat。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function ChatDSQQSetupLeave
  ${NSD_GetState} $qqUseFolder $0
  ${If} $0 == ${BST_CHECKED}
    ${NSD_GetText} $qqFolderEntry $qqFolder
    ${If} $qqFolder == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "请选择 NapCat 安装目录。"
      Abort
    ${EndIf}
    IfFileExists "$qqFolder\*.*" +3
    MessageBox MB_ICONEXCLAMATION|MB_OK "请选择有效的 NapCat 安装目录。"
    Abort
    StrCpy $qqChoice "directory"
  ${Else}
    StrCpy $qqChoice "download"
  ${EndIf}
FunctionEnd
  Page custom ChatDSQQSetupPage ChatDSQQSetupLeave
!macroend

!macro customInstall
  ${If} $qqChoice != ""
    SetShellVarContext current
    CreateDirectory "$APPDATA\ChatDS"
    FileOpen $0 "$APPDATA\ChatDS\napcat-setup.ini" w
    ${Unless} ${Errors}
      FileWriteUTF16LE /BOM $0 "[NapCat]$\r$\naction=$qqChoice$\r$\ndirectory=$qqFolder$\r$\n"
      FileClose $0
    ${EndUnless}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
