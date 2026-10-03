@echo off
setlocal EnableExtensions
title Reparador Reproductor Web - file:// origen unico
color 0B

REM ======================================================================
REM  REPARADOR: "Unsafe attempt to load URL file:///... from frame with URL
REM  file:///...  'file:' URLs are treated as unique security origins."
REM
REM  COLOCA ESTE .BAT EN LA MISMA CARPETA QUE index.html.
REM  Todas las rutas son RELATIVAS a la ubicacion de este archivo.
REM
REM  CAUSA: Chrome/Edge/Firefox tratan cada archivo file:// como un origen
REM  distinto. Si la pagina usa iframes, fetch(), XMLHttpRequest, canvas o
REM  window.parent/top sobre otro archivo local (incluso ella misma), el
REM  navegador lo bloquea.
REM
REM  SOLUCION CORRECTA : servir la carpeta por http://localhost (opcion 2).
REM  ALTERNATIVAS      : navegador con flags / patch de Firefox.
REM  No existe ninguna politica de registro que levante este bloqueo.
REM
REM  El servidor PowerShell (_Servidor.ps1) va embebido al final de este
REM  .bat y se extrae solo, junto al HTML, cuando hace falta.
REM ======================================================================

set "SELF=%~f0"
set "MENU_ARGUMENT="
if /i "%~1"=="/menu" set "MENU_ARGUMENT=/menu"

REM ---------------- AUTO-ELEVACION A ADMINISTRADOR ----------------------
fltmc >nul 2>&1
if not errorlevel 1 goto ADMIN_OK
if /i "%~1"=="/elevated" goto ADMIN_FAIL
echo Solicitando permisos de administrador...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '/elevated %MENU_ARGUMENT%' -WorkingDirectory '%~dp0' -Verb RunAs"
exit /b
:ADMIN_FAIL
echo [ERROR] No se obtuvieron permisos de administrador. Cancelado.
pause
exit /b 1
:ADMIN_OK

REM ------- CARPETA DEL PROYECTO = carpeta donde esta este .bat ----------
pushd "%~dp0"
if errorlevel 1 goto PUSHD_FAIL
set "PROJ=%CD%"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"
goto CONFIG
:PUSHD_FAIL
echo [ERROR] No se pudo acceder a la carpeta del script: %~dp0
pause
exit /b 1

REM ---------------------- CONFIGURACION ---------------------------------
:CONFIG
set "HTML_NAME=index.html"
set "PORT_BASE=8000"
set "PORT=%PORT_BASE%"
REM Motor del servidor: AUTO / POWERSHELL / PYTHON  (cambiable con [M])
set "MOTOR=POWERSHELL"
REM 1 = cerrar esta consola cuando el servidor ya arranco, 0 = dejarla abierta
set "CERRAR_CONSOLA=1"
set "LOG=%PROJ%\reparador_log.txt"
set "PERFIL_BASE=%PROJ%\.perfiles"
set "PS_FILE=%PROJ%\_Servidor.ps1"
set "LN_FILE=%PROJ%\Iniciar_Reproductor.bat"
set "PS_LNK=%TEMP%\reproductor_acceso.ps1"
set "CONFIG_FILE=%PROJ%\config.ini"

REM Cargar preferencias guardadas entre ejecuciones.
set "FIRST_RUN=0"
if not exist "%CONFIG_FILE%" (
    set "FIRST_RUN=1"
    call :SAVE_CONFIG
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%CONFIG_FILE%") do (
    if /i "%%~A"=="Pagina" if not "%%~B"=="" set "HTML_NAME=%%~B"
    if /i "%%~A"=="Puerto" if not "%%~B"=="" set "PORT_BASE=%%~B"
    if /i "%%~A"=="Motor" if not "%%~B"=="" set "MOTOR=%%~B"
    if /i "%%~A"=="CerrarConsola" if not "%%~B"=="" set "CERRAR_CONSOLA=%%~B"
)
if /i not "%MOTOR%"=="POWERSHELL" if /i not "%MOTOR%"=="PYTHON" if /i not "%MOTOR%"=="AUTO" set "MOTOR=POWERSHELL"
if not "%CERRAR_CONSOLA%"=="0" if not "%CERRAR_CONSOLA%"=="1" set "CERRAR_CONSOLA=1"
echo(%PORT_BASE%| findstr /r "^[0-9][0-9]*$" >nul || set "PORT_BASE=8000"
if %PORT_BASE% LSS 1 set "PORT_BASE=8000"
if %PORT_BASE% GTR 65535 set "PORT_BASE=8000"
set "PORT=%PORT_BASE%"

REM Si la pagina configurada no existe, usa el primer .html de la carpeta
if exist "%PROJ%\%HTML_NAME%" goto HTML_OK
for %%F in ("%PROJ%\*.html") do if not defined HTML_ALT set "HTML_ALT=%%~nxF"
if defined HTML_ALT set "HTML_NAME=%HTML_ALT%"
:HTML_OK
call :SAVE_CONFIG

call :LOG "Sesion iniciada. Carpeta: %PROJ%"

REM Al abrir normalmente, inicia el servidor con las preferencias guardadas.
REM Ejecuta este BAT con /menu para acceder a las herramientas del menu.
if "%FIRST_RUN%"=="1" goto MENU
if /i "%~1"=="/menu" goto MENU
if /i "%~2"=="/menu" goto MENU
goto OP_SERVIDOR

REM ============================== MENU ==================================
:MENU
cls
set "ESTADO=NO ENCONTRADO"
if exist "%PROJ%\%HTML_NAME%" set "ESTADO=OK"
set "CC_TXT=SI"
if not "%CERRAR_CONSOLA%"=="1" set "CC_TXT=NO"
echo ======================================================================
echo   REPARADOR REPRODUCTOR WEB  -  error "file: URLs unique origins"
echo ======================================================================
echo   Carpeta : %PROJ%
echo   Archivo : %HTML_NAME%  [%ESTADO%]
echo   Servidor: motor %MOTOR%   -   cerrar consola al iniciar: %CC_TXT%
echo ----------------------------------------------------------------------
echo   [1] REPARACION AUTOMATICA (desbloquear + permisos + servidor + abrir)
echo   [2] Iniciar servidor local http://localhost (RECOMENDADO)
echo   [3] Abrir con Google Chrome (perfil aislado + flags)
echo   [4] Abrir con Microsoft Edge (perfil aislado + flags)
echo   [5] Parchear Firefox (security.fileuri.strict_origin_policy)
echo   [6] Desbloquear archivos y reparar permisos de la carpeta
echo   [7] Crear accesos directos en el Escritorio (Chrome/Edge)
echo   [8] Crear lanzador permanente "Iniciar_Reproductor.bat"
echo   [9] Diagnostico completo
echo   [C] Reparar CORS / conexion con Ollama
echo   [0] Revertir todos los cambios
echo   [M] Cambiar motor del servidor (POWERSHELL / PYTHON / AUTO)
echo   [D] Detener el servidor en ejecucion
echo   [Q] Salir
echo ----------------------------------------------------------------------
choice /c 1234567890CMDQ /n /m "Elige una opcion: "
if errorlevel 14 goto SALIR
if errorlevel 13 goto OP_DETENER
if errorlevel 12 goto OP_MOTOR
if errorlevel 11 goto OP_CORS
if errorlevel 10 goto OP_REVERTIR
if errorlevel 9  goto OP_DIAG
if errorlevel 8  goto OP_LANZADOR
if errorlevel 7  goto OP_ACCESOS
if errorlevel 6  goto OP_PERMISOS
if errorlevel 5  goto OP_FIREFOX
if errorlevel 4  goto OP_EDGE
if errorlevel 3  goto OP_CHROME
if errorlevel 2  goto OP_SERVIDOR
if errorlevel 1  goto OP_AUTO
goto MENU

REM ============================ OPERACIONES =============================
:OP_AUTO
cls
call :LOG "=== Reparacion automatica ==="
call :CHECK_PROJ
if errorlevel 1 goto OP_END
call :UNBLOCK_PERMS
call :START_SERVER
if errorlevel 1 goto OP_END
echo.
echo  IMPORTANTE: abre SIEMPRE la pagina como  http://localhost:PUERTO/%HTML_NAME%
echo  y NO con doble clic sobre el .html (eso vuelve a usar file://).
echo  Para detener el servidor pulsa Q en su ventana o cierrala.
call :AUTOCLOSE
goto OP_END

:OP_SERVIDOR
cls
call :START_SERVER
if errorlevel 1 goto OP_END
call :AUTOCLOSE
goto OP_END

:OP_PERMISOS
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
call :UNBLOCK_PERMS
goto OP_END

:OP_CHROME
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
call :FIND_BROWSERS
if defined CHROME goto OC_GO
call :LOG "[ERROR] Google Chrome no esta instalado."
goto OP_END
:OC_GO
call :BUILD_FILE_URL
echo  AVISO: --disable-web-security reduce la seguridad. Se usa un perfil
echo  aislado (.perfiles): usalo SOLO para el reproductor, no para navegar.
call :LOG "Abriendo Chrome (perfil aislado) : %FILE_URL%"
start "" "%CHROME%" --user-data-dir="%PERFIL_BASE%\Chrome" --allow-file-access-from-files --disable-web-security --disable-site-isolation-trials --no-first-run --no-default-browser-check "%FILE_URL%"
goto OP_END

:OP_EDGE
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
call :FIND_BROWSERS
if defined EDGE goto OE_GO
call :LOG "[ERROR] Microsoft Edge no encontrado."
goto OP_END
:OE_GO
call :BUILD_FILE_URL
echo  AVISO: --disable-web-security reduce la seguridad. Se usa un perfil
echo  aislado (.perfiles): usalo SOLO para el reproductor, no para navegar.
call :LOG "Abriendo Edge (perfil aislado) : %FILE_URL%"
start "" "%EDGE%" --user-data-dir="%PERFIL_BASE%\Edge" --allow-file-access-from-files --disable-web-security --disable-site-isolation-trials --no-first-run "%FILE_URL%"
goto OP_END

:OP_FIREFOX
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
tasklist /fi "imagename eq firefox.exe" 2>nul | find /i "firefox.exe" >nul
if errorlevel 1 goto OF_PATCH
echo Firefox esta abierto y debe cerrarse para aplicar el cambio.
choice /c SN /m "Cerrar Firefox ahora (S/N)? "
if errorlevel 2 goto OP_END
taskkill /im firefox.exe /f >nul 2>&1
timeout /t 2 /nobreak >nul
:OF_PATCH
set "FFROOT=%APPDATA%\Mozilla\Firefox\Profiles"
if exist "%FFROOT%" goto OF_LOOP
call :LOG "[ERROR] No se encontraron perfiles de Firefox en %FFROOT%"
goto OP_END
:OF_LOOP
for /d %%P in ("%FFROOT%\*") do call :FF_PATCH "%%~fP"
call :FIND_BROWSERS
call :BUILD_FILE_URL
if not defined FIREFOX goto OP_END
call :LOG "Abriendo Firefox : %FILE_URL%"
start "" "%FIREFOX%" "%FILE_URL%"
goto OP_END

:OP_ACCESOS
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
call :FIND_BROWSERS
call :BUILD_FILE_URL
call :GET_DESKTOP
call :EXTRACT "#LK#" "%PS_LNK%"
set "LNK_WD=%PROJ%"
if not defined CHROME goto OA_EDGE
set "LNK_PATH=%DESK%\Reproductor Web (Chrome).lnk"
set "LNK_TARGET=%CHROME%"
set LNK_ARGS=--user-data-dir="%PERFIL_BASE%\Chrome" --allow-file-access-from-files --disable-web-security --disable-site-isolation-trials --no-first-run "%FILE_URL%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_LNK%"
call :LOG "Acceso directo creado: %LNK_PATH%"
:OA_EDGE
if not defined EDGE goto OP_END
set "LNK_PATH=%DESK%\Reproductor Web (Edge).lnk"
set "LNK_TARGET=%EDGE%"
set LNK_ARGS=--user-data-dir="%PERFIL_BASE%\Edge" --allow-file-access-from-files --disable-web-security --disable-site-isolation-trials --no-first-run "%FILE_URL%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_LNK%"
call :LOG "Acceso directo creado: %LNK_PATH%"
goto OP_END

:OP_LANZADOR
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
call :WRITE_PS_SERVER
if errorlevel 1 goto OP_END
call :EXTRACT "#LN#" "%LN_FILE%"
if not exist "%LN_FILE%" goto OL_FAIL
call :LOG "Lanzador creado: %LN_FILE%"
echo  Ahora puedes abrir el reproductor con doble clic en Iniciar_Reproductor.bat
echo  (necesita _Servidor.ps1 en la misma carpeta; ya se genero).
goto OP_END
:OL_FAIL
call :LOG "[ERROR] No se pudo crear el lanzador (permisos de escritura?)."
goto OP_END

:OP_CORS
cls
call :CHECK_PROJ
if errorlevel 1 goto OP_END
set "CORS_PS=%PROJ%\_RepararCors.ps1"
if exist "%CORS_PS%" goto OC_RUN
call :LOG "[ERROR] No se encontro %CORS_PS%"
echo.
echo  No se puede reparar CORS: falta el script _RepararCors.ps1
echo  en la carpeta del reproductor.
goto OP_END
:OC_RUN
call :LOG "=== Reparacion CORS / Ollama ==="
powershell -NoProfile -ExecutionPolicy Bypass -File "%CORS_PS%" -Puerto %PORT_BASE%
goto OP_END

:OP_DIAG
cls
call :LOG "=== Diagnostico ==="
echo.
ver
echo  Usuario : %USERNAME%   Equipo: %COMPUTERNAME%
echo  Carpeta : %PROJ%
echo  HTML    : %HTML_NAME% [%ESTADO%]
echo  Motor   : %MOTOR%
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`) do echo  PowerShell: %%V
call :FIND_BROWSERS
call :FIND_PYTHON
echo.
call :SHOW "Chrome " CHROME
call :SHOW "Edge   " EDGE
call :SHOW "Firefox" FIREFOX
call :SHOW "Python " PYCMD
if exist "%PS_FILE%" (echo   _Servidor.ps1: presente) else (echo   _Servidor.ps1: no generado aun)
call :FIND_PORT
echo   Puerto libre sugerido: %PORT%
echo.
echo  --- Marca de Internet (Zone.Identifier) en el HTML ---
dir /r "%PROJ%\%HTML_NAME%" 2>nul | find /i "Zone.Identifier"
echo.
echo  --- Lineas del HTML que provocan el bloqueo (iframe/fetch/XHR/self) ---
findstr /i /n /c:"<iframe" /c:"location.href" /c:"fetch(" /c:"XMLHttpRequest" /c:"window.open" /c:"%HTML_NAME%" "%PROJ%\%HTML_NAME%" 2>nul
echo.
echo  --- Referencias a iframe o al HTML en archivos .js ---
findstr /s /i /n /c:"iframe" /c:"%HTML_NAME%" "%PROJ%\*.js" 2>nul
echo.
echo  Si el HTML se carga a si mismo dentro de un iframe (src apuntando a
echo  %HTML_NAME%), elimina ese iframe: ni siquiera con servidor tendria sentido.
goto OP_END

:OP_MOTOR
if /i "%MOTOR%"=="POWERSHELL" (
    set "MOTOR=PYTHON"
) else if /i "%MOTOR%"=="PYTHON" (
    set "MOTOR=AUTO"
) else (
    set "MOTOR=POWERSHELL"
)
:OM_DONE
call :SAVE_CONFIG
call :LOG "Motor del servidor cambiado a: %MOTOR%"
goto MENU

:SAVE_CONFIG
>"%CONFIG_FILE%" (
    echo [ReproductorWeb]
    echo Pagina=%HTML_NAME%
    echo Puerto=%PORT_BASE%
    echo Motor=%MOTOR%
    echo CerrarConsola=%CERRAR_CONSOLA%
)
exit /b 0

:OP_DETENER
cls
taskkill /f /t /fi "WINDOWTITLE eq Servidor Reproductor Web*" >nul 2>&1
if errorlevel 1 goto OD_NONE
call :LOG "Servidor detenido."
goto OP_END
:OD_NONE
call :LOG "No hay ningun servidor activo (ventana 'Servidor Reproductor Web')."
goto OP_END

:OP_REVERTIR
cls
echo Se eliminaran: perfiles aislados (.perfiles), accesos directos, lanzador,
echo _Servidor.ps1, servidor.log, servidor activo, el parche de Firefox,
echo el perfil de Ollama (OLLAMA_ORIGINS) y el script de CORS.
echo No se tocan tus archivos del reproductor.
choice /c SN /m "Continuar (S/N)? "
if errorlevel 2 goto MENU
call :LOG "=== Revertir cambios ==="
taskkill /f /t /fi "WINDOWTITLE eq Servidor Reproductor Web*" >nul 2>&1
call :GET_DESKTOP
del /q "%DESK%\Reproductor Web (Chrome).lnk" >nul 2>&1
del /q "%DESK%\Reproductor Web (Edge).lnk" >nul 2>&1
del /q "%LN_FILE%" >nul 2>&1
del /q "%PS_FILE%" >nul 2>&1
del /q "%PROJ%\servidor.log" >nul 2>&1
del /q "%PROJ%\servidor.log.old" >nul 2>&1
del /q "%PS_LNK%" >nul 2>&1
if exist "%PERFIL_BASE%" rd /s /q "%PERFIL_BASE%" >nul 2>&1
del /q "%PROJ%\cors_state.json" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJ%\_RepararCors.ps1" -Accion Deshacer -Silencioso >nul 2>&1
set "FFROOT=%APPDATA%\Mozilla\Firefox\Profiles"
if exist "%FFROOT%" for /d %%P in ("%FFROOT%\*") do call :FF_UNPATCH "%%~fP"
call :LOG "Reversion completada. (Si Firefox conserva el valor, restablecelo en about:config)"
goto OP_END

:OP_END
echo.
pause
goto MENU

:SALIR
call :LOG "Sesion finalizada."
popd
exit /b 0

REM ============================ SUBRUTINAS ==============================

:LOG
echo [%time:~0,8%] %~1
>>"%LOG%" echo [%date% %time:~0,8%] %~1
exit /b 0

:SHOW
set "V=NO ENCONTRADO"
if defined %~2 call set "V=%%%~2%%"
echo   %~1: %V%
exit /b 0

:CHECK_PROJ
if exist "%PROJ%\%HTML_NAME%" exit /b 0
call :LOG "[ERROR] No se encontro %HTML_NAME% en %PROJ%"
echo  Copia este .bat a la MISMA carpeta donde esta el archivo .html del reproductor.
exit /b 1

:AUTOCLOSE
if not "%CERRAR_CONSOLA%"=="1" exit /b 0
echo.
echo  Servidor iniciado. Esta consola se cerrara en 3 segundos...
timeout /t 3 /nobreak >nul
exit

:BUILD_FILE_URL
set "TMPP=%PROJ:\=/%"
set "FILE_URL=file:///%TMPP%/%HTML_NAME%"
exit /b 0

:GET_DESKTOP
set "DESK=%USERPROFILE%\Desktop"
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESK=%%D"
exit /b 0

:FIND_BROWSERS
set "CHROME="
set "EDGE="
set "FIREFOX="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do set "CHROME=%%B"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" set "FIREFOX=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" set "FIREFOX=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
exit /b 0

:FIND_PYTHON
set "PYCMD="
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PYCMD=python"
if defined PYCMD exit /b 0
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PYCMD=py -3"
exit /b 0

:FIND_PORT
set "PORT=%PORT_BASE%"
set /a TRIES=0
:FP_LOOP
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 exit /b 0
call :LOG "Puerto %PORT% ocupado, probando el siguiente..."
set /a PORT+=1
set /a TRIES+=1
if %TRIES% lss 30 goto FP_LOOP
call :LOG "[AVISO] No se hallo puerto libre; se usara %PORT%"
exit /b 0

:UNBLOCK_PERMS
call :LOG "Quitando marca de Internet (Zone.Identifier) de todos los archivos..."
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%PROJ%' -Recurse -Force -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue"
call :LOG "Quitando atributo de solo lectura..."
attrib -r "%PROJ%\*" /s /d >nul 2>&1
call :LOG "Concediendo control total a %USERNAME% sobre la carpeta..."
icacls "%PROJ%" /grant "%USERNAME%":(OI)(CI)F /T /C /Q >nul 2>&1
call :LOG "Permisos reparados."
exit /b 0

:START_SERVER
call :CHECK_PROJ
if errorlevel 1 exit /b 1
call :FIND_PYTHON
if /i "%MOTOR%"=="POWERSHELL" goto SS_PS
if defined PYCMD goto SS_PY
if /i "%MOTOR%"=="PYTHON" goto SS_NOPY
goto SS_PS
:SS_NOPY
call :LOG "[ERROR] Motor PYTHON elegido pero Python no esta instalado. Usa la opcion M para cambiar el motor."
exit /b 1
:SS_PY
call :FIND_PORT
set "URL=http://localhost:%PORT%/%HTML_NAME%"
call :LOG "Iniciando servidor Python (%PYCMD%) en puerto %PORT%..."
start "Servidor Reproductor Web" /D "%PROJ%" cmd /k %PYCMD% -m http.server %PORT% --bind 127.0.0.1
timeout /t 2 /nobreak >nul
call :LOG "Abriendo %URL%"
explorer "%URL%"
exit /b 0
:SS_PS
call :WRITE_PS_SERVER
if errorlevel 1 exit /b 1
call :LOG "Iniciando servidor PowerShell (puerto base %PORT_BASE%, busca otro si esta ocupado)..."
start "Servidor Reproductor Web" /D "%PROJ%" powershell -NoProfile -ExecutionPolicy Bypass -File ".\_Servidor.ps1" -Root . -Port %PORT_BASE% -DefaultDoc "%HTML_NAME%" -Abrir
exit /b 0

:WRITE_PS_SERVER
call :EXTRACT "#PS#" "%PS_FILE%"
if exist "%PS_FILE%" exit /b 0
call :LOG "[ERROR] No se pudo crear %PS_FILE% (revisa permisos de escritura)."
exit /b 1

REM  Extrae del propio .bat las lineas que empiezan por el prefijo %1
REM  (sin el prefijo) y las guarda en el archivo %2.
:EXTRACT
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%~1'; $l = Get-Content -LiteralPath '%SELF%' | Where-Object { $_.StartsWith($p) } | ForEach-Object { $_.Substring($p.Length) }; Set-Content -LiteralPath '%~2' -Value $l -Encoding ASCII"
exit /b 0

:FF_PATCH
set "UJ=%~1\user.js"
if exist "%UJ%" findstr /c:"security.fileuri.strict_origin_policy" "%UJ%" >nul 2>&1
if exist "%UJ%" if not errorlevel 1 exit /b 0
if exist "%UJ%" if not exist "%UJ%.bak_reproductor" copy /y "%UJ%" "%UJ%.bak_reproductor" >nul
>>"%UJ%" echo user_pref("security.fileuri.strict_origin_policy", false);
call :LOG "Firefox parcheado en perfil: %~1"
exit /b 0

:FF_UNPATCH
set "UJ=%~1\user.js"
if not exist "%UJ%" exit /b 0
findstr /v /c:"security.fileuri.strict_origin_policy" "%UJ%" >"%UJ%.tmp"
move /y "%UJ%.tmp" "%UJ%" >nul
if exist "%UJ%.bak_reproductor" del /q "%UJ%.bak_reproductor"
call :LOG "Revertido user.js en %~1"
exit /b 0

REM ======================================================================
REM  FIN DEL CODIGO EJECUTABLE.  Todo lo que sigue son DATOS EMBEBIDOS que
REM  :EXTRACT copia a archivos (#PS# = _Servidor.ps1, #LN# = lanzador,
REM  #LK# = creador de accesos directos). cmd nunca llega a leerlos.
REM ======================================================================
exit /b 0
#PS#<#
#PS#  _Servidor.ps1  -  Servidor HTTP local para el Reproductor Web
#PS#  Requiere Windows PowerShell 5.1 (o superior). No necesita Python ni nada extra.
#PS#
#PS#  Caracteristicas:
#PS#    - Sirve la carpeta (por defecto la actual) en http://localhost:PUERTO/
#PS#    - Soporta peticiones Range (206) -> se puede avanzar/retroceder en audio y video
#PS#    - GET, HEAD y OPTIONS, CORS abierto, ETag / If-None-Match (304) / If-Range
#PS#    - Atiende varias peticiones a la vez (pool de hilos)
#PS#    - Proteccion contra salida de la carpeta (path traversal), archivos ocultos
#PS#      (que empiezan por punto) y extensiones sensibles (.ps1 .bat .cmd .log ...)
#PS#    - Busca automaticamente un puerto libre si el elegido esta ocupado
#PS#    - Registro en consola y en servidor.log (rota al pasar de 2 MB)
#PS#    - Pulsa Q para detenerlo (o Ctrl+C, o cierra la ventana)
#PS#
#PS#  Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File .\_Servidor.ps1 -Root . -Port 8000 -Abrir
#PS##>
#PS#[CmdletBinding()]
#PS#param(
#PS#    [string]$Root = '.',
#PS#    [int]$Port = 8000,
#PS#    [string]$DefaultDoc = 'index.html',
#PS#    [int]$MaxPortTries = 40,
#PS#    [int]$MaxThreads = 16,
#PS#    [string]$LogFile = '',
#PS#    [switch]$Abrir,
#PS#    [switch]$Silencioso
#PS#)
#PS#
#PS#$ErrorActionPreference = 'Stop'
#PS#$script:LastError = ''
#PS#
#PS## ---------------------------------------------------------------- utilidades
#PS#function Write-Info {
#PS#    param([string]$Text, [string]$Color = 'Gray')
#PS#    if (-not $Silencioso) { Write-Host $Text -ForegroundColor $Color }
#PS#}
#PS#
#PS#function Stop-WithError {
#PS#    param([string]$Text, [int]$Code = 1)
#PS#    Write-Host ''
#PS#    Write-Host ('[ERROR] ' + $Text) -ForegroundColor Red
#PS#    if (-not $Silencioso) { [void](Read-Host 'Pulsa Enter para cerrar') }
#PS#    exit $Code
#PS#}
#PS#
#PS#function Get-LineColor {
#PS#    param([string]$Line)
#PS#    if ($Line -match '^(\d{3}) ') {
#PS#        $c = [int]$Matches[1]
#PS#        if ($c -ge 500) { return 'Red' }
#PS#        if ($c -ge 400) { return 'Yellow' }
#PS#        if ($c -ge 300) { return 'DarkGray' }
#PS#        return 'Green'
#PS#    }
#PS#    return 'Gray'
#PS#}
#PS#
#PS## ------------------------------------------------------- carpeta raiz y doc
#PS#try {
#PS#    if (-not [IO.Path]::IsPathRooted($Root)) {
#PS#        $Root = Join-Path (Get-Location).ProviderPath $Root
#PS#    }
#PS#    $Root = [IO.Path]::GetFullPath($Root)
#PS#    if ($Root.Length -gt 3) { $Root = $Root.TrimEnd('\') }
#PS#}
#PS#catch {
#PS#    Stop-WithError ('Ruta raiz invalida: ' + $Root) 2
#PS#}
#PS#if (-not [IO.Directory]::Exists($Root)) {
#PS#    Stop-WithError ('No existe la carpeta a servir: ' + $Root) 2
#PS#}
#PS#
#PS#if (-not [IO.File]::Exists([IO.Path]::Combine($Root, $DefaultDoc))) {
#PS#    $first = Get-ChildItem -LiteralPath $Root -Filter '*.html' -File -ErrorAction SilentlyContinue | Select-Object -First 1
#PS#    if ($first) {
#PS#        Write-Info ('Aviso: no existe ' + $DefaultDoc + '; se usara ' + $first.Name) 'DarkYellow'
#PS#        $DefaultDoc = $first.Name
#PS#    }
#PS#    else {
#PS#        Write-Info ('Aviso: no hay ningun .html en ' + $Root) 'DarkYellow'
#PS#    }
#PS#}
#PS#
#PS## ----------------------------------------------------------------------- log
#PS#if ([string]::IsNullOrWhiteSpace($LogFile)) { $LogFile = Join-Path $Root 'servidor.log' }
#PS#$logWriter = $null
#PS#try {
#PS#    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 2MB)) {
#PS#        Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.old') -Force
#PS#    }
#PS#    $enc = New-Object System.Text.UTF8Encoding($false)
#PS#    $logWriter = New-Object System.IO.StreamWriter($LogFile, $true, $enc)
#PS#    $logWriter.AutoFlush = $true
#PS#}
#PS#catch {
#PS#    $logWriter = $null
#PS#    Write-Info ('Aviso: no se pudo abrir el log: ' + $_.Exception.Message) 'DarkYellow'
#PS#}
#PS#
#PS#$logQ = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
#PS#
#PS#function Flush-Log {
#PS#    $line = $null
#PS#    while ($logQ.TryDequeue([ref]$line)) {
#PS#        Write-Info $line (Get-LineColor $line)
#PS#        if ($logWriter) {
#PS#            try { $logWriter.WriteLine((Get-Date -Format 'yyyy-MM-dd ') + $line) } catch { }
#PS#        }
#PS#    }
#PS#}
#PS#
#PS## --------------------------------------------------------------- tipos MIME
#PS#$mime = @{
#PS#    '.html' = 'text/html; charset=utf-8';  '.htm' = 'text/html; charset=utf-8'
#PS#    '.js' = 'application/javascript; charset=utf-8'; '.mjs' = 'application/javascript; charset=utf-8'
#PS#    '.css' = 'text/css; charset=utf-8';    '.json' = 'application/json; charset=utf-8'
#PS#    '.map' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
#PS#    '.txt' = 'text/plain; charset=utf-8';  '.lrc' = 'text/plain; charset=utf-8'
#PS#    '.srt' = 'text/plain; charset=utf-8';  '.vtt' = 'text/vtt; charset=utf-8'
#PS#    '.csv' = 'text/csv; charset=utf-8';    '.xml' = 'application/xml; charset=utf-8'
#PS#    '.m3u' = 'audio/x-mpegurl';            '.m3u8' = 'application/vnd.apple.mpegurl'
#PS#    '.pls' = 'audio/x-scpls';              '.cue' = 'text/plain; charset=utf-8'
#PS#    '.mp3' = 'audio/mpeg';  '.m4a' = 'audio/mp4';  '.aac' = 'audio/aac'
#PS#    '.wav' = 'audio/wav';   '.ogg' = 'audio/ogg';  '.oga' = 'audio/ogg'
#PS#    '.opus' = 'audio/ogg';  '.flac' = 'audio/flac'; '.weba' = 'audio/webm'
#PS#    '.mp4' = 'video/mp4';   '.m4v' = 'video/mp4';  '.webm' = 'video/webm'
#PS#    '.ogv' = 'video/ogg';   '.mkv' = 'video/x-matroska'; '.mov' = 'video/quicktime'
#PS#    '.png' = 'image/png';   '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
#PS#    '.gif' = 'image/gif';   '.webp' = 'image/webp'; '.avif' = 'image/avif'
#PS#    '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.bmp' = 'image/bmp'
#PS#    '.woff' = 'font/woff';  '.woff2' = 'font/woff2'; '.ttf' = 'font/ttf'; '.otf' = 'font/otf'
#PS#    '.pdf' = 'application/pdf'; '.wasm' = 'application/wasm'
#PS#}
#PS#
#PS## ------------------------------------------------- manejador de cada peticion
#PS## Se ejecuta en un runspace independiente (varias peticiones en paralelo).
#PS#$handler = {
#PS#    param($ctx, $Root, $DefaultDoc, $Mime, $LogQ)
#PS#
#PS#    $sw = [Diagnostics.Stopwatch]::StartNew()
#PS#    $req = $ctx.Request
#PS#    $res = $ctx.Response
#PS#    $status = 200
#PS#    $sent = [int64]0
#PS#    $method = '?'
#PS#    $rawUrl = '?'
#PS#    $note = ''
#PS#
#PS#    function Set-H {
#PS#        param($Res, [string]$Name, [string]$Value)
#PS#        try { $Res.Headers.Set($Name, $Value) } catch { }
#PS#    }
#PS#
#PS#    function Send-Text {
#PS#        param($Res, [int]$Code, [string]$Text, [bool]$HeadOnly)
#PS#        $Res.StatusCode = $Code
#PS#        $Res.ContentType = 'text/plain; charset=utf-8'
#PS#        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
#PS#        $Res.ContentLength64 = $bytes.Length
#PS#        if ($HeadOnly) { return [int64]0 }
#PS#        $Res.OutputStream.Write($bytes, 0, $bytes.Length)
#PS#        return [int64]$bytes.Length
#PS#    }
#PS#
#PS#    try {
#PS#        $method = $req.HttpMethod.ToUpperInvariant()
#PS#        $rawUrl = $req.RawUrl
#PS#        $isHead = ($method -eq 'HEAD')
#PS#
#PS#        Set-H $res 'Server' 'ReproductorLocal-PS'
#PS#        Set-H $res 'X-Content-Type-Options' 'nosniff'
#PS#        Set-H $res 'Access-Control-Allow-Origin' '*'
#PS#        Set-H $res 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS'
#PS#        Set-H $res 'Access-Control-Allow-Headers' 'Range, If-Range, If-None-Match, Content-Type'
#PS#        Set-H $res 'Access-Control-Expose-Headers' 'Content-Length, Content-Range, Accept-Ranges, ETag'
#PS#
#PS#        if ($method -eq 'OPTIONS') {
#PS#            $status = 204
#PS#            $res.StatusCode = 204
#PS#            $res.ContentLength64 = 0
#PS#        }
#PS#        elseif (($method -ne 'GET') -and ($method -ne 'HEAD')) {
#PS#            $status = 405
#PS#            Set-H $res 'Allow' 'GET, HEAD, OPTIONS'
#PS#            $sent = Send-Text $res 405 'Metodo no permitido' $false
#PS#        }
#PS#        else {
#PS#            # ---- 1) decodificar y resolver la ruta
#PS#            $urlPath = $req.Url.AbsolutePath
#PS#            $rel = ''
#PS#            $badUrl = $false
#PS#            try { $rel = [Uri]::UnescapeDataString($urlPath) } catch { $badUrl = $true }
#PS#            if ($badUrl -or ($rel.IndexOf([char]0) -ge 0)) {
#PS#                $status = 400
#PS#                $sent = Send-Text $res 400 'Solicitud invalida' $isHead
#PS#            }
#PS#            else {
#PS#                $rel = $rel.Replace('/', '\').TrimStart('\')
#PS#                $full = $null
#PS#                try { $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $rel)) } catch { $full = $null }
#PS#                $rootSlash = $Root.TrimEnd('\') + '\'
#PS#
#PS#                $hidden = $false
#PS#                foreach ($seg in $rel.Split('\')) {
#PS#                    if (($seg.Length -gt 0) -and $seg.StartsWith('.')) { $hidden = $true }
#PS#                }
#PS#
#PS#                if (($null -eq $full) -or $hidden -or (-not (($full + '\').StartsWith($rootSlash, [StringComparison]::OrdinalIgnoreCase)))) {
#PS#                    $status = 403
#PS#                    $sent = Send-Text $res 403 'Acceso denegado' $isHead
#PS#                }
#PS#                else {
#PS#                    # ---- 2) carpetas: redirigir a "/" y servir documento por defecto
#PS#                    $redirected = $false
#PS#                    if ([IO.Directory]::Exists($full)) {
#PS#                        if (-not $urlPath.EndsWith('/')) {
#PS#                            $status = 301
#PS#                            $q = ''
#PS#                            if ($req.Url.Query) { $q = $req.Url.Query }
#PS#                            Set-H $res 'Location' ($urlPath + '/' + $q)
#PS#                            $res.StatusCode = 301
#PS#                            $res.ContentLength64 = 0
#PS#                            $redirected = $true
#PS#                        }
#PS#                        else {
#PS#                            $found = $null
#PS#                            foreach ($cand in @($DefaultDoc, 'index.html', 'index.htm')) {
#PS#                                $p = [IO.Path]::Combine($full, $cand)
#PS#                                if ([IO.File]::Exists($p)) { $found = $p; break }
#PS#                            }
#PS#                            if ($found) { $full = $found } else { $full = $null }
#PS#                        }
#PS#                    }
#PS#
#PS#                    if (-not $redirected) {
#PS#                        $ext = ''
#PS#                        if ($full) { $ext = [IO.Path]::GetExtension($full).ToLowerInvariant() }
#PS#                        $denied = @('.ps1', '.bat', '.cmd', '.vbs', '.log', '.old', '.lnk')
#PS#
#PS#                        if ((-not $full) -or (-not [IO.File]::Exists($full))) {
#PS#                            $status = 404
#PS#                            $sent = Send-Text $res 404 'No encontrado' $isHead
#PS#                        }
#PS#                        elseif ($denied -contains $ext) {
#PS#                            $status = 403
#PS#                            $sent = Send-Text $res 403 'Acceso denegado' $isHead
#PS#                        }
#PS#                        else {
#PS#                            # ---- 3) cabeceras del archivo
#PS#                            $fi = New-Object IO.FileInfo($full)
#PS#                            $len = [int64]$fi.Length
#PS#                            $ctype = 'application/octet-stream'
#PS#                            if ($Mime.ContainsKey($ext)) { $ctype = $Mime[$ext] }
#PS#                            $etag = '"{0:x}-{1:x}"' -f $fi.LastWriteTimeUtc.Ticks, $len
#PS#                            $lastMod = $fi.LastWriteTimeUtc.ToString('R', [Globalization.CultureInfo]::InvariantCulture)
#PS#
#PS#                            Set-H $res 'ETag' $etag
#PS#                            Set-H $res 'Last-Modified' $lastMod
#PS#                            Set-H $res 'Accept-Ranges' 'bytes'
#PS#                            Set-H $res 'Cache-Control' 'no-cache'
#PS#                            $res.ContentType = $ctype
#PS#
#PS#                            $inm = $req.Headers['If-None-Match']
#PS#                            if ($inm -and ($inm -eq $etag)) {
#PS#                                $status = 304
#PS#                                $res.StatusCode = 304
#PS#                                $res.ContentLength64 = 0
#PS#                            }
#PS#                            else {
#PS#                                # ---- 4) Range
#PS#                                $start = [int64]0
#PS#                                $end = $len - 1
#PS#                                $partial = $false
#PS#                                $unsat = $false
#PS#                                $rh = $req.Headers['Range']
#PS#                                $ifr = $req.Headers['If-Range']
#PS#                                if ($rh -and ((-not $ifr) -or ($ifr -eq $etag))) {
#PS#                                    $m = [regex]::Match($rh.Trim(), '^bytes=(\d*)-(\d*)$')
#PS#                                    if ($m.Success -and (($m.Groups[1].Value -ne '') -or ($m.Groups[2].Value -ne ''))) {
#PS#                                        if ($m.Groups[1].Value -eq '') {
#PS#                                            $suffix = [int64]$m.Groups[2].Value
#PS#                                            if ($suffix -le 0) { $unsat = $true }
#PS#                                            else {
#PS#                                                $start = [Math]::Max([int64]0, $len - $suffix)
#PS#                                                $end = $len - 1
#PS#                                                $partial = $true
#PS#                                            }
#PS#                                        }
#PS#                                        else {
#PS#                                            $start = [int64]$m.Groups[1].Value
#PS#                                            if ($m.Groups[2].Value -ne '') {
#PS#                                                $end = [Math]::Min([int64]$m.Groups[2].Value, $len - 1)
#PS#                                            }
#PS#                                            else { $end = $len - 1 }
#PS#                                            if (($start -ge $len) -or ($start -gt $end)) { $unsat = $true }
#PS#                                            else { $partial = $true }
#PS#                                        }
#PS#                                    }
#PS#                                }
#PS#                                if ($len -eq 0) { $partial = $false; $unsat = $false; $start = [int64]0; $end = [int64]-1 }
#PS#
#PS#                                if ($unsat) {
#PS#                                    $status = 416
#PS#                                    Set-H $res 'Content-Range' ('bytes */' + $len)
#PS#                                    $sent = Send-Text $res 416 'Rango no satisfactorio' $isHead
#PS#                                }
#PS#                                else {
#PS#                                    if (-not $partial) { $start = [int64]0; $end = $len - 1 }
#PS#                                    $count = $end - $start + 1
#PS#                                    if ($count -lt 0) { $count = [int64]0 }
#PS#                                    if ($partial) {
#PS#                                        $status = 206
#PS#                                        $res.StatusCode = 206
#PS#                                        Set-H $res 'Content-Range' ('bytes ' + $start + '-' + $end + '/' + $len)
#PS#                                    }
#PS#                                    $res.ContentLength64 = $count
#PS#
#PS#                                    # ---- 5) enviar el contenido por bloques de 64 KB
#PS#                                    if ((-not $isHead) -and ($count -gt 0)) {
#PS#                                        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
#PS#                                        $fs = $null
#PS#                                        try {
#PS#                                            $fs = New-Object IO.FileStream -ArgumentList @($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share, 65536)
#PS#                                            [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
#PS#                                            $buf = New-Object byte[] 65536
#PS#                                            $remaining = $count
#PS#                                            $out = $res.OutputStream
#PS#                                            while ($remaining -gt 0) {
#PS#                                                $toRead = [int][Math]::Min([int64]$buf.Length, $remaining)
#PS#                                                $n = $fs.Read($buf, 0, $toRead)
#PS#                                                if ($n -le 0) { break }
#PS#                                                $out.Write($buf, 0, $n)
#PS#                                                $remaining -= $n
#PS#                                                $sent += $n
#PS#                                            }
#PS#                                        }
#PS#                                        finally {
#PS#                                            if ($fs) { $fs.Dispose() }
#PS#                                        }
#PS#                                    }
#PS#                                }
#PS#                            }
#PS#                        }
#PS#                    }
#PS#                }
#PS#            }
#PS#        }
#PS#    }
#PS#    catch {
#PS#        $ex = $_.Exception
#PS#        $inner = $ex.InnerException
#PS#        if (($ex -is [System.Net.HttpListenerException]) -or ($ex -is [System.IO.IOException]) -or
#PS#            ($inner -is [System.Net.HttpListenerException]) -or ($inner -is [System.IO.IOException])) {
#PS#            $note = ' [cliente cerro la conexion]'
#PS#        }
#PS#        else {
#PS#            $note = ' [ERROR: ' + $ex.Message + ']'
#PS#            try {
#PS#                $status = 500
#PS#                [void](Send-Text $res 500 'Error interno del servidor' $false)
#PS#            }
#PS#            catch { }
#PS#        }
#PS#    }
#PS#    finally {
#PS#        try { $res.OutputStream.Close() } catch { }
#PS#        try { $res.Close() } catch { }
#PS#        $sw.Stop()
#PS#        $line = '{0} {1} {2,-4} {3} ({4} bytes, {5} ms){6}' -f $status, (Get-Date -Format 'HH:mm:ss'), $method, $rawUrl, $sent, $sw.ElapsedMilliseconds, $note
#PS#        $LogQ.Enqueue($line)
#PS#    }
#PS#}
#PS#
#PS## ---------------------------------------------------- abrir el puerto libre
#PS#function New-Listener {
#PS#    param([int]$P, [string[]]$Hosts)
#PS#    $l = New-Object System.Net.HttpListener
#PS#    foreach ($h in $Hosts) { $l.Prefixes.Add('http://' + $h + ':' + $P + '/') }
#PS#    try {
#PS#        $l.Start()
#PS#        return $l
#PS#    }
#PS#    catch {
#PS#        $script:LastError = $_.Exception.Message.Trim()
#PS#        try { $l.Close() } catch { }
#PS#        return $null
#PS#    }
#PS#}
#PS#
#PS#$listener = $null
#PS#$bound = 0
#PS#for ($i = 0; ($i -lt $MaxPortTries) -and (-not $listener); $i++) {
#PS#    $p2 = $Port + $i
#PS#    $listener = New-Listener $p2 @('localhost', '127.0.0.1')
#PS#    if (-not $listener) { $listener = New-Listener $p2 @('localhost') }
#PS#    if ($listener) { $bound = $p2 }
#PS#    else { Write-Info ('Puerto ' + $p2 + ' no disponible (' + $script:LastError + ')') 'DarkYellow' }
#PS#}
#PS#if (-not $listener) {
#PS#    Stop-WithError ('No se pudo abrir ningun puerto entre ' + $Port + ' y ' + ($Port + $MaxPortTries - 1) + '. Ultimo error: ' + $script:LastError) 3
#PS#}
#PS#
#PS#$url = 'http://localhost:' + $bound + '/'
#PS#$openUrl = $url + [Uri]::EscapeDataString($DefaultDoc)
#PS#try { $Host.UI.RawUI.WindowTitle = 'Servidor Reproductor Web - ' + $url } catch { }
#PS#
#PS#Write-Info ''
#PS#Write-Info '==============================================================' 'Cyan'
#PS#Write-Info '   SERVIDOR LOCAL - REPRODUCTOR WEB  (PowerShell)' 'Cyan'
#PS#Write-Info '==============================================================' 'Cyan'
#PS#Write-Info ('   Carpeta : ' + $Root) 'White'
#PS#Write-Info ('   Pagina  : ' + $openUrl) 'White'
#PS#Write-Info ('   Log     : ' + $LogFile) 'Gray'
#PS#Write-Info '--------------------------------------------------------------' 'Cyan'
#PS#Write-Info '   Pulsa Q para detener (o Ctrl+C / cierra esta ventana).' 'DarkGray'
#PS#Write-Info ''
#PS#
#PS#if ($Abrir) {
#PS#    try { Start-Process -FilePath 'explorer.exe' -ArgumentList $openUrl }
#PS#    catch {
#PS#        try { Start-Process $openUrl }
#PS#        catch { Write-Info ('No se pudo abrir el navegador. Abre manualmente: ' + $openUrl) 'Yellow' }
#PS#    }
#PS#}
#PS#
#PS## ------------------------------------------------------- bucle principal
#PS#$pool = [runspacefactory]::CreateRunspacePool(1, $MaxThreads)
#PS#$pool.Open()
#PS#$jobs = New-Object System.Collections.ArrayList
#PS#$stopRequested = $false
#PS#
#PS#function Clear-Jobs {
#PS#    for ($j = $jobs.Count - 1; $j -ge 0; $j--) {
#PS#        $job = $jobs[$j]
#PS#        if ($job.Handle.IsCompleted) {
#PS#            try { [void]$job.PS.EndInvoke($job.Handle) } catch { }
#PS#            try { $job.PS.Dispose() } catch { }
#PS#            $jobs.RemoveAt($j)
#PS#        }
#PS#    }
#PS#}
#PS#
#PS#try {
#PS#    $task = $listener.GetContextAsync()
#PS#    while ($listener.IsListening -and (-not $stopRequested)) {
#PS#        $ready = $false
#PS#        try { $ready = $task.Wait(200) }
#PS#        catch {
#PS#            if (-not $listener.IsListening) { break }
#PS#            Start-Sleep -Milliseconds 50
#PS#            $task = $listener.GetContextAsync()
#PS#            continue
#PS#        }
#PS#
#PS#        if ($ready) {
#PS#            $ctx = $null
#PS#            try { $ctx = $task.Result } catch { $ctx = $null }
#PS#            $task = $listener.GetContextAsync()
#PS#            if ($ctx) {
#PS#                try {
#PS#                    $ps = [powershell]::Create()
#PS#                    $ps.RunspacePool = $pool
#PS#                    [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($Root).AddArgument($DefaultDoc).AddArgument($mime).AddArgument($logQ)
#PS#                    $handle = $ps.BeginInvoke()
#PS#                    [void]$jobs.Add([pscustomobject]@{ PS = $ps; Handle = $handle })
#PS#                }
#PS#                catch {
#PS#                    try { $ctx.Response.Abort() } catch { }
#PS#                }
#PS#            }
#PS#        }
#PS#
#PS#        try {
#PS#            if ([Console]::KeyAvailable) {
#PS#                $k = [Console]::ReadKey($true)
#PS#                if ($k.Key -eq [ConsoleKey]::Q) { $stopRequested = $true }
#PS#            }
#PS#        }
#PS#        catch { }
#PS#
#PS#        Flush-Log
#PS#        Clear-Jobs
#PS#    }
#PS#}
#PS#catch {
#PS#    Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red
#PS#}
#PS#finally {
#PS#    Write-Info ''
#PS#    Write-Info 'Deteniendo servidor...' 'Yellow'
#PS#    try { $listener.Stop() } catch { }
#PS#    try { $listener.Close() } catch { }
#PS#    try { $pool.Close(); $pool.Dispose() } catch { }
#PS#    Flush-Log
#PS#    if ($logWriter) { try { $logWriter.Dispose() } catch { } }
#PS#    Write-Info 'Servidor detenido.' 'Yellow'
#PS#}
#LN#@echo off
#LN#setlocal EnableExtensions
#LN#REM ----------------------------------------------------------------
#LN#REM  Iniciar_Reproductor.bat  -  generado por Reparar_ReproductorWeb.bat
#LN#REM  Debe estar en la MISMA carpeta que el .html y que _Servidor.ps1
#LN#REM ----------------------------------------------------------------
#LN#pushd "%~dp0"
#LN#title Iniciar Reproductor Web
#LN#set "PORT=8000"
#LN#if not exist "_Servidor.ps1" goto SIN_SERVIDOR
#LN#start "Servidor Reproductor Web" powershell -NoProfile -ExecutionPolicy Bypass -File ".\_Servidor.ps1" -Root . -Port %PORT% -Abrir
#LN#exit
#LN#:SIN_SERVIDOR
#LN#echo [ERROR] No se encontro _Servidor.ps1 en esta carpeta.
#LN#echo Ejecuta de nuevo Reparar_ReproductorWeb.bat y usa la opcion 8.
#LN#pause
#LN#exit /b 1
#LK#$w = New-Object -ComObject WScript.Shell
#LK#$s = $w.CreateShortcut($env:LNK_PATH)
#LK#$s.TargetPath = $env:LNK_TARGET
#LK#$s.Arguments = $env:LNK_ARGS
#LK#$s.WorkingDirectory = $env:LNK_WD
#LK#$s.IconLocation = $env:LNK_TARGET + ',0'
#LK#$s.Save()
