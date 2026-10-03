@echo off
setlocal EnableDelayedExpansion
title Instalador Ollama - Qwen3.5-9B HighIQ Heretic Uncensored
chcp 65001 >nul

rem ============================================================
rem   CONFIGURACION - edita estas lineas si cambias nombres
rem   de archivo o quieres otro nombre de modelo en Ollama.
rem ============================================================
set "MODEL_NAME=Qwen3.5:9B-H"
set "GGUF_MAIN=Qwen3.5-9B-Claude-4.6-HighIQ-INSTRUCT-HERETIC-UNCENSORED.Q4_K_M.gguf"
set "GGUF_MMPROJ=Qwen3.5-9B-Claude-4.6-HighIQ-INSTRUCT-HERETIC-UNCENSORED.mmproj-Q8_0.gguf"
set "MODELFILE=Modelfile"

rem Este .bat, los dos .gguf y el "Modelfile" deben estar en la misma carpeta.
cd /d "%~dp0"
if errorlevel 1 (
    echo [ERROR] No se pudo acceder a la carpeta del script.
    pause
    exit /b 1
)

echo ============================================================
echo   Instalador de modelo Ollama
echo   Modelo a crear : %MODEL_NAME%
echo   Carpeta        : %CD%
echo ============================================================
echo.

rem ---------- 1) Ollama instalado -------------------------------
echo [1/7] Comprobando Ollama...
where ollama >nul 2>&1
if not errorlevel 1 goto :OLLAMA_OK
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    goto :OLLAMA_OK
)
call :ERR "No se encontro 'ollama'. Descargalo e instalalo desde https://ollama.com/download y vuelve a ejecutar este script."
goto :FIN_ERROR

:OLLAMA_OK
for /f "usebackq delims=" %%V in (`ollama --version 2^>^&1`) do set "OLLAMA_VER=%%V"
echo       OK  -  !OLLAMA_VER!
echo.

rem ---------- 2) Servicio de Ollama activo -----------------------
echo [2/7] Comprobando que el servicio de Ollama responde...
ollama list >nul 2>&1
if not errorlevel 1 goto :SERVICIO_OK

echo       No responde. Iniciando "ollama serve" en segundo plano...
start "Ollama Serve" /min cmd /c "ollama serve"
set /a intentos=0

:ESPERA_SERVIDOR
set /a intentos+=1
timeout /t 2 /nobreak >nul
ollama list >nul 2>&1
if not errorlevel 1 goto :SERVICIO_OK
if !intentos! LSS 10 goto :ESPERA_SERVIDOR

call :ERR "El servicio de Ollama no respondio tras varios intentos. Abre otra ventana, ejecuta 'ollama serve' manualmente y vuelve a correr este script."
goto :FIN_ERROR

:SERVICIO_OK
echo       OK
echo.

rem ---------- 3) Archivos GGUF presentes --------------------------
echo [3/7] Comprobando archivos del modelo en esta carpeta...
if not exist "%GGUF_MAIN%" (
    call :ERR "Falta el archivo principal: %GGUF_MAIN% -- copialo en: %CD%"
    goto :FIN_ERROR
)
echo       OK    %GGUF_MAIN%

if not exist "%GGUF_MMPROJ%" (
    call :ERR "Falta el proyector de vision: %GGUF_MMPROJ% -- copialo en: %CD%"
    goto :FIN_ERROR
)
echo       OK    %GGUF_MMPROJ%   ^(proyector de vision^)
echo.

rem ---------- 4) Modelfile presente y valido -----------------------
echo [4/7] Comprobando "%MODELFILE%"...
if exist "%MODELFILE%" goto :MODELFILE_EXISTE
if exist "%MODELFILE%.txt" (
    call :ERR "Existe '%MODELFILE%.txt' pero Ollama necesita el archivo SIN extension, llamado exactamente '%MODELFILE%'. Quitale el .txt y ejecuta de nuevo."
) else (
    call :ERR "No se encontro '%MODELFILE%' en esta carpeta. Guarda el contenido del Modelfile con ese nombre exacto, sin extension .txt, en: %CD%"
)
goto :FIN_ERROR

:MODELFILE_EXISTE
for %%S in ("%MODELFILE%") do set "MF_SIZE=%%~zS"
if "%MF_SIZE%"=="0" (
    call :ERR "'%MODELFILE%' esta vacio."
    goto :FIN_ERROR
)

findstr /r /c:"^FROM" "%MODELFILE%" >nul 2>&1
if errorlevel 1 (
    call :ERR "'%MODELFILE%' no contiene ninguna linea FROM. Revisa que pegaste el contenido completo."
    goto :FIN_ERROR
)

rem Quita el BOM UTF-8 si Notepad lo agrego al guardar (puede romper el parser de Ollama)
powershell -NoProfile -Command "$p='%MODELFILE%'; $b=[IO.File]::ReadAllBytes($p); if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { [IO.File]::WriteAllBytes($p,$b[3..($b.Length-1)]); Write-Host '      BOM UTF-8 eliminado de %MODELFILE%' }"

echo       OK
echo.

rem ---------- 5) Anadir la linea FROM del proyector de vision -------
echo [5/7] Preparando "%MODELFILE%" para vision...
findstr /i /c:"%GGUF_MMPROJ%" "%MODELFILE%" >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "$t = [System.Environment]::NewLine + 'FROM ./%GGUF_MMPROJ%' + [System.Environment]::NewLine; $enc = New-Object System.Text.UTF8Encoding($false); [System.IO.File]::AppendAllText('%MODELFILE%', $t, $enc)"
    echo       Anadida linea: FROM ./%GGUF_MMPROJ%
) else (
    echo       El Modelfile ya referencia el mmproj, no se toca.
)
echo.
echo       AVISO IMPORTANTE:
echo       Ollama todavia tiene un fallo conocido y sin resolver con la
echo       arquitectura de Qwen3.5 cuando se usa un mmproj separado
echo       (error tipico: "unknown model architecture: 'qwen35'").
echo       'ollama create' va a funcionar sin problema, pero al probar
echo       una imagen con 'ollama run' puede fallar por esto mismo.
echo       Si pasa, no es un fallo tuyo ni del Modelfile.
echo.

rem ---------- 6) Crear el modelo en Ollama --------------------------
echo [6/7] Creando el modelo "%MODEL_NAME%"...
echo       (puede tardar varios minutos la primera vez)
echo.
ollama create "%MODEL_NAME%" -f "%MODELFILE%"
if errorlevel 1 (
    echo.
    call :ERR "'ollama create' fallo. Revisa los mensajes de arriba."
    goto :FIN_ERROR
)
echo.
echo       OK - modelo creado correctamente
echo.

rem ---------- 7) Verificar --------------------------------------------
echo [7/7] Verificando en "ollama list"...
ollama list | findstr /i "%MODEL_NAME%" >nul 2>&1
if errorlevel 1 (
    echo       AVISO: no aparece en el listado, pero 'ollama create' no reporto error.
) else (
    echo       OK - "%MODEL_NAME%" aparece en la lista
)

echo.
echo ============================================================
echo   INSTALACION COMPLETADA
echo   Para chatear despues:      ollama run "%MODEL_NAME%"
echo   Para probar con imagen:    dentro del chat, escribe la ruta
echo                              de una imagen junto al mensaje.
echo.
echo   Si al mandar una imagen sale "unknown model architecture",
echo   es el fallo conocido de Ollama con Qwen3.5 + mmproj. Plan B:
echo   quita la linea "FROM ./%GGUF_MMPROJ%" del Modelfile, vuelve a
echo   ejecutar este script (quedara solo texto), o usa llama.cpp
echo   directamente para vision (vease la pagina del modelo en HF).
echo ============================================================
echo.

choice /c SN /n /m "Quieres ejecutarlo ahora? (S = Si, N = No): "
if errorlevel 2 goto :FIN_OK
echo.
ollama run "%MODEL_NAME%"

:FIN_OK
echo.
pause
exit /b 0

:FIN_ERROR
echo.
echo El proceso se detuvo. Revisa el mensaje de arriba.
pause
exit /b 1

:ERR
echo.
echo   [ERROR] %~1
echo.
goto :eof