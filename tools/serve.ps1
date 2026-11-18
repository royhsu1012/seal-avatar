<#
.SYNOPSIS
  零相依的本機靜態網頁伺服器（Windows PowerShell 5.1 即可執行）。
.DESCRIPTION
  不需要安裝 Python 或 Node。在專案根目錄執行：
    powershell -ExecutionPolicy Bypass -File tools\serve.ps1
  然後用瀏覽器開 http://localhost:8787/ 。按 Ctrl+C 停止。
.PARAMETER Port
  監聽的連接埠，預設 8787。
.PARAMETER Root
  要提供的資料夾，預設是本腳本所在資料夾的上一層（專案根目錄）。
#>
param(
  [int]$Port = 8787,
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$Root = (Resolve-Path $Root).Path.TrimEnd('\') + '\'
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.webp' = 'image/webp'
  '.json' = 'application/json; charset=utf-8'
  '.ico'  = 'image/x-icon'
  '.md'   = 'text/markdown; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.wasm' = 'application/wasm'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root"
Write-Host "Open   http://localhost:$Port/   (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
      if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $res.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes("404 Not Found: /$rel")
      } else {
        $ext = [IO.Path]::GetExtension($full).ToLower()
        if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($full)
      }
      $res.Headers.Add('Cache-Control', 'no-store')
      $res.ContentLength64 = $bytes.Length
      if ($req.HttpMethod -ne 'HEAD') {
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      Write-Host ("{0} {1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $res.StatusCode, $req.Url.PathAndQuery)
    } catch {
      Write-Warning $_
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
}
