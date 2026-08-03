; ModList-Weaver Inno Setup 安装包脚本
; 用法（本地）：
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DMyAppVersion=3.6.5 installer.iss
; 产物：output\ModList-Weaver-Windows-<版本>-setup.exe
; 说明：每用户安装（%LocalAppData%\ModList-Weaver），无需管理员权限；
;       app 的 settings/cache 存放在安装目录旁（backend.settings），可正常读写。
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppName "ModList-Weaver"
#define MyAppExeName "ModList-Weaver.exe"

[Setup]
AppId={{0BEC4055-6F2B-42BB-8CDA-9A834BDCD52D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=ModList-Weaver
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename={#MyAppName}-Windows-{#MyAppVersion}-setup
SetupIconFile=assets\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=115

[Languages]
Name: "chinese"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
Source: "dist\{#MyAppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent
