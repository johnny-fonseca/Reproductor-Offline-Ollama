<#
  _Servidor.ps1  -  Servidor HTTP local para el Reproductor Web
  Requiere Windows PowerShell 5.1 (o superior). No necesita Python ni nada extra.

  Caracteristicas:
    - Sirve la carpeta (por defecto la actual) en http://localhost:PUERTO/
    - Soporta peticiones Range (206) -> se puede avanzar/retroceder en audio y video
    - GET, HEAD y OPTIONS, CORS abierto, ETag / If-None-Match (304) / If-Range
    - Atiende varias peticiones a la vez (pool de hilos)
    - Proteccion contra salida de la carpeta (path traversal), archivos ocultos
      (que empiezan por punto) y extensiones sensibles (.ps1 .bat .cmd .log ...)
    - Busca automaticamente un puerto libre si el elegido esta ocupado
    - Registro en consola y en servidor.log (rota al pasar de 2 MB)
    - Pulsa Q para detenerlo (o Ctrl+C, o cierra la ventana)

  Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File .\_Servidor.ps1 -Root . -Port 8000 -Abrir
#>
[CmdletBinding()]
param(
    [string]$Root = '.',
    [int]$Port = 8000,
    [string]$DefaultDoc = 'index.html',
    [int]$MaxPortTries = 40,
    [int]$MaxThreads = 16,
    [string]$LogFile = '',
    [switch]$Abrir,
    [switch]$Silencioso
)

$ErrorActionPreference = 'Stop'
$script:LastError = ''

# ---------------------------------------------------------------- utilidades
function Write-Info {
    param([string]$Text, [string]$Color = 'Gray')
    if (-not $Silencioso) { Write-Host $Text -ForegroundColor $Color }
}

function Stop-WithError {
    param([string]$Text, [int]$Code = 1)
    Write-Host ''
    Write-Host ('[ERROR] ' + $Text) -ForegroundColor Red
    if (-not $Silencioso) { [void](Read-Host 'Pulsa Enter para cerrar') }
    exit $Code
}

function Get-LineColor {
    param([string]$Line)
    if ($Line -match '^(\d{3}) ') {
        $c = [int]$Matches[1]
        if ($c -ge 500) { return 'Red' }
        if ($c -ge 400) { return 'Yellow' }
        if ($c -ge 300) { return 'DarkGray' }
        return 'Green'
    }
    return 'Gray'
}

# ------------------------------------------------------- carpeta raiz y doc
try {
    if (-not [IO.Path]::IsPathRooted($Root)) {
        $Root = Join-Path (Get-Location).ProviderPath $Root
    }
    $Root = [IO.Path]::GetFullPath($Root)
    if ($Root.Length -gt 3) { $Root = $Root.TrimEnd('\') }
}
catch {
    Stop-WithError ('Ruta raiz invalida: ' + $Root) 2
}
if (-not [IO.Directory]::Exists($Root)) {
    Stop-WithError ('No existe la carpeta a servir: ' + $Root) 2
}

if (-not [IO.File]::Exists([IO.Path]::Combine($Root, $DefaultDoc))) {
    $first = Get-ChildItem -LiteralPath $Root -Filter '*.html' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($first) {
        Write-Info ('Aviso: no existe ' + $DefaultDoc + '; se usara ' + $first.Name) 'DarkYellow'
        $DefaultDoc = $first.Name
    }
    else {
        Write-Info ('Aviso: no hay ningun .html en ' + $Root) 'DarkYellow'
    }
}

# ----------------------------------------------------------------------- log
if ([string]::IsNullOrWhiteSpace($LogFile)) { $LogFile = Join-Path $Root 'servidor.log' }
$logWriter = $null
try {
    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 2MB)) {
        Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.old') -Force
    }
    $enc = New-Object System.Text.UTF8Encoding($false)
    $logWriter = New-Object System.IO.StreamWriter($LogFile, $true, $enc)
    $logWriter.AutoFlush = $true
}
catch {
    $logWriter = $null
    Write-Info ('Aviso: no se pudo abrir el log: ' + $_.Exception.Message) 'DarkYellow'
}

$logQ = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'

function Flush-Log {
    $line = $null
    while ($logQ.TryDequeue([ref]$line)) {
        Write-Info $line (Get-LineColor $line)
        if ($logWriter) {
            try { $logWriter.WriteLine((Get-Date -Format 'yyyy-MM-dd ') + $line) } catch { }
        }
    }
}

# --------------------------------------------------------------- tipos MIME
$mime = @{
    '.html' = 'text/html; charset=utf-8';  '.htm' = 'text/html; charset=utf-8'
    '.js' = 'application/javascript; charset=utf-8'; '.mjs' = 'application/javascript; charset=utf-8'
    '.css' = 'text/css; charset=utf-8';    '.json' = 'application/json; charset=utf-8'
    '.map' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
    '.txt' = 'text/plain; charset=utf-8';  '.lrc' = 'text/plain; charset=utf-8'
    '.srt' = 'text/plain; charset=utf-8';  '.vtt' = 'text/vtt; charset=utf-8'
    '.csv' = 'text/csv; charset=utf-8';    '.xml' = 'application/xml; charset=utf-8'
    '.m3u' = 'audio/x-mpegurl';            '.m3u8' = 'application/vnd.apple.mpegurl'
    '.pls' = 'audio/x-scpls';              '.cue' = 'text/plain; charset=utf-8'
    '.mp3' = 'audio/mpeg';  '.m4a' = 'audio/mp4';  '.aac' = 'audio/aac'
    '.wav' = 'audio/wav';   '.ogg' = 'audio/ogg';  '.oga' = 'audio/ogg'
    '.opus' = 'audio/ogg';  '.flac' = 'audio/flac'; '.weba' = 'audio/webm'
    '.mp4' = 'video/mp4';   '.m4v' = 'video/mp4';  '.webm' = 'video/webm'
    '.ogv' = 'video/ogg';   '.mkv' = 'video/x-matroska'; '.mov' = 'video/quicktime'
    '.png' = 'image/png';   '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
    '.gif' = 'image/gif';   '.webp' = 'image/webp'; '.avif' = 'image/avif'
    '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.bmp' = 'image/bmp'
    '.woff' = 'font/woff';  '.woff2' = 'font/woff2'; '.ttf' = 'font/ttf'; '.otf' = 'font/otf'
    '.pdf' = 'application/pdf'; '.wasm' = 'application/wasm'
}

# ------------------------------------------------- manejador de cada peticion
# Se ejecuta en un runspace independiente (varias peticiones en paralelo).
$handler = {
    param($ctx, $Root, $DefaultDoc, $Mime, $LogQ)

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $req = $ctx.Request
    $res = $ctx.Response
    $status = 200
    $sent = [int64]0
    $method = '?'
    $rawUrl = '?'
    $note = ''

    function Set-H {
        param($Res, [string]$Name, [string]$Value)
        try { $Res.Headers.Set($Name, $Value) } catch { }
    }

    function Send-Text {
        param($Res, [int]$Code, [string]$Text, [bool]$HeadOnly)
        $Res.StatusCode = $Code
        $Res.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        $Res.ContentLength64 = $bytes.Length
        if ($HeadOnly) { return [int64]0 }
        $Res.OutputStream.Write($bytes, 0, $bytes.Length)
        return [int64]$bytes.Length
    }

    try {
        $method = $req.HttpMethod.ToUpperInvariant()
        $rawUrl = $req.RawUrl
        $isHead = ($method -eq 'HEAD')

        Set-H $res 'Server' 'ReproductorLocal-PS'
        Set-H $res 'X-Content-Type-Options' 'nosniff'
        Set-H $res 'Access-Control-Allow-Origin' '*'
        Set-H $res 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS'
        Set-H $res 'Access-Control-Allow-Headers' 'Range, If-Range, If-None-Match, Content-Type'
        Set-H $res 'Access-Control-Expose-Headers' 'Content-Length, Content-Range, Accept-Ranges, ETag'

        if ($method -eq 'OPTIONS') {
            $status = 204
            $res.StatusCode = 204
            $res.ContentLength64 = 0
        }
        elseif (($method -ne 'GET') -and ($method -ne 'HEAD')) {
            $status = 405
            Set-H $res 'Allow' 'GET, HEAD, OPTIONS'
            $sent = Send-Text $res 405 'Metodo no permitido' $false
        }
        else {
            # ---- 1) decodificar y resolver la ruta
            $urlPath = $req.Url.AbsolutePath
            $rel = ''
            $badUrl = $false
            try { $rel = [Uri]::UnescapeDataString($urlPath) } catch { $badUrl = $true }
            if ($badUrl -or ($rel.IndexOf([char]0) -ge 0)) {
                $status = 400
                $sent = Send-Text $res 400 'Solicitud invalida' $isHead
            }
            else {
                $rel = $rel.Replace('/', '\').TrimStart('\')
                $full = $null
                try { $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $rel)) } catch { $full = $null }
                $rootSlash = $Root.TrimEnd('\') + '\'

                $hidden = $false
                foreach ($seg in $rel.Split('\')) {
                    if (($seg.Length -gt 0) -and $seg.StartsWith('.')) { $hidden = $true }
                }

                if (($null -eq $full) -or $hidden -or (-not (($full + '\').StartsWith($rootSlash, [StringComparison]::OrdinalIgnoreCase)))) {
                    $status = 403
                    $sent = Send-Text $res 403 'Acceso denegado' $isHead
                }
                else {
                    # ---- 2) carpetas: redirigir a "/" y servir documento por defecto
                    $redirected = $false
                    if ([IO.Directory]::Exists($full)) {
                        if (-not $urlPath.EndsWith('/')) {
                            $status = 301
                            $q = ''
                            if ($req.Url.Query) { $q = $req.Url.Query }
                            Set-H $res 'Location' ($urlPath + '/' + $q)
                            $res.StatusCode = 301
                            $res.ContentLength64 = 0
                            $redirected = $true
                        }
                        else {
                            $found = $null
                            foreach ($cand in @($DefaultDoc, 'index.html', 'index.htm')) {
                                $p = [IO.Path]::Combine($full, $cand)
                                if ([IO.File]::Exists($p)) { $found = $p; break }
                            }
                            if ($found) { $full = $found } else { $full = $null }
                        }
                    }

                    if (-not $redirected) {
                        $ext = ''
                        if ($full) { $ext = [IO.Path]::GetExtension($full).ToLowerInvariant() }
                        $denied = @('.ps1', '.bat', '.cmd', '.vbs', '.log', '.old', '.lnk')

                        if ((-not $full) -or (-not [IO.File]::Exists($full))) {
                            $status = 404
                            $sent = Send-Text $res 404 'No encontrado' $isHead
                        }
                        elseif ($denied -contains $ext) {
                            $status = 403
                            $sent = Send-Text $res 403 'Acceso denegado' $isHead
                        }
                        else {
                            # ---- 3) cabeceras del archivo
                            $fi = New-Object IO.FileInfo($full)
                            $len = [int64]$fi.Length
                            $ctype = 'application/octet-stream'
                            if ($Mime.ContainsKey($ext)) { $ctype = $Mime[$ext] }
                            $etag = '"{0:x}-{1:x}"' -f $fi.LastWriteTimeUtc.Ticks, $len
                            $lastMod = $fi.LastWriteTimeUtc.ToString('R', [Globalization.CultureInfo]::InvariantCulture)

                            Set-H $res 'ETag' $etag
                            Set-H $res 'Last-Modified' $lastMod
                            Set-H $res 'Accept-Ranges' 'bytes'
                            Set-H $res 'Cache-Control' 'no-cache'
                            $res.ContentType = $ctype

                            $inm = $req.Headers['If-None-Match']
                            if ($inm -and ($inm -eq $etag)) {
                                $status = 304
                                $res.StatusCode = 304
                                $res.ContentLength64 = 0
                            }
                            else {
                                # ---- 4) Range
                                $start = [int64]0
                                $end = $len - 1
                                $partial = $false
                                $unsat = $false
                                $rh = $req.Headers['Range']
                                $ifr = $req.Headers['If-Range']
                                if ($rh -and ((-not $ifr) -or ($ifr -eq $etag))) {
                                    $m = [regex]::Match($rh.Trim(), '^bytes=(\d*)-(\d*)$')
                                    if ($m.Success -and (($m.Groups[1].Value -ne '') -or ($m.Groups[2].Value -ne ''))) {
                                        if ($m.Groups[1].Value -eq '') {
                                            $suffix = [int64]$m.Groups[2].Value
                                            if ($suffix -le 0) { $unsat = $true }
                                            else {
                                                $start = [Math]::Max([int64]0, $len - $suffix)
                                                $end = $len - 1
                                                $partial = $true
                                            }
                                        }
                                        else {
                                            $start = [int64]$m.Groups[1].Value
                                            if ($m.Groups[2].Value -ne '') {
                                                $end = [Math]::Min([int64]$m.Groups[2].Value, $len - 1)
                                            }
                                            else { $end = $len - 1 }
                                            if (($start -ge $len) -or ($start -gt $end)) { $unsat = $true }
                                            else { $partial = $true }
                                        }
                                    }
                                }
                                if ($len -eq 0) { $partial = $false; $unsat = $false; $start = [int64]0; $end = [int64]-1 }

                                if ($unsat) {
                                    $status = 416
                                    Set-H $res 'Content-Range' ('bytes */' + $len)
                                    $sent = Send-Text $res 416 'Rango no satisfactorio' $isHead
                                }
                                else {
                                    if (-not $partial) { $start = [int64]0; $end = $len - 1 }
                                    $count = $end - $start + 1
                                    if ($count -lt 0) { $count = [int64]0 }
                                    if ($partial) {
                                        $status = 206
                                        $res.StatusCode = 206
                                        Set-H $res 'Content-Range' ('bytes ' + $start + '-' + $end + '/' + $len)
                                    }
                                    $res.ContentLength64 = $count

                                    # ---- 5) enviar el contenido por bloques de 64 KB
                                    if ((-not $isHead) -and ($count -gt 0)) {
                                        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
                                        $fs = $null
                                        try {
                                            $fs = New-Object IO.FileStream -ArgumentList @($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share, 65536)
                                            [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
                                            $buf = New-Object byte[] 65536
                                            $remaining = $count
                                            $out = $res.OutputStream
                                            while ($remaining -gt 0) {
                                                $toRead = [int][Math]::Min([int64]$buf.Length, $remaining)
                                                $n = $fs.Read($buf, 0, $toRead)
                                                if ($n -le 0) { break }
                                                $out.Write($buf, 0, $n)
                                                $remaining -= $n
                                                $sent += $n
                                            }
                                        }
                                        finally {
                                            if ($fs) { $fs.Dispose() }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    catch {
        $ex = $_.Exception
        $inner = $ex.InnerException
        if (($ex -is [System.Net.HttpListenerException]) -or ($ex -is [System.IO.IOException]) -or
            ($inner -is [System.Net.HttpListenerException]) -or ($inner -is [System.IO.IOException])) {
            $note = ' [cliente cerro la conexion]'
        }
        else {
            $note = ' [ERROR: ' + $ex.Message + ']'
            try {
                $status = 500
                [void](Send-Text $res 500 'Error interno del servidor' $false)
            }
            catch { }
        }
    }
    finally {
        try { $res.OutputStream.Close() } catch { }
        try { $res.Close() } catch { }
        $sw.Stop()
        $line = '{0} {1} {2,-4} {3} ({4} bytes, {5} ms){6}' -f $status, (Get-Date -Format 'HH:mm:ss'), $method, $rawUrl, $sent, $sw.ElapsedMilliseconds, $note
        $LogQ.Enqueue($line)
    }
}

# ---------------------------------------------------- abrir el puerto libre
function New-Listener {
    param([int]$P, [string[]]$Hosts)
    $l = New-Object System.Net.HttpListener
    foreach ($h in $Hosts) { $l.Prefixes.Add('http://' + $h + ':' + $P + '/') }
    try {
        $l.Start()
        return $l
    }
    catch {
        $script:LastError = $_.Exception.Message.Trim()
        try { $l.Close() } catch { }
        return $null
    }
}

$listener = $null
$bound = 0
for ($i = 0; ($i -lt $MaxPortTries) -and (-not $listener); $i++) {
    $p2 = $Port + $i
    $listener = New-Listener $p2 @('localhost', '127.0.0.1')
    if (-not $listener) { $listener = New-Listener $p2 @('localhost') }
    if ($listener) { $bound = $p2 }
    else { Write-Info ('Puerto ' + $p2 + ' no disponible (' + $script:LastError + ')') 'DarkYellow' }
}
if (-not $listener) {
    Stop-WithError ('No se pudo abrir ningun puerto entre ' + $Port + ' y ' + ($Port + $MaxPortTries - 1) + '. Ultimo error: ' + $script:LastError) 3
}

$url = 'http://localhost:' + $bound + '/'
$openUrl = $url + [Uri]::EscapeDataString($DefaultDoc)
try { $Host.UI.RawUI.WindowTitle = 'Servidor Reproductor Web - ' + $url } catch { }

Write-Info ''
Write-Info '==============================================================' 'Cyan'
Write-Info '   SERVIDOR LOCAL - REPRODUCTOR WEB  (PowerShell)' 'Cyan'
Write-Info '==============================================================' 'Cyan'
Write-Info ('   Carpeta : ' + $Root) 'White'
Write-Info ('   Pagina  : ' + $openUrl) 'White'
Write-Info ('   Log     : ' + $LogFile) 'Gray'
Write-Info '--------------------------------------------------------------' 'Cyan'
Write-Info '   Pulsa Q para detener (o Ctrl+C / cierra esta ventana).' 'DarkGray'
Write-Info ''

if ($Abrir) {
    try { Start-Process -FilePath 'explorer.exe' -ArgumentList $openUrl }
    catch {
        try { Start-Process $openUrl }
        catch { Write-Info ('No se pudo abrir el navegador. Abre manualmente: ' + $openUrl) 'Yellow' }
    }
}

# ------------------------------------------------------- bucle principal
$pool = [runspacefactory]::CreateRunspacePool(1, $MaxThreads)
$pool.Open()
$jobs = New-Object System.Collections.ArrayList
$stopRequested = $false

function Clear-Jobs {
    for ($j = $jobs.Count - 1; $j -ge 0; $j--) {
        $job = $jobs[$j]
        if ($job.Handle.IsCompleted) {
            try { [void]$job.PS.EndInvoke($job.Handle) } catch { }
            try { $job.PS.Dispose() } catch { }
            $jobs.RemoveAt($j)
        }
    }
}

try {
    $task = $listener.GetContextAsync()
    while ($listener.IsListening -and (-not $stopRequested)) {
        $ready = $false
        try { $ready = $task.Wait(200) }
        catch {
            if (-not $listener.IsListening) { break }
            Start-Sleep -Milliseconds 50
            $task = $listener.GetContextAsync()
            continue
        }

        if ($ready) {
            $ctx = $null
            try { $ctx = $task.Result } catch { $ctx = $null }
            $task = $listener.GetContextAsync()
            if ($ctx) {
                try {
                    $ps = [powershell]::Create()
                    $ps.RunspacePool = $pool
                    [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($Root).AddArgument($DefaultDoc).AddArgument($mime).AddArgument($logQ)
                    $handle = $ps.BeginInvoke()
                    [void]$jobs.Add([pscustomobject]@{ PS = $ps; Handle = $handle })
                }
                catch {
                    try { $ctx.Response.Abort() } catch { }
                }
            }
        }

        try {
            if ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if ($k.Key -eq [ConsoleKey]::Q) { $stopRequested = $true }
            }
        }
        catch { }

        Flush-Log
        Clear-Jobs
    }
}
catch {
    Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red
}
finally {
    Write-Info ''
    Write-Info 'Deteniendo servidor...' 'Yellow'
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
    try { $pool.Close(); $pool.Dispose() } catch { }
    Flush-Log
    if ($logWriter) { try { $logWriter.Dispose() } catch { } }
    Write-Info 'Servidor detenido.' 'Yellow'
}
