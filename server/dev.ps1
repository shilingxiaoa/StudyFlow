# 本机启动 / 第一次安装依赖：在 server 目录下执行
#   powershell -ExecutionPolicy Bypass -File .\dev.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$venv = Join-Path $PSScriptRoot '.venv'
$py = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $py)) {
  Write-Host '[1/3] creating venv ...' -ForegroundColor Cyan
  python -m venv $venv
  & $py -m pip install --quiet --upgrade pip
  Write-Host '[2/3] installing requirements ...' -ForegroundColor Cyan
  & $py -m pip install --quiet -r requirements.txt
} else {
  Write-Host '[1/3] venv exists, skip install' -ForegroundColor DarkGray
}

$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

Write-Host ''
Write-Host '  本机:      http://127.0.0.1:8000/healthz' -ForegroundColor Green
Write-Host '  同一 WiFi 的手机:  ' -NoNewline -ForegroundColor Green
foreach ($ip in $ips) { Write-Host "http://${ip}:8000/healthz" -ForegroundColor Green }
Write-Host '  接口文档:  http://127.0.0.1:8000/docs' -ForegroundColor DarkGray
Write-Host '  (第一次被手机访问时 Windows 会弹防火墙提示，选「允许」)' -ForegroundColor DarkGray
Write-Host ''

& $py -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
