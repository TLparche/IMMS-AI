param(
  [int]$BackendPort = 8000,
  [int]$GatewayPort = 8001,
  [int]$TunnelTimeoutSeconds = 90
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

  $stdoutPath = Join-Path $LogDirectory "$Name.out.log"
  $stderrPath = Join-Path $LogDirectory "$Name.err.log"
  if (Test-Path -LiteralPath $stdoutPath) { Remove-Item -LiteralPath $stdoutPath -Force }
  if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }

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
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $text = Read-LogText -Paths $LogPaths
    $match = [regex]::Match($text, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
    if ($match.Success) {
      return $match.Value
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

function Stop-StartedProcesses {
  param([object[]]$Started)

  foreach ($item in ($Started | Where-Object { $_ -and $_.Process -and -not $_.Process.HasExited })) {
    try {
      Stop-Process -Id $item.Process.Id -Force -ErrorAction Stop
      Write-Host "Stopped $($item.Name) (PID $($item.Process.Id))"
    } catch {
      Write-Warning "Failed to stop $($item.Name): $($_.Exception.Message)"
    }
  }
}

$projectRoot = Resolve-ProjectRoot
Set-Location -LiteralPath $projectRoot

$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredCommand) {
  throw "cloudflared를 찾을 수 없습니다. cloudflared 설치 후 PATH에 추가해 주세요."
}

$logDir = Join-Path $projectRoot ".codex-temp\demo-tunnels"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$started = @()

try {
  Write-Host "Starting backend on http://localhost:$BackendPort ..."
  $started += Start-LoggedProcess `
    -Name "backend" `
    -FilePath $python `
    -ArgumentList @("-m", "uvicorn", "backend.api:app", "--host", "0.0.0.0", "--port", "$BackendPort", "--reload") `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir

  Write-Host "Starting gateway on http://localhost:$GatewayPort ..."
  $started += Start-LoggedProcess `
    -Name "gateway" `
    -FilePath $python `
    -ArgumentList @("-m", "uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "$GatewayPort", "--reload") `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir

  Start-Sleep -Seconds 2

  Write-Host "Starting Cloudflare tunnel for gateway..."
  $started += Start-LoggedProcess `
    -Name "gateway-tunnel" `
    -FilePath $cloudflaredCommand.Source `
    -ArgumentList @("tunnel", "--url", "http://localhost:$GatewayPort") `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir

  Write-Host "Starting Cloudflare tunnel for backend..."
  $started += Start-LoggedProcess `
    -Name "backend-tunnel" `
    -FilePath $cloudflaredCommand.Source `
    -ArgumentList @("tunnel", "--url", "http://localhost:$BackendPort") `
    -WorkingDirectory $projectRoot `
    -LogDirectory $logDir

  $gatewayTunnel = Wait-TunnelUrl `
    -Name "gateway" `
    -LogPaths @((Join-Path $logDir "gateway-tunnel.out.log"), (Join-Path $logDir "gateway-tunnel.err.log")) `
    -TimeoutSeconds $TunnelTimeoutSeconds

  $backendTunnel = Wait-TunnelUrl `
    -Name "backend" `
    -LogPaths @((Join-Path $logDir "backend-tunnel.out.log"), (Join-Path $logDir "backend-tunnel.err.log")) `
    -TimeoutSeconds $TunnelTimeoutSeconds

  Write-Host ""
  Write-Host "==== Demo Tunnel URLs ===="
  Write-Host "GATEWAY_TUNNEL_URL=$gatewayTunnel"
  Write-Host "BACKEND_TUNNEL_URL=$backendTunnel"
  Write-Host ""
  Write-Host "Vercel 환경변수에 넣을 때는 보통:"
  Write-Host "NEXT_PUBLIC_GATEWAY_URL=$gatewayTunnel"
  if ($gatewayTunnel) {
    Write-Host "NEXT_PUBLIC_GATEWAY_WS_URL=$($gatewayTunnel -replace '^https://', 'wss://')/gateway/ws"
  } else {
    Write-Host "NEXT_PUBLIC_GATEWAY_WS_URL="
  }
  Write-Host "NEXT_PUBLIC_API_BASE_URL=$backendTunnel"
  Write-Host ""
  Write-Host "backend/gateway는 --reload로 실행 중입니다. Python 코드 변경은 이 창을 끄지 않으면 자동 반영됩니다."
  Write-Host "Cloudflare quick tunnel 링크는 이 창을 끄지 않는 동안 유지됩니다."
  Write-Host ""
  Write-Host "Logs: $logDir"
  Write-Host ""
  Read-Host "종료하려면 Enter를 누르세요. 이 스크립트가 띄운 backend/gateway/tunnel 프로세스를 정리합니다"
} finally {
  Stop-StartedProcesses -Started $started
}
