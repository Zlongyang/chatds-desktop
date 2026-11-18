$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Run the installer lifecycle on a disposable GitHub-hosted Windows runner.'
}
$version = (Get-Content -Raw -Encoding utf8 (Join-Path $PSScriptRoot '../package.json') | ConvertFrom-Json).version
$releaseDir = Join-Path $PSScriptRoot '../release'
$installer = Get-Item -LiteralPath (Join-Path $releaseDir "ChatDS-$version-x64.exe")
$programDir = Join-Path $env:RUNNER_TEMP ('ChatDS Acceptance ' + [guid]::NewGuid().ToString('N'))
$userData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'ChatDS'
if ((Test-Path -LiteralPath $userData) -or (Test-Path -LiteralPath $programDir)) {
    throw 'Installer acceptance requires a fresh ChatDS profile and installation directory.'
}
$binary = Join-Path $programDir 'ChatDS.exe'
$uninstall = Join-Path $programDir 'Uninstall ChatDS.exe'
$database = Join-Path $userData 'chatds.sqlite'
try {
    # NSIS requires the unquoted /D path to appear at the very end.
    $setup = Start-Process -FilePath $installer.FullName -ArgumentList "/S /currentuser /D=$programDir" -WindowStyle Hidden -PassThru
    if (!$setup.WaitForExit(120000) -or $setup.ExitCode -ne 0) { throw 'NSIS installation failed or timed out.' }
    if (!(Test-Path -LiteralPath $binary -PathType Leaf) -or !(Test-Path -LiteralPath $uninstall -PathType Leaf)) {
        throw 'NSIS did not install the executable and uninstaller at the chosen destination.'
    }
    & node (Join-Path $PSScriptRoot 'test-first-chat.mjs') $binary $userData
    if ($LASTEXITCODE -ne 0) { throw 'Installed first-chat acceptance failed.' }
} finally {
    if (Test-Path -LiteralPath $uninstall -PathType Leaf) {
        $remove = Start-Process -FilePath $uninstall -ArgumentList '/S /currentuser' -WindowStyle Hidden -PassThru
        if (!$remove.WaitForExit(120000) -or $remove.ExitCode -ne 0) { throw 'NSIS uninstallation failed or timed out.' }
        $deadline = (Get-Date).AddSeconds(45)
        while ((Test-Path -LiteralPath $binary) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        if (Test-Path -LiteralPath $binary) { throw 'Uninstallation left the application executable behind.' }
    }
}
& node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; import assert from 'node:assert/strict'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const chat=db.prepare('SELECT text FROM messages WHERE conv=? ORDER BY seq').all('desktop:owner').map(r=>r.text); assert.deepEqual(chat,['First desktop message','First desktop reply']); db.close();" $database
if ($LASTEXITCODE -ne 0) { throw 'First conversation was not preserved on uninstall.' }
Write-Output 'NSIS install, fresh first launch, model setup, first desktop chat and uninstall with history retained passed.'
