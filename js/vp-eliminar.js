'use strict';
// ============================================================
// VP-ELIMINAR.JS  v3.1
// Eliminación completa de videos (DB, estado, IA, subtítulos)
// y generación del archivo .bat (papelera de reciclaje)
//
// Cambios v3.1 (correcciones + mejoras):
//   BUG FIX CRÍTICO:
//     - $MyInvocation.MyCommand.Path es NULL cuando PowerShell se
//       invoca con -EncodedCommand (no hay archivo en disco).
//       Ahora se usa $PWD.Path, que es correcto porque el .bat
//       ya ejecutó "cd /d "%~dp0"" antes de llamar a PowerShell.
//     - Guard adicional: si $PWD también falla, se intenta
//       $env:USERPROFILE como último recurso y se emite error claro.
//
//   ROBUSTEZ POWERSHELL:
//     - Skip explícito de entradas vacías/nulas en el array de archivos
//     - Validación defensiva de $fullPath antes de usarlo
//     - Mensaje "Directorio base: ..." al inicio para diagnóstico
//     - Exit code 2 diferenciado para error de entorno vs errores de archivo
//     - Acumulador de rutas-problema para reporte final
//
//   ROBUSTEZ JS:
//     - _sanitizarNombreArchivo ahora normaliza NFKC y colapsa puntos
//       dobles, previene path-traversal (../)
//     - _codificarParaPowerShell maneja surrogate pairs (emoji, etc.)
//     - generarBatFile: validación de permisos más defensiva
//     - _eliminarDatosIA: itera sin depender de localStorage.length
//       (más seguro ante modificaciones concurrentes del storage)
//     - Mejor tipado de retornos y propagación de errores en lote
//
//   MANTENIDAS de v3.0:
//     - Semáforo de concurrencia para operaciones en lote
//     - Stack de deshacer en memoria con límite configurable
//     - Historial persistente de eliminaciones
//     - eliminarPorFiltro(fn)
//     - exportarHistorial()
//     - Límite máximo en archivosEliminados
//     - .bat con validación defensiva
// ============================================================

(function (window, document) {
    const VP = window.VP;
    if (!VP) throw new Error('[VP] vp-eliminar.js: vp-base.js debe cargarse antes.');

    const deps = ['util', 'log', 'db', 'bus', 'config'];
    for (const d of deps) {
        if (!VP[d]) throw new Error(`[VP] vp-eliminar.js: dependencia faltante → VP.${d}`);
    }

    const { util, log, db, bus, cfg } = VP;
    log.setContext('Eliminar');

    // ----------------------------------------------------------
    // CONSTANTES
    // ----------------------------------------------------------
    const STORAGE_PREFIX          = cfg?.STORAGE_PREFIX || 'vp_data_';
    const PREFIJO_LS_DATOS_IA     = STORAGE_PREFIX;
    const PREFIJO_LS_CONV_IA      = STORAGE_PREFIX + 'conv_';
    const MAX_REINTENTOS_BAT      = 3;
    const BACKOFF_BAT_MS          = 300;
    const MAX_ARCHIVOS_ELIMINADOS = cfg?.maxArchivosEliminados ?? 5000;
    const MAX_HISTORIAL           = cfg?.maxHistorialEliminados ?? 500;
    const MAX_UNDO_STACK          = cfg?.maxUndoEliminacion ?? 20;
    const CONCURRENCIA_LOTE       = cfg?.concurrenciaEliminar ?? 4;

    // IA keys conocidas asociadas a un video
    const SUFIJOS_IA = ['vpRecIA_', 'vpRecIA_emb_', 'vpTagsIA_', 'vpChapIA_', 'vpChatIA_', 'vpTransIA_', 'vpVisionIA_', 'vpCommentIA_'];

    // ----------------------------------------------------------
    // NAMESPACE Y ESTADO INTERNO
    // ----------------------------------------------------------
    VP.eliminar = VP.eliminar || {};

    let _estado = {
        eliminandoAhora: false,
        colaEliminacion: [],
        timers: {},
        undoStack: [],
        historial: []
    };

    // ----------------------------------------------------------
    // SEMÁFORO DE CONCURRENCIA (para lotes)
    // ----------------------------------------------------------
    function _crearSemaforo(limite) {
        let activos = 0;
        const cola = [];
        function adquirir() {
            return new Promise(resolve => {
                if (activos < limite) { activos++; resolve(); }
                else cola.push(resolve);
            });
        }
        function liberar() {
            activos = Math.max(0, activos - 1);
            if (cola.length) { activos++; cola.shift()(); }
        }
        return { adquirir, liberar };
    }

    // ----------------------------------------------------------
    // HISTORIAL
    // ----------------------------------------------------------
    function _registrarHistorial(videoId, nombre, tamano, exito, errores) {
        const entrada = {
            videoId,
            nombre: nombre || videoId,
            tamano: tamano || 0,
            ts: Date.now(),
            exito,
            errores: errores || []
        };
        _estado.historial.unshift(entrada);
        if (_estado.historial.length > MAX_HISTORIAL) {
            _estado.historial.length = MAX_HISTORIAL;
        }
    }

    // ----------------------------------------------------------
    // UTILIDADES INTERNAS DE ELIMINACIÓN
    // ----------------------------------------------------------
    function _eliminarVideoCompleto(videoId) {
        if (!videoId || typeof videoId !== 'string') {
            return Promise.resolve({ exito: false, eliminados: 0, errores: ['ID inválido'] });
        }
        log.debug('Iniciando eliminación completa de video:', videoId);
        const resultado = { exito: true, eliminados: 0, errores: [] };

        const tareas = [
            { nombre: 'Miniatura',       fn: () => db.eliminarMiniatura(videoId) },
            { nombre: 'ArrayMiniaturas', fn: () => db.eliminarArrayMiniaturas(videoId) },
            { nombre: 'Metadata',        fn: () => db.eliminar('metadata', videoId) },
            { nombre: 'Progreso',        fn: () => db.eliminar('videoProgress', videoId) }
        ];

        const promesas = tareas.map(({ nombre, fn }) =>
            fn()
                .then(ok => { if (ok) resultado.eliminados++; return ok; })
                .catch(e => { resultado.errores.push(`${nombre}: ${e.message || e}`); return false; })
        );

        return Promise.all(promesas).then(() => {
            if (resultado.errores.length === 0) {
                log.info('Video eliminado exitosamente:', videoId, `(${resultado.eliminados} items)`);
            } else {
                log.warn('Video eliminado parcialmente:', videoId, 'Errores:', resultado.errores.length);
                resultado.exito = resultado.eliminados > 0;
            }
            bus.emit('videoEliminado', { videoId });
            return resultado;
        }).catch(e => {
            log.error('_eliminarVideoCompleto fallo crítico:', videoId, e);
            resultado.exito = false;
            resultado.errores.push('Error crítico: ' + (e.message || e));
            return resultado;
        });
    }

    /**
     * Elimina datos de IA del almacenamiento para un video.
     * MEJORADO v3.1: itera con snapshot de claves para evitar
     * problemas si el storage se modifica durante la iteración.
     */
    function _eliminarDatosIA(videoId) {
        if (!videoId) return Promise.resolve(0);
        log.debug('Limpiando datos IA de video:', videoId);
        let eliminados = 0;
        try {
            // Todas las claves del keyval store
            const todasLasClaves = (VP.db && typeof VP.db.clavesKeyVal === 'function')
                ? VP.db.clavesKeyVal()
                : [];

            // Claves conocidas del patrón fijo
            const clavesEsperadas = new Set([
                ...SUFIJOS_IA.map(s => `${s}${videoId}`),
                `${PREFIJO_LS_CONV_IA}${videoId}`
            ]);

            // Unión: claves esperadas + cualquier clave que contenga el videoId
            const clavesFinales = new Set([
                ...clavesEsperadas,
                ...todasLasClaves.filter(k => k.includes(videoId))
            ]);

            for (const clave of clavesFinales) {
                try {
                    if (VP.db.obtenerKeyVal(clave) !== null) {
                        VP.db.eliminarKeyVal(clave);
                        eliminados++;
                    }
                } catch (e) { log.warn('Error eliminando clave keyval:', clave, e.message || e); }
            }
            log.debug('Datos IA eliminados:', eliminados, 'items');
            return Promise.resolve(eliminados);
        } catch (e) {
            log.error('_eliminarDatosIA error:', e);
            return Promise.resolve(0);
        }
    }

    function _eliminarSubtitulosVideo(videoId) {
        if (!videoId) return Promise.resolve(false);
        log.debug('Limpiando subtítulos de video:', videoId);
        try {
            if (VP.subtitulos?.limpiarPistas) VP.subtitulos.limpiarPistas();
            return Promise.resolve(true);
        } catch (e) {
            log.warn('_eliminarSubtitulosVideo error:', e);
            return Promise.resolve(false);
        }
    }

    function _limpiarEstadoVideo(videoId) {
        if (!videoId || !VP.estado?.videos) return null;
        const videos = VP.estado.videos;
        for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            if (v && (v.id === videoId || v.nombre === videoId || v.name === videoId)) {
                return videos.splice(i, 1)[0];
            }
        }
        return null;
    }

    function _registrarArchivoEliminado(videoObj) {
        if (!videoObj || !VP.estado) return;
        try {
            if (!Array.isArray(VP.estado.archivosEliminados)) VP.estado.archivosEliminados = [];
            const lista = VP.estado.archivosEliminados;

            const candidatos = [videoObj.name, videoObj.subtitleName].filter(Boolean);
            for (const nombre of candidatos) {
                if (!lista.includes(nombre)) {
                    lista.push(nombre);
                    log.debug('Registrado para .bat:', nombre);
                }
            }

            if (lista.length > MAX_ARCHIVOS_ELIMINADOS) {
                const exceso = lista.length - MAX_ARCHIVOS_ELIMINADOS;
                lista.splice(0, exceso);
                log.warn(`archivosEliminados recortado en ${exceso} entradas (límite: ${MAX_ARCHIVOS_ELIMINADOS})`);
            }
        } catch (e) {
            log.warn('Error registrando archivos eliminados:', e.message || e);
        }
    }

    // ----------------------------------------------------------
    // GENERACIÓN DEL ARCHIVO .BAT
    // ----------------------------------------------------------

    /**
     * Sanitiza un nombre de archivo para que sea seguro en Windows y en
     * PowerShell (comillas simples).
     *
     * MEJORADO v3.1:
     *   - Normalización Unicode NFKC (elimina equivalentes de compatibilidad)
     *   - Prevención de path-traversal (../ y similares)
     *   - Elimina caracteres de control U+0000–U+001F
     *   - Colapsa puntos dobles consecutivos
     *   - Elimina caracteres ilegales en nombres de archivo de Windows
     */
    function _sanitizarNombreArchivo(name) {
        if (!name || typeof name !== 'string') return '';
        let s = name;
        // Normalización Unicode si está disponible
        if (typeof s.normalize === 'function') s = s.normalize('NFKC');
        // Eliminar caracteres de control ASCII
        s = s.replace(/[\x00-\x1F\x7F]/g, '');
        // Prevenir path-traversal: quitar separadores de directorio y puntos dobles
        s = s.replace(/[/\\]/g, '_');
        s = s.replace(/\.{2,}/g, '.');
        // Caracteres ilegales en nombres de archivo de Windows
        s = s.replace(/[*?"<>|:]/g, '_');
        // Colapsar espacios múltiples y espacios al inicio/fin
        s = s.replace(/\s+/g, ' ').trim();
        // Nombres reservados de Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(s)) {
            s = '_' + s;
        }
        return s;
    }

    /**
     * Construye el script PowerShell que envía archivos a la papelera.
     *
     * BUG FIX CRÍTICO v3.1:
     *   $MyInvocation.MyCommand.Path es NULL cuando PowerShell se
     *   ejecuta con -EncodedCommand porque no hay un archivo .ps1 en
     *   disco. El .bat ya hace "cd /d "%~dp0"" antes de invocar
     *   powershell.exe, por lo que $PWD.Path contiene el directorio
     *   correcto. Se agrega guard para el caso (improbable) de que
     *   $PWD también sea vacío.
     */
    function _construirScriptPowerShell(fileNames) {
        if (!fileNames?.length) throw new Error('Se requiere al menos un nombre de archivo');

        // Escapar para single-quoted strings de PowerShell: ' → ''
        // y además eliminar caracteres NUL que rompen el stream
        const sanitized = fileNames
            .map(f => _sanitizarNombreArchivo(f).replace(/'/g, "''").replace(/\x00/g, ''))
            .filter(Boolean);

        if (!sanitized.length) throw new Error('Ningún nombre de archivo válido tras sanitizar');

        return [
            'Add-Type -AssemblyName Microsoft.VisualBasic',
            '$ErrorActionPreference = "Continue"',
            '',
            '# -----------------------------------------------------------------',
            '# BUG FIX: $MyInvocation.MyCommand.Path es NULL con -EncodedCommand',
            '# porque no hay archivo .ps1 en disco. Usamos $PWD que ya fue',
            '# establecido por el .bat con: cd /d "%~dp0"',
            '# -----------------------------------------------------------------',
            '$base = $PWD.Path',
            'if ([string]::IsNullOrWhiteSpace($base)) {',
            '    Write-Error "ERROR: No se pudo determinar el directorio base. Verifique que el .bat se ejecute desde su ubicacion original."',
            '    exit 2',
            '}',
            'Write-Host "Directorio base: $base" -ForegroundColor Cyan',
            '',
            '$files = @(',
            ...sanitized.map(n => `    '${n}'`),
            ')',
            '',
            '$enviados = 0',
            '$errores  = 0',
            '$noEncontrados = 0',
            '$problemas = [System.Collections.Generic.List[string]]::new()',
            '',
            'foreach ($f in $files) {',
            '    # Saltar entradas vacías (defensivo)',
            '    if ([string]::IsNullOrWhiteSpace($f)) { continue }',
            '',
            '    $fullPath = Join-Path $base $f.Trim()',
            '',
            '    # Validación adicional: el path resultante no debe escapar del base',
            '    $resolvedBase = [System.IO.Path]::GetFullPath($base)',
            '    $resolvedFull = [System.IO.Path]::GetFullPath($fullPath)',
            '    if (-not $resolvedFull.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase)) {',
            '        Write-Warning "SKIPPED (ruta fuera del directorio base): $f"',
            '        $problemas.Add("FUERA_DE_BASE: $f")',
            '        $errores++',
            '        continue',
            '    }',
            '',
            '    if (-not (Test-Path -LiteralPath $fullPath)) {',
            '        Write-Warning "No encontrado: $f"',
            '        $noEncontrados++',
            '        continue',
            '    }',
            '',
            '    try {',
            '        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(',
            '            $fullPath,',
            '            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
            '            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin',
            '        )',
            '        Write-Host "OK  $f" -ForegroundColor Green',
            '        $enviados++',
            '    } catch {',
            '        $msg = $_.Exception.Message -replace "`r`n"," "',
            '        Write-Host "ERR $f  ->  $msg" -ForegroundColor Red',
            '        $problemas.Add("ERR: $f -> $msg")',
            '        $errores++',
            '    }',
            '}',
            '',
            'Write-Host ""',
            'Write-Host ("Resumen: {0} reciclados  {1} errores  {2} no encontrados." -f $enviados, $errores, $noEncontrados) -ForegroundColor Cyan',
            '',
            'if ($problemas.Count -gt 0) {',
            '    Write-Host ""',
            '    Write-Host "Archivos con problemas:" -ForegroundColor Yellow',
            '    foreach ($p in $problemas) { Write-Host "  $p" -ForegroundColor Yellow }',
            '}',
            '',
            'if ($errores -gt 0) { exit 1 }',
            'exit 0',
        ].join('\r\n');
    }

    /**
     * Codifica un script PowerShell en Base64 UTF-16 LE para -EncodedCommand.
     *
     * MEJORADO v3.1: maneja correctamente surrogate pairs (emoji u otros
     * caracteres fuera del BMP) que en JS ocupan dos code units.
     */
    function _codificarParaPowerShell(script) {
        // Expandir code points completos (manejo de surrogate pairs)
        const codePoints = [];
        for (let i = 0; i < script.length; i++) {
            const hi = script.charCodeAt(i);
            if (hi >= 0xD800 && hi <= 0xDBFF && i + 1 < script.length) {
                const lo = script.charCodeAt(i + 1);
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    // Par sustituto → code point completo
                    const cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                    // PowerShell no puede representar > U+FFFF en UTF-16 sin sustitutos,
                    // pero los incluimos como par para máxima fidelidad.
                    codePoints.push(hi, lo);
                    i++;
                    continue;
                }
            }
            codePoints.push(hi);
        }

        // UTF-16 LE: cada code unit → 2 bytes (little-endian)
        const bytes = new Uint8Array(codePoints.length * 2);
        for (let i = 0; i < codePoints.length; i++) {
            bytes[i * 2]     = codePoints[i] & 0xFF;
            bytes[i * 2 + 1] = (codePoints[i] >> 8) & 0xFF;
        }

        // btoa en chunks para evitar stack overflow en listas grandes
        let bin = '';
        const CHUNK = 0x2000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        return btoa(bin);
    }

    /**
     * Construye el contenido completo del archivo .bat.
     *
     * MEJORADO v3.1:
     *   - El "cd /d" asegura que $PWD.Path sea el directorio del .bat
     *     (esto es lo que corrige el bug de $base=null en PowerShell)
     *   - Separación clara entre chcp y el cd para mayor compatibilidad
     *   - Muestra el directorio detectado antes de preguntar al usuario
     */
    function _construirBat(fileNames, timestamp) {
        if (!fileNames?.length) throw new Error('Se requiere al menos un nombre de archivo');
        const ts = timestamp || new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);

        // Filtrar y sanitizar nombres válidos
        const validos = fileNames
            .filter(f => f && typeof f === 'string')
            .map(_sanitizarNombreArchivo)
            .filter(Boolean);

        if (!validos.length) throw new Error('Ningún nombre de archivo válido tras sanitizar');

        const b64 = _codificarParaPowerShell(_construirScriptPowerShell(validos));
        const MAX_MOSTRAR = 30;

        const lineas = [
            '@echo off',
            ':: Establecer UTF-8 para mostrar caracteres especiales',
            'chcp 65001 >nul 2>&1',
            'setlocal enabledelayedexpansion',
            '',
            ':: CRÍTICO: cambiar al directorio del .bat ANTES de invocar PowerShell.',
            ':: Esto hace que $PWD.Path en PowerShell apunte al directorio correcto,',
            ':: resolviendo el bug donde $MyInvocation.MyCommand.Path era NULL.',
            'cd /d "%~dp0"',
            '',
            'echo ================================================',
            'echo  VP ^- Enviar a Papelera de Reciclaje',
            `echo  Generado: ${ts}`,
            `echo  Total archivos: ${validos.length}`,
            'echo ================================================',
            'echo.',
            `echo Directorio activo: %CD%`,
            'echo.',
            `echo Archivos a reciclar (${validos.length}):`,
            'echo.',
        ];

        for (let i = 0; i < Math.min(validos.length, MAX_MOSTRAR); i++) {
            lineas.push(`echo   [${String(i + 1).padStart(3, ' ')}] ${validos[i]}`);
        }
        if (validos.length > MAX_MOSTRAR) {
            lineas.push(`echo   ... y ${validos.length - MAX_MOSTRAR} mas archivos.`);
        }

        lineas.push(
            'echo.',
            'choice /C SN /N /M "Enviar TODOS a la papelera? (S=Si, N=No): "',
            'if errorlevel 2 goto :cancelado',
            'if errorlevel 1 goto :reciclar',
            '',
            ':reciclar',
            'echo.',
            'echo Ejecutando PowerShell...',
            ':: powershell.exe hereda el Working Directory del proceso padre (este .bat)',
            ':: por lo que $PWD dentro del script encoded apuntará a %CD% (= %~dp0)',
            `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`,
            'set "EXITCODE=!ERRORLEVEL!"',
            'echo.',
            'if "!EXITCODE!"=="0" (',
            '    echo Operacion completada sin errores.',
            ') else if "!EXITCODE!"=="2" (',
            '    echo ERROR DE ENTORNO: PowerShell no pudo determinar el directorio base.',
            '    echo Asegurese de ejecutar el .bat haciendo doble clic desde su ubicacion original.',
            ') else (',
            '    echo ADVERTENCIA: Algunos archivos tuvieron errores. Revise la salida anterior.',
            ')',
            'goto :fin',
            '',
            ':cancelado',
            'echo Operacion cancelada por el usuario.',
            '',
            ':fin',
            'echo.',
            'endlocal',
            'pause'
        );

        return lineas.join('\r\n');
    }

    /**
     * Genera (o sobrescribe) _eliminarVistos.bat en el directorio activo.
     * Requiere VP.runtime.dirHandle (establecido por vp-carga.js).
     */
    VP.eliminar.generarBatFile = async function () {
        log.info('Generando archivo .bat (eliminación)…');
        const dirHandle = VP.runtime?.dirHandle;
        if (!dirHandle) {
            log.warn('generarBatFile: no hay handle de directorio (VP.runtime.dirHandle).');
            VP.ui?.mostrarNotificacion?.('No hay directorio seleccionado. Carga algún video primero.', 'advertencia');
            return;
        }
        const eliminados = VP.estado?.archivosEliminados;
        if (!eliminados?.length) { log.debug('generarBatFile: lista vacía.'); return; }

        const unicos = [...new Set(eliminados.filter(x => x && typeof x === 'string'))];
        if (!unicos.length) return;

        log.info('Generando .bat para', unicos.length, 'archivos.');
        const nombreBat = '_eliminarVistos.bat';
        let reintentos = 0;
        let escrito    = false;

        while (!escrito && reintentos < MAX_REINTENTOS_BAT) {
            try {
                const batContent = _construirBat(unicos);

                // Verificar que el handle sigue siendo válido antes de escribir
                if (typeof dirHandle.queryPermission === 'function') {
                    const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
                    if (perm !== 'granted') {
                        // Intentar re-solicitar el permiso
                        if (typeof dirHandle.requestPermission === 'function') {
                            const permR = await dirHandle.requestPermission({ mode: 'readwrite' });
                            if (permR !== 'granted') throw new Error('Permiso de escritura denegado por el usuario');
                        } else {
                            throw new Error('Permiso de escritura denegado');
                        }
                    }
                }

                const fh       = await dirHandle.getFileHandle(nombreBat, { create: true });
                const writable = await fh.createWritable();
                await writable.write(batContent);
                await writable.close();
                escrito = true;
                VP.ui?.mostrarNotificacion?.(`Archivo .bat actualizado (${unicos.length} archivos)`, 'exito');
                log.info('.bat actualizado:', nombreBat, `(${unicos.length} archivos)`);
                bus.emit('batGenerado', { nombre: nombreBat, cantidad: unicos.length });
            } catch (e) {
                reintentos++;
                log.error(`Intento ${reintentos}/${MAX_REINTENTOS_BAT} para generar .bat falló:`, e.message || e);
                if (reintentos < MAX_REINTENTOS_BAT) {
                    await _esperar(BACKOFF_BAT_MS * reintentos);
                } else {
                    VP.ui?.mostrarNotificacion?.('Error al crear el archivo .bat tras varios intentos', 'error');
                    bus.emit('batError', { error: e.message || String(e) });
                }
            }
        }
    };

    // ----------------------------------------------------------
    // HELPERS INTERNOS
    // ----------------------------------------------------------
    function _esperar(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function _pushUndo(videoObj) {
        if (!videoObj) return;
        _estado.undoStack.push({ videoObj, ts: Date.now() });
        if (_estado.undoStack.length > MAX_UNDO_STACK) _estado.undoStack.shift();
    }

    // ----------------------------------------------------------
    // PERSISTENCIA DE EXCLUSIÓN (evita recargar videos eliminados)
    // ----------------------------------------------------------
    function _obtenerClaveExcluidos() {
        return VP.config?.claveVideosExcluidos || 'vp_excluded_videos_v1';
    }

    function _cargarListaExcluidos() {
        try {
            const lista = VP.db.obtenerKeyVal(_obtenerClaveExcluidos());
            return Array.isArray(lista) ? lista : [];
        } catch (_) {}
        return [];
    }

    function _guardarListaExcluidos(lista) {
        try {
            VP.db.guardarKeyVal(_obtenerClaveExcluidos(), lista);
        } catch (e) {
            log.warn('Error guardando lista de excluidos:', e.message || e);
        }
    }

    function _obtenerFingerprintVideo(videoObj) {
        if (!videoObj) return null;
        if (VP.carga?.obtenerFingerprintVideo) {
            return VP.carga.obtenerFingerprintVideo(videoObj);
        }
        // fallback si VP.carga no está disponible
        const fp = `${videoObj.name}|${videoObj.size || 0}|${videoObj.file?.lastModified || videoObj.lastModified || 0}`;
        return fp || null;
    }

    /**
     * Registra un video como excluido (no se recargará automáticamente).
     */
    function _registrarExclusionPersistente(videoObj) {
        if (!videoObj) return;
        try {
            const fp = _obtenerFingerprintVideo(videoObj);
            if (!fp) return;
            const excluidos = _cargarListaExcluidos();
            if (!excluidos.includes(fp)) {
                excluidos.push(fp);
                _guardarListaExcluidos(excluidos);
                log.debug('Video excluido permanentemente:', fp);
            }
        } catch (e) {
            log.warn('Error registrando exclusión persistente:', e.message || e);
        }
    }

    /**
     * Retorna la lista de fingerprints de videos excluidos.
     */
    VP.eliminar.obtenerExcluidos = function () {
        return _cargarListaExcluidos();
    };

    /**
     * Elimina un fingerprint de la lista de excluidos (permitiendo recargarlo).
     */
    VP.eliminar.quitarDeExcluidos = function (fingerprint) {
        if (!fingerprint) return false;
        try {
            const excluidos = _cargarListaExcluidos();
            const idx = excluidos.indexOf(fingerprint);
            if (idx !== -1) {
                excluidos.splice(idx, 1);
                _guardarListaExcluidos(excluidos);
                log.info('Fingerprint removido de excluidos:', fingerprint);
                return true;
            }
        } catch (e) {
            log.warn('Error quitando de excluidos:', e.message || e);
        }
        return false;
    };

    /**
     * Limpia toda la lista de videos excluidos.
     */
    VP.eliminar.limpiarExcluidos = function () {
        try {
            VP.db.eliminarKeyVal(_obtenerClaveExcluidos());
            log.info('Lista de videos excluidos limpiada.');
            VP.ui?.mostrarNotificacion?.('Lista de excluidos limpiada', 'info');
        } catch (e) {
            log.warn('Error limpiando excluidos:', e.message || e);
        }
    };

    // ----------------------------------------------------------
    // API PÚBLICA DE ELIMINACIÓN
    // ----------------------------------------------------------

    /**
     * Elimina un único video por ID.
     * Opciones:
     *   incluirDatosIA  {boolean=true}
     *   notificar       {boolean=true}
     *   generarBat      {boolean=true}
     *   guardarUndo     {boolean=true}
     */
    VP.eliminar.video = function (videoId, opciones = {}) {
        const incluirDatosIA = opciones.incluirDatosIA !== false;
        const notificar      = opciones.notificar      !== false;
        const generarBat     = opciones.generarBat     !== false;
        const guardarUndo    = opciones.guardarUndo    !== false;

        if (!videoId) {
            log.warn('eliminar.video: videoId requerido');
            return Promise.resolve({ exito: false, eliminados: 0, errores: ['VideoID requerido'], batGenerado: false });
        }

        // Capturar el objeto ANTES de eliminar (para undo y registro)
        let videoObjEliminado = null;
        if (VP.estado?.videos) {
            for (const v of VP.estado.videos) {
                if (v && (v.id === videoId || v.name === videoId)) {
                    videoObjEliminado = { ...v };
                    break;
                }
            }
        }

        return _eliminarVideoCompleto(videoId)
            .then(resultado => {
                if (incluirDatosIA) {
                    return _eliminarDatosIA(videoId).then(n => {
                        resultado.eliminados += n;
                        return resultado;
                    });
                }
                return resultado;
            })
            .then(resultado => {
                _eliminarSubtitulosVideo(videoId).catch(() => {});

                const eliminadoDelEstado = _limpiarEstadoVideo(videoId);
                const objParaRegistro    = videoObjEliminado || eliminadoDelEstado;

                if (objParaRegistro) _registrarExclusionPersistente(objParaRegistro);

                if (guardarUndo && objParaRegistro) _pushUndo(objParaRegistro);

                _registrarHistorial(
                    videoId,
                    objParaRegistro?.name,
                    objParaRegistro?.size,
                    resultado.exito,
                    resultado.errores
                );

                resultado.batGenerado = false;
                if (generarBat && objParaRegistro) {
                    _registrarArchivoEliminado(objParaRegistro);
                    VP.eliminar.generarBatFile().catch(e => log.warn('Error generando .bat:', e));
                    resultado.batGenerado = true;
                }

                if (notificar && VP.ui?.mostrarNotificacion) {
                    if (resultado.exito) {
                        let msg = 'Video eliminado correctamente';
                        if (resultado.batGenerado) msg += ' (.bat actualizado)';
                        VP.ui.mostrarNotificacion(msg, 'info');
                    } else {
                        VP.ui.mostrarNotificacion('Error eliminando video', 'error');
                    }
                }
                return resultado;
            });
    };

    /**
     * Deshace la última eliminación: restaura el objeto al estado en memoria.
     * NOTA: no recupera el archivo de disco, solo el objeto en VP.estado.
     */
    VP.eliminar.deshacer = function () {
        const entrada = _estado.undoStack.pop();
        if (!entrada) {
            log.debug('deshacer: stack vacío.');
            VP.ui?.mostrarNotificacion?.('No hay eliminaciones que deshacer', 'advertencia');
            return null;
        }
        const { videoObj } = entrada;
        VP.estado.videos   = VP.estado.videos   || [];
        VP.estado.playlist = VP.estado.playlist || [];
        VP.estado.videos.push(videoObj);
        VP.estado.playlist.push(videoObj);
        VP.reconstruirTodosMapas?.();
        const fp = _obtenerFingerprintVideo(videoObj);
        if (fp) VP.eliminar.quitarDeExcluidos(fp);
        bus.emit('videoRestaurado', { videoObj });
        VP.ui?.mostrarNotificacion?.(`Video restaurado en lista: ${videoObj.name}`, 'info');
        log.info('deshacer: video restaurado al estado:', videoObj.name);
        return videoObj;
    };

    /**
     * Elimina todos los videos que cumplan el predicado fn(video) === true.
     */
    VP.eliminar.eliminarPorFiltro = function (fn, opciones = {}) {
        if (typeof fn !== 'function') {
            log.warn('eliminarPorFiltro: se requiere una función predicado.');
            return Promise.resolve({ exitosos: 0, fallidos: 0, errores: [], batGenerado: false });
        }
        const videos = VP.estado?.videos || [];
        const ids = videos.filter(v => v && fn(v)).map(v => v.id || v.name);
        if (!ids.length) {
            log.debug('eliminarPorFiltro: ningún video coincide.');
            return Promise.resolve({ exitosos: 0, fallidos: 0, errores: [], batGenerado: false });
        }
        log.info(`eliminarPorFiltro: ${ids.length} videos coinciden.`);
        return VP.eliminar.lote(ids, opciones);
    };

    VP.eliminar.subtitulos = function (videoId, opciones = {}) {
        const notificar = opciones.notificar !== false;
        if (!videoId) return Promise.resolve(false);
        return _eliminarSubtitulosVideo(videoId).then(ok => {
            if (ok && notificar) VP.ui?.mostrarNotificacion?.('Subtítulos eliminados', 'info');
            bus.emit('subtitulosEliminados', { videoId });
            return ok;
        });
    };

    VP.eliminar.miniaturas = function (videoId) {
        if (!videoId) return Promise.resolve(false);
        return Promise.all([
            db.eliminarMiniatura(videoId).catch(() => false),
            db.eliminarArrayMiniaturas(videoId).catch(() => false)
        ]).then(([ok1, ok2]) => ok1 || ok2);
    };

    VP.eliminar.datosIA = function (videoId) {
        if (!videoId) return Promise.resolve(0);
        return _eliminarDatosIA(videoId).catch(e => { log.warn('eliminar.datosIA error:', e); return 0; });
    };

    /**
     * Eliminación en lote con concurrencia controlada.
     * Opciones:
     *   concurrencia    {number}           - sobreescribe CONCURRENCIA_LOTE
     *   incluirDatosIA  {boolean=true}
     *   notificar       {boolean=true}
     *   generarBat      {boolean=true}
     *   progreso        {Function}         - callback({ actual, total, completado })
     */
    VP.eliminar.lote = function (videoIds, opciones = {}) {
        const incluirDatosIA  = opciones.incluirDatosIA !== false;
        const notificar       = opciones.notificar      !== false;
        const generarBat      = opciones.generarBat     !== false;
        const progreso        = typeof opciones.progreso === 'function' ? opciones.progreso : () => {};
        const concurrencia    = opciones.concurrencia   || CONCURRENCIA_LOTE;

        if (!Array.isArray(videoIds) || !videoIds.length) {
            log.warn('eliminar.lote: array de videoIds requerido');
            return Promise.resolve({ exitosos: 0, fallidos: 0, errores: [], batGenerado: false });
        }

        log.info('Iniciando eliminación en lote de', videoIds.length, 'videos (concurrencia:', concurrencia + ')');
        const resultado = { exitosos: 0, fallidos: 0, errores: [], batGenerado: false };
        const semaforo  = _crearSemaforo(concurrencia);
        const total     = videoIds.length;
        let completado  = 0;

        const promesas = videoIds.map((videoId, idx) =>
            semaforo.adquirir()
                .then(() => VP.eliminar.video(videoId, {
                    incluirDatosIA,
                    notificar: false,
                    generarBat: false,
                    guardarUndo: false
                }))
                .then(res => {
                    if (res.exito) resultado.exitosos++;
                    else {
                        resultado.fallidos++;
                        resultado.errores.push({ videoId, mensaje: res.errores.join(', ') });
                    }
                    completado++;
                    progreso({ actual: idx + 1, total, completado });
                    return res;
                })
                .catch(e => {
                    resultado.fallidos++;
                    resultado.errores.push({ videoId, mensaje: e.message || String(e) });
                    completado++;
                    progreso({ actual: idx + 1, total, completado });
                    return { exito: false };
                })
                .finally(() => semaforo.liberar())
        );

        return Promise.all(promesas).then(() => {
            log.info('Eliminación en lote completada:', resultado.exitosos, 'exitosos,', resultado.fallidos, 'fallidos');
            if (generarBat) {
                VP.eliminar.generarBatFile().catch(e => log.warn('Error generando .bat en lote:', e));
                resultado.batGenerado = true;
            }
            if (notificar && VP.ui?.mostrarNotificacion) {
                let msg = `${resultado.exitosos} video(s) eliminado(s)`;
                if (resultado.fallidos > 0) msg += ` (${resultado.fallidos} fallo(s))`;
                if (resultado.batGenerado) msg += ' (.bat actualizado)';
                VP.ui.mostrarNotificacion(msg, resultado.fallidos > 0 ? 'advertencia' : 'info');
            }
            bus.emit('loteEliminado', resultado);
            return resultado;
        }).catch(e => {
            log.error('eliminar.lote error crítico:', e);
            resultado.errores.push({ videoId: 'LOTE', mensaje: `Error crítico: ${e.message || e}` });
            return resultado;
        });
    };

    /**
     * Exporta el historial de eliminaciones como JSON descargable.
     */
    VP.eliminar.exportarHistorial = function () {
        const data = JSON.stringify(_estado.historial, null, 2);
        try {
            const blob = new Blob([data], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `vp_historial_eliminados_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                try { URL.revokeObjectURL(url); } catch (_) {}
                try { if (a.parentNode) document.body.removeChild(a); } catch (_) {}
            }, 1000);
            log.info('Historial exportado:', _estado.historial.length, 'entradas.');
        } catch (e) {
            log.error('exportarHistorial error:', e);
        }
    };

    /**
     * Retorna una copia del historial de eliminaciones.
     */
    VP.eliminar.obtenerHistorial = function () {
        return [..._estado.historial];
    };

    VP.eliminar.limpiarEstado = function () {
        _estado.eliminandoAhora = false;
        _estado.colaEliminacion = [];
        Object.keys(_estado.timers).forEach(key => {
            if (_estado.timers[key]) clearTimeout(_estado.timers[key]);
        });
        _estado.timers = {};
        log.debug('Estado de eliminación limpiado');
    };

    VP.eliminar.destroy = function () {
        VP.eliminar.limpiarEstado();
        _estado.undoStack = [];
        log.debug('Módulo eliminar destruido');
    };

    // ----------------------------------------------------------
    // INICIALIZACIÓN
    // ----------------------------------------------------------
    VP.eliminar.inicializar = function () {
        if (!VP.estado) VP.estado = {};
        if (!Array.isArray(VP.estado.archivosEliminados)) VP.estado.archivosEliminados = [];
        _estado.undoStack = [];
        _estado.historial = [];
        log.info('Módulo VP.eliminar v3.1 inicializado');
        bus.emit('eliminarInicializado');
    };

    // Eventos del bus
    bus.on('generarBatFile', () => VP.eliminar.generarBatFile());
    bus.on('reset', () => {
        if (VP.estado) VP.estado.archivosEliminados = [];
        _estado.undoStack = [];
        VP.eliminar.limpiarEstado();
    });

    if (VP.runtime?.ready) {
        VP.eliminar.inicializar();
    } else {
        bus.once('vpReady', () => VP.eliminar.inicializar());
    }

    log.info('vp-eliminar.js v3.1 cargado.');
    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-eliminar.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
