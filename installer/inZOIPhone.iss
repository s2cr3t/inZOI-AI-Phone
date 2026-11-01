; inZOI AI Phone setup. Built by tools/build-installer.js, which defines AppVersion, StageDir,
; ModsDir, SeedsDir, IconFile and OutputDir:
;   ISCC /DAppVersion=2.32.0 /DStageDir=... /DModsDir=... /DSeedsDir=... /DIconFile=... /DOutputDir=... installer\inZOIPhone.iss
;
; Installs for the current Windows user only (no administrator rights):
;   program  {userpf}\inZOI AI Phone            (%LOCALAPPDATA%\Programs\inZOI AI Phone)
;   data     %LOCALAPPDATA%\inZOI AI Phone      (settings, encrypted API keys, logs; kept on update)
;   mods     the phone mod and the Lua mod, into every folder each one already has under
;            Documents\inZOI\Mods (up to four), else Documents\inZOI\Mods\InGame\<modId>. Their program files
;            are always replaced; files the game and the service write there (conversations,
;            Moments, phone settings) are not in the setup and stay. Uninstalling
;            leaves the mods, as before.
; Starts at sign-in through HKCU\...\Run, and right after setup.

#ifndef AppVersion
  #error AppVersion must be defined (run tools/build-installer.js)
#endif
#ifndef StageDir
  #error StageDir must be defined (run tools/build-installer.js)
#endif
#ifndef ModsDir
  #error ModsDir must be defined (run tools/build-installer.js)
#endif
#ifndef SeedsDir
  #error SeedsDir must be defined (run tools/build-installer.js)
#endif

#define AppName "inZOI AI Phone"
#define AppExe "inZOIPhone.exe"
#define RunValue "inZOI AI Phone"
#define PhoneMod "HouseholdBoard_I6IXIO"
#define JournalMod "HouseholdJournal_N4CZ4Z"

[Setup]
AppId={{AEDC2E5A-BEC0-4528-81C2-85B788E65F3B}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
DefaultDirName={userpf}\{#AppName}
DisableDirPage=yes
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=inZOI-AI-Phone-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=auto
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimp.StartNow=立即启动 inZOI AI 手机服务
english.StartNow=Start inZOI AI Phone Service now
chinesesimp.ShortcutName=inZOI AI 手机
english.ShortcutName=inZOI AI Phone
chinesesimp.UninstallShortcut=卸载 inZOI AI 手机
english.UninstallShortcut=Uninstall inZOI AI Phone
chinesesimp.ModsUpdated=手机 mod 和配套 Lua mod 已更新到 {#AppVersion}：%n%n%1%n%n聊天记录、朋友圈和手机设置都保留了。如果 inZOI 正开着，请重启游戏，新版手机才会生效。
english.ModsUpdated=The phone mod and the companion Lua mod are updated to {#AppVersion}:%n%n%1%n%nConversations, Moments and phone settings are kept. If inZOI is running, restart it to load the new phone.
chinesesimp.ModsDuplicated=这台电脑上有不止一份同一个 mod，游戏只会加载其中一份：%n%n%1%n%n能更新的副本都已更新到 {#AppVersion}，AI 手机服务会自动使用游戏正在加载的那一份。建议退出游戏后只保留 Mods\InGame 里的那份，把其余的移出 Mods 文件夹。
english.ModsDuplicated=A mod is on this PC more than once; the game loads only one copy:%n%n%1%n%nThe copies that could be are updated to {#AppVersion}, and AI Phone Service uses the copy the game loads. Close the game and keep only the one in Mods\InGame; move the others out of the Mods folder.
chinesesimp.CopyNotUpdated=（未更新：副本太多）
english.CopyNotUpdated=(not updated: too many copies)
chinesesimp.Ready=安装完成后，进入游戏打开手机里的 AI 应用，选择模型服务商并粘贴 API Key 即可。
english.Ready=After setup, open the AI app on the in-game phone, pick a provider and paste your API key.
chinesesimp.DeleteData=是否同时删除 inZOI AI 手机的设置、已保存的 API Key、聊天记忆和日志？%n%n如果以后还会重新安装，建议选择“否”保留。
english.DeleteData=Also delete the settings, saved API keys, chat memory and logs of inZOI AI Phone?%n%nChoose No if you may install it again later.
chinesesimp.StopFailed=无法停止正在运行的 inZOI AI 手机服务。请先退出游戏后重试。
english.StopFailed=The running inZOI AI Phone Service could not be stopped. Close the game and try again.

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; The mods: program files always replace the installed ones; seeds only fill in what is missing.
Source: "{#ModsDir}\{#PhoneMod}\*"; DestDir: "{code:ModDir|{#PhoneMod}}"; Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#PhoneMod}\*"; DestDir: "{code:ModDir|{#PhoneMod}}"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
Source: "{#ModsDir}\{#JournalMod}\*"; DestDir: "{code:ModDir|{#JournalMod}}"; Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#JournalMod}\*"; DestDir: "{code:ModDir|{#JournalMod}}"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
; Further copies of a mod already on the PC (unpacked by hand, from a mod manager) are updated as
; well: the game loads only one of them, and it must never be an old one.
Source: "{#ModsDir}\{#PhoneMod}\*"; DestDir: "{code:ModCopy|P1}"; Check: HasModCopy('P1'); Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#PhoneMod}\*"; DestDir: "{code:ModCopy|P1}"; Check: HasModCopy('P1'); Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
Source: "{#ModsDir}\{#PhoneMod}\*"; DestDir: "{code:ModCopy|P2}"; Check: HasModCopy('P2'); Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#PhoneMod}\*"; DestDir: "{code:ModCopy|P2}"; Check: HasModCopy('P2'); Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
Source: "{#ModsDir}\{#PhoneMod}\*"; DestDir: "{code:ModCopy|P3}"; Check: HasModCopy('P3'); Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#PhoneMod}\*"; DestDir: "{code:ModCopy|P3}"; Check: HasModCopy('P3'); Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
Source: "{#ModsDir}\{#JournalMod}\*"; DestDir: "{code:ModCopy|J1}"; Check: HasModCopy('J1'); Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#JournalMod}\*"; DestDir: "{code:ModCopy|J1}"; Check: HasModCopy('J1'); Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
Source: "{#ModsDir}\{#JournalMod}\*"; DestDir: "{code:ModCopy|J2}"; Check: HasModCopy('J2'); Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#JournalMod}\*"; DestDir: "{code:ModCopy|J2}"; Check: HasModCopy('J2'); Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist
Source: "{#ModsDir}\{#JournalMod}\*"; DestDir: "{code:ModCopy|J3}"; Check: HasModCopy('J3'); Flags: ignoreversion recursesubdirs createallsubdirs uninsneveruninstall
Source: "{#SeedsDir}\{#JournalMod}\*"; DestDir: "{code:ModCopy|J3}"; Check: HasModCopy('J3'); Flags: onlyifdoesntexist recursesubdirs createallsubdirs uninsneveruninstall skipifsourcedoesntexist

[InstallDelete]
; Program files of an older version; data lives elsewhere and is never touched here.
Type: filesandordirs; Name: "{app}\app"
; The Music app is gone: its song cache, chart, covers, login QR code and liked songs in every copy
; of the phone mod, and the Edge profile that held the NetEase login. PrepareToInstall has already
; stopped the old service, which closes that Edge window first.
Type: filesandordirs; Name: "{code:ModDir|{#PhoneMod}}\ui\phone\music"
Type: files; Name: "{code:ModDir|{#PhoneMod}}\ui\phone\saved\music.cfg"
Type: filesandordirs; Name: "{code:ModCopy|P1}\ui\phone\music"; Check: HasModCopy('P1')
Type: files; Name: "{code:ModCopy|P1}\ui\phone\saved\music.cfg"; Check: HasModCopy('P1')
Type: filesandordirs; Name: "{code:ModCopy|P2}\ui\phone\music"; Check: HasModCopy('P2')
Type: files; Name: "{code:ModCopy|P2}\ui\phone\saved\music.cfg"; Check: HasModCopy('P2')
Type: filesandordirs; Name: "{code:ModCopy|P3}\ui\phone\music"; Check: HasModCopy('P3')
Type: files; Name: "{code:ModCopy|P3}\ui\phone\saved\music.cfg"; Check: HasModCopy('P3')
Type: filesandordirs; Name: "{localappdata}\{#AppName}\data\music-browser"

[Icons]
Name: "{userprograms}\{cm:ShortcutName}"; Filename: "{app}\{#AppExe}"; Parameters: "--open"; WorkingDir: "{app}"; Comment: "{cm:Ready}"
Name: "{userprograms}\{cm:UninstallShortcut}"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#RunValue}"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "--open"; Description: "{cm:StartNow}"; Flags: postinstall nowait skipifsilent
Filename: "{app}\{#AppExe}"; Flags: nowait runhidden; Check: WizardSilent

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"

[Code]
const
  MaxModDepth = 3;
  // [Files] has entries for this many copies of each mod.
  MaxModCopies = 4;

// Every folder holding <ModId>.uplugin, searched as deep as the service does (lib/paths.js).
procedure CollectMods(Dir: String; ModId: String; Depth: Integer; List: TStringList);
var
  FindRec: TFindRec;
begin
  if FileExists(AddBackslash(Dir) + ModId + '.uplugin') then
  begin
    List.Add(RemoveBackslash(Dir));
    exit;
  end;
  if Depth >= MaxModDepth then exit;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then
  begin
    try
      repeat
        if ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and
           ((FindRec.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) = 0) and
           (FindRec.Name <> '.') and (FindRec.Name <> '..') then
          CollectMods(AddBackslash(Dir) + FindRec.Name, ModId, Depth + 1, List);
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

var
  PhoneCopies: TStringList;
  JournalCopies: TStringList;

// The folders a mod goes to, looked up once per setup: every folder it is already in, the one in
// Documents\inZOI\Mods\InGame first; else just Documents\inZOI\Mods\InGame\<ModId>.
function LoadCopies(ModId: String): TStringList;
var
  Mods, Standard, S: String;
  I: Integer;
begin
  Result := TStringList.Create;
  Mods := ExpandConstant('{userdocs}\inZOI\Mods');
  Standard := Mods + '\InGame\' + ModId;
  if DirExists(Mods) then CollectMods(Mods, ModId, 0, Result);
  for I := 1 to Result.Count - 1 do
    if CompareText(Result[I], Standard) = 0 then
    begin
      S := Result[I];
      Result.Delete(I);
      Result.Insert(0, S);
      break;
    end;
  if Result.Count = 0 then Result.Add(Standard);
end;

function CopiesOf(ModId: String): TStringList;
begin
  if ModId = '{#PhoneMod}' then
  begin
    if PhoneCopies = nil then PhoneCopies := LoadCopies(ModId);
    Result := PhoneCopies;
  end else begin
    if JournalCopies = nil then JournalCopies := LoadCopies(ModId);
    Result := JournalCopies;
  end;
end;

function ModDir(ModId: String): String;
begin
  Result := CopiesOf(ModId)[0];
end;

// Param 'P1'..'P3' (phone mod) or 'J1'..'J3' (Lua mod): that further copy.
function CopiesOfParam(Param: String): TStringList;
begin
  if Copy(Param, 1, 1) = 'P' then Result := CopiesOf('{#PhoneMod}') else Result := CopiesOf('{#JournalMod}');
end;

function HasModCopy(Param: String): Boolean;
begin
  Result := StrToInt(Copy(Param, 2, 1)) < CopiesOfParam(Param).Count;
end;

function ModCopy(Param: String): String;
var
  List: TStringList;
  I: Integer;
begin
  List := CopiesOfParam(Param);
  I := StrToInt(Copy(Param, 2, 1));
  if I < List.Count then Result := List[I] else Result := List[0];
end;

function CopiesText(List: TStringList): String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to List.Count - 1 do
  begin
    if Result <> '' then Result := Result + #13#10;
    Result := Result + List[I];
    if I >= MaxModCopies then Result := Result + ' ' + CustomMessage('CopyNotUpdated');
  end;
end;

// Stops a running copy (guardian and reply service) so its files can be replaced.
function StopRunning(Exe: String): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if not FileExists(Exe) then exit;
  Result := Exec(Exe, '--stop', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopRunning(ExpandConstant('{app}\{#AppExe}')) then
    Result := CustomMessage('StopFailed');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep <> ssPostInstall) or WizardSilent then exit;
  MsgBox(FmtMessage(CustomMessage('ModsUpdated'), [ModDir('{#PhoneMod}') + #13#10 + ModDir('{#JournalMod}')]), mbInformation, MB_OK);
  if (CopiesOf('{#PhoneMod}').Count > 1) or (CopiesOf('{#JournalMod}').Count > 1) then
    MsgBox(FmtMessage(CustomMessage('ModsDuplicated'), [CopiesText(CopiesOf('{#PhoneMod}')) + #13#10 + CopiesText(CopiesOf('{#JournalMod}'))]), mbInformation, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep <> usPostUninstall then exit;
  Data := ExpandConstant('{localappdata}\{#AppName}');
  if not DirExists(Data) then exit;
  if UninstallSilent then exit;
  if MsgBox(CustomMessage('DeleteData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(Data, True, True, True);
end;
