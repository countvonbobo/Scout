#ifndef MyAppVersion
  #define MyAppVersion "0.1.0-beta.21"
#endif

#ifndef StageDir
  #define StageDir "..\dist\release\stage"
#endif

#define MyAppName "Scout"
#define MyAppPublisher "Scout contributors"
#define MyAppExeName "Scout.exe"

[Setup]
AppId={{1A8566F8-806A-4E97-9B74-E0941139DB0C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Scout
DefaultGroupName=Scout
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=Scout-{#MyAppVersion}-windows-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\ui\assets\scout-icon.ico
UninstallDisplayName=Scout
LicenseFile={#StageDir}\app\LICENSE
ChangesEnvironment=no

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\Scout.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Scout"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{userdesktop}\Scout"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Scout"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove any payload residue that Inno could not associate with the final
; installation pass (for example unchanged dependency files after an upgrade).
; The private workspace is always outside {app} and is deliberately untouched.
Type: filesandordirs; Name: "{app}\app"

[UninstallRun]
Filename: "{app}\runtime\ScoutRuntime.exe"; Parameters: """{app}\app\tools\remote-access.mjs"""; Flags: runhidden skipifdoesntexist; RunOnceId: "RemoveScoutRemoteAccess"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""\Scout\Scout Host"" /F"; Flags: runhidden; RunOnceId: "RemoveScoutScheduledStartup"
Filename: "{sys}\reg.exe"; Parameters: "delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Scout /f"; Flags: runhidden; RunOnceId: "RemoveScoutLegacyStartup"

; The private workspace is deliberately outside {app}. The uninstaller therefore
; removes application files only and never deletes Documents\Scout Workspace or
; a custom SCOUT_WORKSPACE location.
