param(
    [string]$Installer,
    [switch]$CompleteOnHosted,
    [string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (!$Installer) {
    $version = (Get-Content -Raw -Encoding utf8 (Join-Path $project 'package.json') | ConvertFrom-Json).version
    $Installer = Join-Path $project "release/ChatDS-$version-x64.exe"
}
$Installer = (Get-Item -LiteralPath $Installer).FullName
$userData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'ChatDS'
if ($CompleteOnHosted) {
    if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
        !$InstallDirectory -or (Test-Path -LiteralPath $InstallDirectory) -or (Test-Path -LiteralPath $userData)) {
        throw 'Completing an installation requires an unused destination and fresh profile on a disposable GitHub-hosted Windows runner.'
    }
    $dest = [IO.Path]::GetFullPath($InstallDirectory)
    if ([IO.Path]::GetDirectoryName($dest) -ne [IO.Path]::GetFullPath($env:RUNNER_TEMP) -or [IO.Path]::GetFileName($dest) -notmatch '^ChatDS Acceptance [0-9a-f]{32}$') {
        throw 'Unexpected hosted installation destination.'
    }
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
if (!('ChatDSWizardNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ChatDSWizardNative {
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, int message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr w, IntPtr l);
    [DllImport("user32.dll",EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr hwnd,int index);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int capacity);
    [DllImport("user32.dll",EntryPoint="SendMessageW",CharSet=CharSet.Unicode)] static extern IntPtr SendText(IntPtr hwnd,int message,IntPtr w,string value);
    [DllImport("user32.dll",EntryPoint="SendMessageW",CharSet=CharSet.Unicode)] static extern IntPtr ReadText(IntPtr hwnd,int message,IntPtr w,StringBuilder value);
    public static string ClassName(IntPtr hwnd) { var name=new StringBuilder(64); GetClassName(hwnd,name,name.Capacity); return name.ToString(); }
    public static string Text(IntPtr hwnd) { var value=new StringBuilder(8192); ReadText(hwnd,13,(IntPtr)value.Capacity,value); return value.ToString(); }
    public static void SetText(IntPtr hwnd,string text) { SendText(hwnd,12,IntPtr.Zero,text); }
}
'@
}
function Await-Result([scriptblock]$Test, [string]$Description, [int]$Seconds = 15) {
    $until = [datetime]::UtcNow.AddSeconds($Seconds)
    do {
        $observed = & $Test
        if ($null -ne $observed -and $observed) { return $observed }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $until)
    throw "Installer verification timed out waiting for $Description."
}
function Get-Dialog {
    $setup.Refresh()
    if ($setup.HasExited) { throw "Installer exited with code $($setup.ExitCode) before its expected page." }
    if ($setup.MainWindowHandle -ne [IntPtr]::Zero) {
        return [Windows.Automation.AutomationElement]::FromHandle($setup.MainWindowHandle)
    }
}
function Get-Widgets($Root) {
    return $Root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
}
function Find-Widget($Root, [string]$TypeName, [string]$Text) {
    foreach ($item in (Get-Widgets $Root)) {
        $handle = [IntPtr]$item.Current.NativeWindowHandle
        if (!$item.Current.NativeWindowHandle -or ![ChatDSWizardNative]::IsWindowVisible($handle)) { continue }
        if ($Text -and $item.Current.Name -notlike "*$Text*") { continue }
        if ($item.Current.ControlType.ProgrammaticName -eq "ControlType.$TypeName") { return $item }
        # Some NSIS controls are exposed by Windows UIA's HWND provider as generic panes.
        $nativeClass = [ChatDSWizardNative]::ClassName($handle)
        if ($TypeName -eq 'Edit' -and $nativeClass -eq 'Edit') { return $item }
        if ($nativeClass -ne 'Button') { continue }
        $kind = [ChatDSWizardNative]::GetWindowLong($handle,-16) -band 15
        if (($TypeName -eq 'RadioButton' -and $kind -in (4,9)) -or ($TypeName -eq 'CheckBox' -and $kind -in (2,3,5,6)) -or ($TypeName -eq 'Button' -and $kind -in (0,1))) { return $item }
    }
}
function Get-Button($Root, [int]$Id) {
    $h = [ChatDSWizardNative]::GetDlgItem([IntPtr]$Root.Current.NativeWindowHandle,$Id)
    if ($h -ne [IntPtr]::Zero -and [ChatDSWizardNative]::IsWindowEnabled($h) -and [ChatDSWizardNative]::IsWindowVisible($h)) { return [Windows.Automation.AutomationElement]::FromHandle($h) }
}
function Click-Widget($Item) {
    if (!$Item -or $Item.Current.ProcessId -ne $setup.Id -or !$Item.Current.IsEnabled) { throw 'The requested button is unavailable in the owned installer process.' }
    if (![ChatDSWizardNative]::PostMessage([IntPtr]$Item.Current.NativeWindowHandle,0xf5,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Installer button click failed.' }
}
function Invoke-WizardButton($Root, [int]$Id) {
    $button = Get-Button $Root $Id
    if (!$button -or $Root.Current.ProcessId -ne $setup.Id -or $button.Current.ProcessId -ne $setup.Id) {
        throw "The visible wizard button $Id is unavailable in the owned installer."
    }
    # The wizard runs in the background. BM_CLICK on its inactive default button can
    # return success without navigating. Deliver the button's normal BN_CLICKED
    # notification to its own parent, which still executes the NSIS page callbacks.
    $posted = [ChatDSWizardNative]::PostMessage([IntPtr]$Root.Current.NativeWindowHandle,0x111,[IntPtr]$Id,[IntPtr]$button.Current.NativeWindowHandle)
    if (!$posted) { throw "The installer did not receive wizard button $Id." }
}
function Checked($Item) {
    return [ChatDSWizardNative]::SendMessage([IntPtr]$Item.Current.NativeWindowHandle,0xf0,[IntPtr]::Zero,[IntPtr]::Zero) -eq [IntPtr]1
}
function Go-ToNapCat($Root) {
    for ($step = 0; $step -lt 6; $step++) {
        if (Find-Widget $Root 'RadioButton' '使用已经安装的 NapCat') { return }
        $next = Get-Button $Root 1
        # Never activate an Install, Repair, Remove or Finish button while looking for this page.
        if (!$next -or $next.Current.Name -notmatch 'Next|下一步') {
            throw "No safe pre-install Next button was found (button label '$($next.Current.Name)')."
        }
        Invoke-WizardButton $Root 1
        Start-Sleep -Milliseconds 350
    }
    throw 'The normal QQ setup page was not reached.'
}
function Select-Fixture($Root, [string]$Folder) {
    $radio = Find-Widget $Root 'RadioButton' '使用已经安装的 NapCat'
    $edit = Find-Widget $Root 'Edit' ''
    if (!$radio -or !$edit -or !(Find-Widget $Root 'Button' '选择目录')) { throw 'NapCat folder selection controls are missing.' }
    Click-Widget $radio
    $null = Await-Result { Checked $radio } 'selected local-folder radio button'
    [ChatDSWizardNative]::SetText([IntPtr]$edit.Current.NativeWindowHandle,$Folder)
    if ([ChatDSWizardNative]::Text([IntPtr]$edit.Current.NativeWindowHandle) -cne $Folder) { throw 'The selected folder was not retained in the visible input.' }
}
function Cancel-Wizard($Root) {
    Invoke-WizardButton $Root 2
    $pidCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,$setup.Id)
    $null = Await-Result {
        if ($setup.HasExited) { return $true }
        $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $pidCondition)
        foreach ($window in $windows) {
            if ($window.Current.NativeWindowHandle -eq $Root.Current.NativeWindowHandle) { continue }
            $yes = Get-Button $window 6
            if ($yes) { Invoke-WizardButton $window 6 }
        }
        return $setup.HasExited
    } 'installer cancellation'
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('chatds-test-installer-ui-' + [guid]::NewGuid().ToString('N'))
$fixture = Join-Path $scratch '自选 NapCat & QA'
$null = [IO.Directory]::CreateDirectory((Join-Path $fixture 'config'))
[IO.File]::WriteAllText((Join-Path $fixture 'QQ.exe'),'unused test placeholder')
[IO.File]::WriteAllText((Join-Path $fixture 'napcat.bat'),"@echo off`r`necho fixture>started.txt`r`n",[Text.Encoding]::ASCII)
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$portProbe.Start()
$privatePort = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
[IO.File]::WriteAllText((Join-Path $fixture 'config/webui.json'),('{"host":"127.0.0.1","port":' + $privatePort + ',"token":"fixture"}'))
$setup = $null
try {
    $target = if ($CompleteOnHosted) { $dest } else { Join-Path $scratch 'ChatDS Preview' }
    $setup = Start-Process -FilePath $Installer -ArgumentList "/currentuser /D=$target" -PassThru -WindowStyle Hidden
    # A full NSIS executable first displays a separate integrity-check/splash window.
    $root = Await-Result {
        $dialog = Get-Dialog
        if ($dialog -and (Get-Button $dialog 1)) { return $dialog }
    } 'first page of the owned NSIS wizard' 90
    Go-ToNapCat $root
    $download = Find-Widget $root 'RadioButton' '由 ChatDS 下载'
    if (!$download -or !(Checked $download)) { throw 'First entry did not default to the documented download option.' }
    Select-Fixture $root $fixture
    Invoke-WizardButton $root 3
    $null = Await-Result { !(Find-Widget $root 'RadioButton' '使用已经安装的 NapCat') } 'previous page'
    Go-ToNapCat $root
    $radio = Find-Widget $root 'RadioButton' '使用已经安装的 NapCat'
    $edit = Find-Widget $root 'Edit' ''
    if (!(Checked $radio) -or [ChatDSWizardNative]::Text([IntPtr]$edit.Current.NativeWindowHandle) -cne $fixture) {
        throw 'Going Back and returning to the QQ page lost the selected NapCat folder or radio choice.'
    }
    if (!$CompleteOnHosted) {
        Cancel-Wizard $root
        if (Test-Path -LiteralPath (Join-Path $target 'ChatDS.exe')) { throw 'Preview unexpectedly installed an application.' }
        Write-Output 'NSIS preview passed: default download, existing-directory selection, Back/Next persistence, cancellation before installation.'
        return
    }
    Invoke-WizardButton $root 1
    $ini = Join-Path $userData 'napcat-setup.ini'
    $null = Await-Result { Test-Path -LiteralPath $ini -PathType Leaf } 'the installed NapCat choice file' 150
    $null = Await-Result { Find-Widget $root 'CheckBox' 'ChatDS' } 'the finish-page app-launch checkbox'
    $run = Find-Widget $root 'CheckBox' 'ChatDS'
    if (Checked $run) { Click-Widget $run; $null = Await-Result { !(Checked $run) } 'cleared automatic launch' }
    Invoke-WizardButton $root 1
    if (!$setup.WaitForExit(15000) -or $setup.ExitCode -ne 0) { throw 'Interactive installer did not finish successfully.' }
    if (!(Test-Path -LiteralPath (Join-Path $dest 'resources/app.asar') -PathType Leaf)) {
        throw "The installed app.asar is missing at the requested destination: $dest."
    }
    $expected = "[NapCat]`r`naction=directory`r`ndirectory=$fixture`r`n"
    if ([IO.File]::ReadAllText($ini) -cne $expected) { throw 'Installed INI has an incorrect action, folder or Unicode encoding.' }
    # Run the installed app.asar with the actual INI, in an isolated profile. The separate
    # installed-binary first-chat check starts afterward with its original clean profile.
    $isolated = Join-Path $scratch 'ChatDS'
    $null = [IO.Directory]::CreateDirectory($isolated)
    Move-Item -LiteralPath $ini -Destination (Join-Path $isolated 'napcat-setup.ini')
    [IO.Directory]::Delete($userData, $false)
    $archiveMain = Join-Path $dest 'resources/app.asar/dist/desktop/main.js'
    $nodeCheck = @'
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {openDesktop} from './scripts/desktop-journey.mjs';
const [profile,entry,folder]=process.argv.slice(2);
const desktop=await openDesktop(profile,entry);
try {
  const end=Date.now()+30000;
  while(!existsSync(join(folder,'started.txt')) && Date.now()<end) await setTimeout(100);
  if(!existsSync(join(folder,'started.txt'))) {
    const state=await desktop.evaluate(async()=>{const s=await window.chatds.state();return {status:s.napcatInstallation?.status, guidance:s.napcatInstallation?.guidance};});
    throw new Error('Selected local launcher did not write its marker. '+JSON.stringify(state));
  }
  assert.equal((await readFile(join(folder,'started.txt'),'utf8')).trim(),'fixture');
  const saved=JSON.parse(await readFile(join(profile,'ChatDS','napcat-installation.json'),'utf8'));
  assert.equal(saved.directory,await realpath(folder),'First launch saved a different NapCat installation directory');
  assert.equal(existsSync(join(profile,'ChatDS','napcat-setup.ini')),false,'First launch left the installer choice unconsumed');
} finally {await desktop.close();}
'@
    Push-Location -LiteralPath $project
    try {
        $nodeReport = $nodeCheck | node --input-type=module - $scratch $archiveMain $fixture 2>&1
        if ($LASTEXITCODE -ne 0) {
            $detail = ($nodeReport | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
            throw "Installed first-launch NapCat handoff failed. $detail"
        }
    }
    finally { Pop-Location }
    Write-Output 'Interactive NSIS installation, Unicode INI, isolated first launch and harmless selected launcher passed.'
} catch {
    if ($env:GITHUB_ACTIONS -eq 'true') {
        $detail = $_.Exception.Message.Replace('%','%25').Replace([string][char]13,'%0D').Replace([string][char]10,'%0A')
        Write-Host "::error title=Windows installer acceptance::$detail"
    }
    throw
} finally {
    if ($setup -and !$setup.HasExited) { $setup.Kill(); $setup.WaitForExit(10000) | Out-Null }
    $actual = (Resolve-Path -LiteralPath $scratch).Path
    if ([IO.Path]::GetDirectoryName($actual) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.Path]::GetFileName($actual) -notmatch '^chatds-test-installer-ui-[0-9a-f]{32}$') {
        throw 'Refusing to remove an unexpected fixture directory.'
    }
    Remove-Item -LiteralPath $actual -Recurse -Force
}
