<#
  _RepararCors.ps1  -  Diagnostico y reparacion de CORS entre WebPlay y Ollama
  Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File .\_RepararCors.ps1 -Accion <Diagnostico|Arreglar|Deshacer>
#>
[CmdletBinding()]
param(
    [ValidateSet('Diagnostico','Arreglar','Deshacer')]
    [string]$Accion = 'Diagnostico',
    [int]$Puerto = 8000,
    [switch]$Silencioso
)

$ErrorActionPreference = 'Continue'
$Global:ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- salida
function Write-Ok   { param($m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "  [INFO] $m" -ForegroundColor Gray }
function Write-Warn2{ param($m) Write-Host "  [AVISO] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "  [ERROR] $m" -ForegroundColor Red }
function Write-Tit  { param($m) Write-Host "`n$m" -ForegroundColor Cyan }

# ---------------------------------------------------------------- estado
$RutaState = Join-Path $PSScriptRoot 'cors_state.json'
$OllamaUrl = 'http://localhost:11434'

# OLLAMA_ORIGINS solo admite "*" o una lista de origenes EXACTOS separados por
# comas. Probado en Ollama 0.34.4:
#   - "http://localhost:*"      -> ARRANCA pero rechaza / no sirve nada util
#   - "a,b,c"                   -> el servidor NO ARRANCA
#   - "*"                       -> funciona (permite cualquier origen)
# Por eso aqui se usa "*". Ollama solo escucha en 127.0.0.1, asi que abrirlo
# a cualquier origen de la pagina no expone nada fuera de tu equipo.
$OriginsValor = '*'

function Get-OllamaProcess {
    $p = Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue
    if ($p) { return $p } else { return $null }
}

function Test-OllamaService {
    try {
        $r = Invoke-WebRequest -Uri "$OllamaUrl/api/version" -TimeoutSec 4 -UseBasicParsing
        return @{ Ok = $true; Version = ($r.Content | ConvertFrom-Json).version }
    } catch {
        return @{ Ok = $false; Version = '' }
    }
}

# ---------------------------------------------------------- origins actual
function Get-OriginsActual {
    $v = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'Machine') }
    if (-not $v) { $v = $env:OLLAMA_ORIGINS }
    if ($v) { return $v }
    return ''
}

# ------------------------------------------------------------ guardar estado
function Save-State {
    param([string]$Previo)
    $obj = [ordered]@{
        GuardadoEl   = (Get-Date).ToString('o')
        OriginsAntes = $Previo
    }
    $obj | ConvertTo-Json | Set-Content -LiteralPath $RutaState -Encoding UTF8
}

function Get-StatePrevio {
    if (-not (Test-Path -LiteralPath $RutaState)) { return $null }
    try {
        return (Get-Content -LiteralPath $RutaState -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch { return $null }
}

# ---------------------------------------------------------- prueba CORS real
function Test-Preflight {
    param([int]$puertoPagina)

    $origen = "http://localhost:$puertoPagina"
    $url    = "$OllamaUrl/api/chat"

    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Method    = 'OPTIONS'
        $req.Timeout   = 6000
        $req.Headers.Add('Origin', $origen)
        $req.Headers.Add('Access-Control-Request-Method', 'POST')
        $req.Headers.Add('Access-Control-Request-Headers', 'content-type')

        $resp = $req.GetResponse()
        $allow = $resp.Headers['Access-Control-Allow-Origin']
        $resp.Close()

        if ($allow -eq $origen -or $allow -eq '*') {
            return @{ Ok = $true; Allow = $allow }
        }
        return @{ Ok = $false; Allow = $allow }
    } catch {
        # 403/500 tambien devuelven cabeceras CORS utiles
        if ($_.Exception.Response) {
            $allow = $_.Exception.Response.Headers['Access-Control-Allow-Origin']
            if ($allow -eq $origen -or $allow -eq '*') {
                return @{ Ok = $true; Allow = $allow }
            }
            return @{ Ok = $false; Allow = $allow; Status = [int]$_.Exception.Response.StatusCode }
        }
        return @{ Ok = $false; Allow = ''; Status = 0 }
    }
}

# ------------------------------------------------- reiniciar Ollama
function Restart-Ollama {
    # Detiene cualquier instancia previa
    Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Localiza ollama.exe en las rutas habituales
    $exe = $null
    foreach ($c in @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe"
    )) { if (Test-Path -LiteralPath $c) { $exe = $c; break } }
    if (-not $exe) {
        $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
        if ($cmd) { $exe = $cmd.Source }
    }
    if (-not $exe) { return $false }

    # SIEMPRE con 'serve': lanzar el .exe a secas solo abre la app de
    # bandeja y NO levanta el servidor en el puerto 11434.
    try {
        Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Minimized
    } catch {
        try { Start-Process -FilePath $exe -WindowStyle Minimized }
        catch { return $false }
    }
    return $true
}

# ====================================================================
#  ACCIONES
# ====================================================================

function Accion-Diagnostico {
    Write-Host ''
    Write-Host ' ==============================================================' -ForegroundColor Cyan
    Write-Host '  DIAGNOSTICO CORS  -  WebPlay  <->  Ollama' -ForegroundColor Cyan
    Write-Host ' ==============================================================' -ForegroundColor Cyan

    # 1. Ollama instalado
    Write-Tit ' 1. Ollama'
    $proc = Get-OllamaProcess
    if ($proc) {
        Write-Ok "Proceso en marcha: $($proc[0].ProcessName) (PID $($proc[0].Id))"
    } else {
        Write-Err 'No hay ningun proceso de Ollama en ejecucion.'
        Write-Info 'Instalalo desde https://ollama.com/download y abrilo una vez.'
        Write-Info 'Las funciones de IA no funcionaran hasta entonces.'
    }

    # 2. Puerto
    Write-Tit ' 2. Puerto 11434'
    $t = Test-OllamaService
    if ($t.Ok) {
        Write-Ok "Responde. Version $($t.Version)"
    } else {
        Write-Warn2 'No responde en http://localhost:11434/api/version'
        if ($proc) {
            Write-Info 'El proceso existe pero el puerto no contesta: puede estar arrancando.'
            Write-Info 'Espera unos segundos y vuelve a ejecutar el diagnostico.'
        }
    }

    # 3. Variable de entorno
    Write-Tit ' 3. Variable OLLAMA_ORIGINS'
    $orig = Get-OriginsActual
    if ($orig) {
        Write-Ok "Configurada: $orig"
    } else {
        Write-Warn2 'NO esta definida (puede ser el origen del error CORS).'
    }

    # 4. Prueba real de preflight
    Write-Tit " 4. Prueba CORS desde el origen del reproductor (puerto $Puerto)"
    if (-not $t.Ok) {
        Write-Warn2 'Omitida: Ollama no responde.'
    } else {
        $p = Test-Preflight -puertoPagina $Puerto
        if ($p.Ok) {
            Write-Ok "Permitido. Access-Control-Allow-Origin: $($p.Allow)"
        } else {
            Write-Err 'BLOQUEADO. El navegador no permitio la peticion a Ollama.'
            Write-Info "Access-Control-Allow-Origin recibido: '$($p.Allow)'"
            Write-Info 'Solucion: elige la opcion [C] -> Arreglar.'
        }
    }

    # 5. Estado guardado
    Write-Tit ' 5. Copia de seguridad'
    $st = Get-StatePrevio
    if ($st) {
        Write-Ok "Guardada el $($st.GuardadoEl)"
        Write-Info "Valor original: '$($st.OriginsAntes)'"
    } else {
        Write-Info 'Sin copia de seguridad (todavia no se modifico nada).'
    }

    Write-Host ''
}

function Accion-Arreglar {
    Write-Host ''
    Write-Host ' ==============================================================' -ForegroundColor Cyan
    Write-Host '  REPARACION CORS  -  WebPlay  <->  Ollama' -ForegroundColor Cyan
    Write-Host ' ==============================================================' -ForegroundColor Cyan

    # --- Ollama debe estar instalado ---
    if (-not (Get-OllamaProcess)) {
        Write-Err 'Ollama no esta en ejecucion. No se puede reparar CORS sin el.'
        Write-Info 'Instalalo y abrilo, luego vuelve a ejecutar esta opcion.'
        Write-Host ''
        return
    }

    # --- copia de seguridad antes de tocar nada ---
    $previo = Get-OriginsActual
    if (-not (Get-StatePrevio)) {
        Save-State -Previo $previo
        Write-Ok "Copia de seguridad guardada en cors_state.json"
        if ($previo) { Write-Info "Valor original: $previo" }
        else          { Write-Info 'Valor original: (vacia)' }
    } else {
        Write-Info 'Ya existe una copia de seguridad; no se sobrescribe.'
    }

    # --- aplicar ---
        $nuevo = $OriginsValor
        Write-Host ''
        Write-Info "Estableciendo OLLAMA_ORIGINS (ambito Usuario, Sesion y Maquina si hay permiso)..."

        try {
            [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', $nuevo, 'User')
            Write-Ok 'Ambito Usuario guardado (persiste al reiniciar Windows).'
        } catch { Write-Warn2 "Ambito Usuario: $($_.Exception.Message)" }

        try {
            [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', $nuevo, 'Machine')
            Write-Ok 'Ambito Maquina guardado.'
        } catch {
            Write-Info "Ambito Maquina omitido (hace falta ejecutar como administrador)."
            Write-Info 'No es necesario: el ambito Usuario ya es suficiente.'
        }

        $env:OLLAMA_ORIGINS = $nuevo
        Write-Ok 'Ambito Sesion establecido (esta consola).'

    Write-Host ''
    Write-Info "OLLAMA_ORIGINS = $nuevo"

    # --- reiniciar Ollama para que recoja la variable ---
    Write-Host ''
    Write-Info 'Reiniciando Ollama para que aplique el cambio...'
    if (Restart-Ollama) {
        Write-Ok 'Ollama reiniciado.'
    } else {
        Write-Warn2 'No se encontro ollama.exe: cierralo y abrilo tu a mano.'
    }

    Start-Sleep -Seconds 3

    # --- esperar a que Ollama vuelva (hasta 30 s) ---
    Write-Host ''
    Write-Info 'Esperando a que Ollama responda de nuevo...'
    $t = $null
    for ($i = 1; $i -le 10; $i++) {
        $t = Test-OllamaService
        if ($t.Ok) { break }
        Write-Host ("    ... {0}s" -f ($i * 3)) -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
    }

    # --- verificar ---
    Write-Host ''
    Write-Tit ' Verificacion'
    if ($t -and $t.Ok) {
        Write-Ok "Ollama responde. Version $($t.Version)"
    } else {
        Write-Warn2 'Ollama aun no responde. Puede tard unos segundos mas.'
    }

    $p = Test-Preflight -puertoPagina $Puerto
    if ($p.Ok) {
        Write-Ok "CORS OK desde http://localhost:$Puerto"
        Write-Host ''
        Write-Host '  Ya puedes usar el reproductor con todas las funciones de IA.' -ForegroundColor Green
    } else {
        Write-Warn2 'La prueba CORS sigue fallando.'
        Write-Info 'Si acabas de reiniciar Ollama, espera unos segundos y repite.'
        Write-Info 'Recuerda abrir siempre el reproductor por http://localhost, nunca file://'
    }

    Write-Host ''
    Write-Info 'Puedes volver a este menu y elegir [0] Revertir para deshacerlo todo.'
    Write-Host ''
}

function Accion-Deshacer {
    Write-Host ''
    Write-Host ' ==============================================================' -ForegroundColor Cyan
    Write-Host '  DESHACER  -  restaurando OLLAMA_ORIGINS' -ForegroundColor Cyan
    Write-Host ' ==============================================================' -ForegroundColor Cyan

    $st = Get-StatePrevio
    if (-not $st) {
        Write-Warn2 'No hay copia de seguridad: nada que restaurar.'
        Write-Host ''
        return
    }

    $antes = $st.OriginsAntes
    if ($null -eq $antes) { $antes = '' }

    Write-Info "Valor a restaurar: '$antes'"

    foreach ($scope in @('User','Machine')) {
        try {
            [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', $antes, $scope)
            Write-Ok "Ambito $scope restaurado."
        } catch {
            Write-Info "Ambito $scope omitido: hace falta ejecutar como administrador."
        }
    }
    $env:OLLAMA_ORIGINS = $antes

    # reiniciar Ollama para que recoja el cambio
    if (Restart-Ollama) {
        Write-Ok 'Ollama reiniciado.'
    } else {
        Write-Warn2 'Reinicia Ollama a mano para que recoja el cambio.'
    }

    Remove-Item -LiteralPath $RutaState -Force -ErrorAction SilentlyContinue
    Write-Ok 'Copia de seguridad eliminada.'
    Write-Host ''
}

# ---------------------------------------------------------------- ejecucion
Write-Host ''
Write-Host ' ==============================================================' -ForegroundColor Cyan
Write-Host '  REPARAR CORS  -  WebPlay  <->  Ollama' -ForegroundColor Cyan
Write-Host ' ==============================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host ("  El reproductor se sirve en  http://localhost:{0}" -f $Puerto) -ForegroundColor Gray
Write-Host '  y llama a Ollama en        http://localhost:11434' -ForegroundColor Gray
Write-Host ''
Write-Host '  Si las funciones de IA fallan con un error de CORS o de' -ForegroundColor Gray
Write-Host '  red, es porque Ollama no acepta ese origen. Aqui lo arreglas.' -ForegroundColor Gray
Write-Host ''
Write-Host '  [1] Diagnostico   -  ver que falla (no modifica nada)'
Write-Host '  [2] Arreglar      -  configurar OLLAMA_ORIGINS y reiniciar Ollama'
Write-Host '  [3] Deshacer      -  restaurar la configuracion anterior'
Write-Host '  [4] Volver'
Write-Host ''

$op = Read-Host '  Elige una opcion'
switch ($op) {
    '1' { Accion-Diagnostico }
    '2' { Accion-Arreglar }
    '3' { Accion-Deshacer }
    '4' { }
    ''  { }
    default { Write-Host '  Opcion no reconocida.' -ForegroundColor Red }
}

if (-not $Silencioso) {
    Read-Host "`n  Pulsa Enter para volver al menu" | Out-Null
}
exit 0