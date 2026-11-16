$ErrorActionPreference = 'Stop'
$starPort = 4318
if ($env:THINKSTAR_PORT) { $starPort = [int]$env:THINKSTAR_PORT }
if ($starPort -lt 1 -or $starPort -gt 65535) { throw 'Invalid Thinkstar port.' }
$starRoot = Split-Path -Parent $PSScriptRoot
$starRecord = Join-Path $starRoot "runtime-data\service\$starPort.json"
if (-not (Test-Path -LiteralPath $starRecord)) { exit 0 }
$starData = Get-Content -LiteralPath $starRecord -Raw | ConvertFrom-Json
if ($starData.token -notmatch '^[a-f0-9-]{36}$' -or [int]$starData.pid -le 0) { throw 'Invalid service identity.' }
$starProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$starData.pid)"
if ($starProcess) {
  $starExpectedScript = Join-Path $PSScriptRoot 'serve-memory-sea.js'
  if ($starData.script -ne $starExpectedScript -or $starProcess.ExecutablePath -ne $starData.executable -or
      -not $starProcess.CommandLine.Contains($starExpectedScript) -or
      -not $starProcess.CommandLine.Contains("--thinkstar-service=$($starData.token)")) {
    throw 'The PID belongs to a different process. It was not stopped.'
  }
  $starPipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', "thinkstar-$($starData.token)", [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $starPipe.Connect(3000)
    $starWriter = [System.IO.StreamWriter]::new($starPipe)
    $starWriter.AutoFlush = $true
    $starWriter.WriteLine([string]$starData.token)
    $starReader = [System.IO.StreamReader]::new($starPipe)
    if ($starReader.ReadLine() -ne 'stopping') { throw 'Stop request was not accepted.' }
  } finally { $starPipe.Dispose() }
  Wait-Process -Id ([int]$starData.pid) -Timeout 15 -ErrorAction SilentlyContinue
  if (Get-Process -Id ([int]$starData.pid) -ErrorAction SilentlyContinue) { throw 'The service is still stopping. Retry shortly.' }
}
Remove-Item -LiteralPath $starRecord -ErrorAction SilentlyContinue
