param(
  [int]$BackendPort = 8000,
  [int]$GatewayPort = 8001,
  [int]$TunnelTimeoutSeconds = 90,
  [int]$TunnelMaxAttempts = 4,
  [switch]$KeepExistingPortProcesses,
  [switch]$CleanupOnly
)

$ErrorActionPreference = "Stop"

function Resolve-ProjectRoot {
  if (Test-Path -LiteralPath ".\.venv\Scripts\python.exe") {
    return (Get-Location).Path
  }
  $scriptRoot = Split-Path -Parent $PSCommandPath
  if (Test-Path -LiteralPath (Join-Path $scriptRoot ".venv\Scripts\python.exe")) {
    return $scriptRoot
  }
  throw "프로젝트 루트에서 실행해 주세요. 예: cd E:\AI\IMMS-AI"
}

function Start-LoggedProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$LogDirectory
  )

  $runId = if ($script:DemoTunnelRunId) { $script:DemoTunnelRunId } else { Get-Date -Format "yyyyMMdd-HHmmss" }
  $stdoutPath = Join-Path $LogDirectory "$Name.$runId.out.log"
  $stderrPath = Join-Path $LogDirectory "$Name.$runId.err.log"

  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

  return [pscustomobject]@{
    Name = $Name
    Process = $process
    Stdout = $stdoutPath
    Stderr = $stderrPath
  }
}

function Get-ChildProcessIds {
  param([int]$ParentProcessId)

  $ids = @()
  try {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentProcessId" -ErrorAction SilentlyContinue)
  } catch {
    return $ids
  }

  foreach ($child in $children) {
    $childId = [int]$child.ProcessId
    $ids += Get-ChildProcessIds -ParentProcessId $childId
    $ids += $childId
  }
  return $ids
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [string]$Label = ""
  )

  if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
    return
  }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) {
    return
  }

  $displayName = if ($Label) { $Label } else { "$($process.ProcessName) (PID $ProcessId)" }
  $ids = @(Get-ChildProcessIds -ParentProcessId $ProcessId)
  $ids += $ProcessId
  $ids = @($ids | Where-Object { $_ -and $_ -ne $PID } | Select-Object -Unique)

  foreach ($id in $ids) {
    try {
      $target = Get-Process -Id $id -ErrorAction Stop
      Stop-Process -Id $id -Force -ErrorAction Stop
      Write-Host "Stopped $($target.ProcessName) (PID $id) for $displayName"
    } catch {
      Write-Warning "Failed to stop PID $id for $displayName with Stop-Process: $($_.Exception.Message)"
    }
  }

  Start-Sleep -Milliseconds 300
  $remaining = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($remaining.Count -eq 0) {
    return
  }

  $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
  if ($taskkill) {
    foreach ($id in $remaining) {
      try {
        & $taskkill.Source /PID $id /T /F | Out-Null
        Write-Host "Stopped PID $id with taskkill for $displayName"
      } catch {
        Write-Warning "taskkill failed for PID $id in ${displayName}: $($_.Exception.Message)"
      }
    }

    Start-Sleep -Milliseconds 300
    $remaining = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) {
      return
    }
  }

  Write-Warning "Some processes for $displayName are still running. PowerShell may need administrator permission."
}

function Stop-PortListeners {
  param([int[]]$Ports)

  $listeners = Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $ownerProcessId = [int]$listener.OwningProcess
    if ($ownerProcessId -le 0 -or $ownerProcessId -eq $PID) {
      continue
    }

    try {
      $process = Get-Process -Id $ownerProcessId -ErrorAction Stop
      Write-Host "Stopping existing listener on port $($listener.LocalPort): $($process.ProcessName) (PID $ownerProcessId)"
      Stop-ProcessTree -ProcessId $ownerProcessId -Label "port $($listener.LocalPort)"
    } catch {
      Write-Warning "Failed to stop process on port $($listener.LocalPort) (PID $ownerProcessId): $($_.Exception.Message)"
    }
  }
}

function Read-LogText {
  param([string[]]$Paths)

  $chunks = @()
  foreach ($path in $Paths) {
    if (Test-Path -LiteralPath $path) {
      $chunks += Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
    }
  }
  return ($chunks -join "`n")
}

function Wait-TunnelUrl {
  param(
    [string]$Name,
    [string[]]$LogPaths,
    [int]$TimeoutSeconds,
    [object]$Process = $null
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $text = Read-LogText -Paths $LogPaths
    $match = [regex]::Match($text, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
    if ($match.Success) {
      return $match.Value
    }
    if ($text -match "failed to unmarshal quick Tunnel|Error unmarshaling QuickTunnel response|Internal Server Error") {
      Write-Warning "$Name tunnel quick tunnel 요청이 실패했습니다. 재시도합니다."
      return ""
    }
    if ($Process -and $Process.HasExited) {
      Start-Sleep -Milliseconds 300
      $text = Read-LogText -Paths $LogPaths
      $match = [regex]::Match($text, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
      if ($match.Success) {
        return $match.Value
      }
      Write-Warning "$Name tunnel 프로세스가 URL 생성 전에 종료되었습니다. 재시도합니다."
      return ""
    }
    Start-Sleep -Milliseconds 500
  }

  $recentLog = Read-LogText -Paths $LogPaths
  Write-Warning "$Name tunnel 주소를 $TimeoutSeconds초 안에 찾지 못했습니다."
  if ($recentLog) {
    Write-Host "---- $Name tunnel log preview ----"
    Write-Host ($recentLog.Split("`n") | Select-Object -Last 20) -Separator "`n"
  }
  return ""
}

function Start-TunnelWithRetry {
  param(
    [string]$Name,
    [int]$Port,
    [string]$CloudflaredPath,
    [string]$WorkingDirectory,
    [string]$LogDirectory,
    [int]$TimeoutSeconds,
    [int]$MaxAttempts
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    if ($attempt -gt 1) {
      $delaySeconds = [Math]::Min(8, 2 * $attempt)
      Write-Host "Retrying $Name tunnel ($attempt/$MaxAttempts) after ${delaySeconds}s..."
      Start-Sleep -Seconds $delaySeconds
    }

    Write-Host "Starting Cloudflare tunnel for $Name..."
    $tunnelProcess = Start-LoggedProcess `
      -Name "$Name-tunnel" `
      -FilePath $CloudflaredPath `
      -ArgumentList @("tunnel", "--url", "http://localhost:$Port") `
      -WorkingDirectory $WorkingDirectory `
      -LogDirectory $LogDirectory

    $url = Wait-TunnelUrl `
      -Name $Name `
      -LogPaths @($tunnelProcess.Stdout, $tunnelProcess.Stderr) `
      -TimeoutSeconds $TimeoutSeconds `
      -Process $tunnelProcess.Process

    if ($url) {
      return [pscustomobject]@{
        Name = "$Name-tunnel"
        Process = $tunnelProcess.Process
        Stdout = $tunnelProcess.Stdout
        Stderr = $tunnelProcess.Stderr
        Url = $url
      }
    }

    if ($tunnelProcess.Process -and -not $tunnelProcess.Process.HasExited) {
      Stop-Process -Id $tunnelProcess.Process.Id -Force -ErrorAction SilentlyContinue
    }
  }

  throw "$Name tunnel 생성에 실패했습니다. Cloudflare quick tunnel이 일시적으로 500을 반환했을 수 있습니다."
}

function Wait-HttpReady {
  param(
    [string]$Name,
    [string]$Url,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) {
        Write-Host "$Name is ready: $Url"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "$Name health check failed: $Url"
}

function Test-CorsPreflight {
  param(
    [string]$Name,
    [string]$Url,
    [string]$Origin
  )

  try {
    $response = Invoke-WebRequest `
      -Uri $Url `
      -Method Options `
      -Headers @{
        "Origin" = $Origin
        "Access-Control-Request-Method" = "GET"
        "Access-Control-Request-Headers" = "authorization"
      } `
      -UseBasicParsing `
      -TimeoutSec 10

    $allowOrigin = $response.Headers["Access-Control-Allow-Origin"]
    if ($allowOrigin -eq $Origin) {
      Write-Host "$Name CORS preflight OK: $allowOrigin"
      return
    }

    Write-Warning "$Name CORS preflight did not return the expected origin. Expected=$Origin Actual=$allowOrigin"
  } catch {
    Write-Warning "$Name CORS preflight failed: $($_.Exception.Message)"
  }
}

function Stop-StartedProcesses {
  param([object[]]$Started)

  $items = @($Started | Where-Object { $_ -and $_.Process })
  [array]::Reverse($items)

  foreach ($item in $items) {
    try {
      Stop-ProcessTree -ProcessId $item.Process.Id -Label "$($item.Name) (PID $($item.Process.Id))"
    } catch {
      Write-Warning "Failed to stop $($item.Name): $($_.Exception.Message)"
    }
  }
}

function Invoke-DemoCleanup {
  param(
    [object[]]$Started,
    [int[]]$Ports,
    [switch]$ForcePorts
  )

  if ($script:CleanupStarted) {
    return
  }
  $script:CleanupStarted = $true

  Write-Host ""
  Write-Host "Cleaning up demo processes..."
  Stop-StartedProcesses -Started $Started

  if ($ForcePorts) {
    Stop-PortListeners -Ports $Ports
  }
}

$projectRoot = Resolve-ProjectRoot
Set-Location -LiteralPath $projectRoot

$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$logDir = Join-Path $projectRoot ".codex-temp\demo-tunnels"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$script:DemoTunnelRunId = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not $KeepExistingPortProcesses) {
  Stop-PortListeners -Ports @($BackendPort, $GatewayPort)
  Start-Sleep -Milliseconds 500
}

if ($CleanupOnly) {
  Write-Host "Cleanup only mode completed."
  exit 0
}

$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredCommand) {
  throw "cloudflared를 찾을 수 없습니다. cloudflared 설치 후 PATH에 추가해 주세요."
}

$started = @()
$script:CleanupStarted = $false

trap {
  Write-Warning "중단 요청을 받아 demo 프로세스를 정리합니다."
  Invoke-DemoCleanup -Started $started -Ports @($BackendPort, $GatewayPort) -ForcePorts:(-not $KeepExistingPortProcesses)
  break
}

try {
  Write-Host "Starting backend on http://localhost:$BackendPort ..."
  $backendProcess = Start-LoggedProcess `
    -Name "backend" `
    -FilePath $python `
    -ArgumentList @("-m", "uvicorn", "backend.api:app", "--host", "0.0.0.0", "--port", "$BackendPort", "--reload") `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir
  $started += $backendProcess

  Write-Host "Starting gateway on http://localhost:$GatewayPort ..."
  $gatewayProcess = Start-LoggedProcess `
    -Name "gateway" `
    -FilePath $python `
    -ArgumentList @("-m", "uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "$GatewayPort", "--reload") `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir
  $started += $gatewayProcess

  Start-Sleep -Seconds 2
  Wait-HttpReady -Name "backend" -Url "http://localhost:$BackendPort/api/health" -TimeoutSeconds 30
  Wait-HttpReady -Name "gateway" -Url "http://localhost:$GatewayPort/gateway/health" -TimeoutSeconds 30

  $gatewayTunnelProcess = Start-TunnelWithRetry `
    -Name "gateway" `
    -Port $GatewayPort `
    -CloudflaredPath $cloudflaredCommand.Source `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir `
    -TimeoutSeconds $TunnelTimeoutSeconds `
    -MaxAttempts $TunnelMaxAttempts
  $started += $gatewayTunnelProcess

  $backendTunnelProcess = Start-TunnelWithRetry `
    -Name "backend" `
    -Port $BackendPort `
    -CloudflaredPath $cloudflaredCommand.Source `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir `
    -TimeoutSeconds $TunnelTimeoutSeconds `
    -MaxAttempts $TunnelMaxAttempts
  $started += $backendTunnelProcess

  $gatewayTunnel = $gatewayTunnelProcess.Url
  $backendTunnel = $backendTunnelProcess.Url
  $gatewayBaseUrl = if ($gatewayTunnel) { "$gatewayTunnel/gateway" } else { "" }
  $gatewayWsUrl = if ($gatewayTunnel) { "$($gatewayTunnel -replace '^https://', 'wss://')/gateway/ws" } else { "" }

  if ($gatewayTunnel) {
    Test-CorsPreflight `
      -Name "gateway tunnel" `
      -Url "$gatewayTunnel/gateway/meetings" `
      -Origin "https://imms-ai.vercel.app"
  }

  Write-Host ""
  Write-Host "==== Demo Tunnel URLs ===="
  Write-Host "GATEWAY_TUNNEL_URL=$gatewayTunnel"
  Write-Host "BACKEND_TUNNEL_URL=$backendTunnel"
  Write-Host ""
  Write-Host "Vercel 환경변수에 넣을 때는 보통:"
  Write-Host "NEXT_PUBLIC_GATEWAY_URL=$gatewayBaseUrl"
  Write-Host "NEXT_PUBLIC_GATEWAY_WS_URL=$gatewayWsUrl"
  Write-Host "NEXT_PUBLIC_API_BASE_URL=$backendTunnel"
  Write-Host ""
  Write-Host "backend/gateway는 --reload로 실행 중입니다. Python 코드 변경은 이 창을 끄지 않으면 자동 반영됩니다."
  Write-Host "Cloudflare quick tunnel 링크는 이 창을 끄지 않는 동안 유지됩니다."
  Write-Host ""
  Write-Host "Logs: $logDir"
  Write-Host ""
  Read-Host "종료하려면 Enter를 누르세요. Ctrl+C를 눌러도 backend/gateway/tunnel 프로세스를 정리합니다"
} finally {
  Invoke-DemoCleanup -Started $started -Ports @($BackendPort, $GatewayPort) -ForcePorts:(-not $KeepExistingPortProcesses)
}
