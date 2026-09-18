param(
  [Parameter(Mandatory = $true)][string]$TunnelId,
  [string]$TunnelExe = 'tunnel-client',
  [string]$TokenFile = (Join-Path $env:LOCALAPPDATA 'DesireCoreMcp\token')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $TokenFile)) { throw '先启动 MCP HTTP 服务以生成本机 token' }
$secureKey = Read-Host 'OpenAI Tunnel 专用运行 key（Tunnels Read + Use）' -AsSecureString
try {
  $env:CONTROL_PLANE_TUNNEL_ID = $TunnelId
  $env:CONTROL_PLANE_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
  $env:MCP_SERVER_URL = 'http://127.0.0.1:9333/mcp'
  $env:DESIRECORE_MCP_AUTHORIZATION = 'Bearer ' + (Get-Content -Raw -LiteralPath $TokenFile).Trim()
  $env:MCP_EXTRA_HEADERS = 'Authorization: env:DESIRECORE_MCP_AUTHORIZATION'
  $env:MCP_DISCOVERY_EXTRA_HEADERS = 'Authorization: env:DESIRECORE_MCP_AUTHORIZATION'
  $env:HEALTH_LISTEN_ADDR = '127.0.0.1:9334'
  & $TunnelExe run
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client 退出码：$LASTEXITCODE" }
} finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:DESIRECORE_MCP_AUTHORIZATION -ErrorAction SilentlyContinue
  $secureKey.Dispose()
}
