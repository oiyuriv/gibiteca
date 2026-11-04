$port = 8803
$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
        $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.LocalPath.TrimStart('/'))
        if ($path -eq '') { $path = 'index.html' }
        $file = Join-Path $root $path
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ext = [System.IO.Path]::GetExtension($file).ToLower()
            $mime = switch ($ext) {
                '.html' {'text/html; charset=utf-8'} '.js' {'application/javascript; charset=utf-8'} '.css' {'text/css; charset=utf-8'}
                '.webmanifest' {'application/manifest+json'} '.json' {'application/json'} '.png' {'image/png'} '.jpg' {'image/jpeg'}
                '.svg' {'image/svg+xml'} '.cbz' {'application/vnd.comicbook+zip'} default {'application/octet-stream'}
            }
            $res.ContentType = $mime
            $res.Headers.Add('Cache-Control', 'no-cache')
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
        }
    } catch {
        $res.StatusCode = 500
    }
    $res.Close()
}
