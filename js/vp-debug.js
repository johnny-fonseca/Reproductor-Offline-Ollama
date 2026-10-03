var VP_DEBUG_SCRIPT_URL = typeof document !== 'undefined' && document.currentScript
    ? document.currentScript.src : document.baseURI;

// Depuración del reproductor: activa una bandera individual en VP o Mochi, o usa
// VP_DEBUG.activarGrupo('reproduccion' | 'ia' | 'datos') desde la consola.
// VP_DEBUG.estadoProyecto() imprime una instantánea segura de salud del reproductor.
// En Mochi, solicitudesOllama muestra tamaños/opciones, metricasOllama tokens/tiempos
// y diagnosticoOllama reintentos/límites/respuestas inválidas, sin volcar prompts.
// silenciarConsola oculta solo mensajes debug/info mientras las banderas estén apagadas;
// todas las advertencias y errores siguen visibles. Al poner una bandera de módulo en true
// reaparecen sus registros. VP.general activa todo VP.
var VP_DEBUG = {
    general: true,
    silenciarConsola: false,
    rendimiento: {
        activar: false,
        ok: true,
        largeLibrary: true,
        playerBusy: true,
        embedRunning: false,
        bgQueueSize: 0
    },
    VP: {
        general: true,
        Ajustes: false, Busqueda: false, Carga: false, CapitulosIA: false,
        ChatIA: false, ComentariosIA: false, DB: false, DOM: false,
        Eliminar: false, EtiquetasIA: false, Eventos: false, Init: false, Media: false,
        Listas: false, Miniaturas: false, Ollama: false, Player: false,
        RAGCore: false, RecomendacionesIA: false, SummaryIA: false,
        Subtitulos: true, TraduccionIA: false, Util: false, VisionIA: false,
        Floating: false
    },
    Mochi: {
        general: true,
        eventos: false,
        animacion: false,
        estilos: false,
        solicitudesOllama: false,
        metricasOllama: false,
        diagnosticoOllama: false,
        mochiQA: true,
        pruebaEstadosMacho: false,
        pruebaEstadosHembra: false
    }
};

// Consola de QA: no se publica si la bandera no estaba activa al cargar el archivo.
window.VP_DEBUG = VP_DEBUG;

if (VP_DEBUG.Mochi.mochiQA === true) {
    window.mochiDebug = {
        forzarHumor: function (humor, segundos) {
            var perfil = window.VP && typeof VP.mochiPerfilActual === 'function' ? VP.mochiPerfilActual() : null;
            var contrato = perfil && perfil.humor;
            if (!contrato || typeof contrato.normalizar !== 'function') {
                console.warn('[mochiQA] El contrato de humor aún no está disponible.');
                return false;
            }
            var mochi = window.VP && VP.mochiMascota;
            if (!mochi || typeof mochi.setMood !== 'function' || typeof mochi.mostrarAviso !== 'function') {
                console.warn('[mochiQA] Mochi aún no está disponible.');
                return false;
            }
            var duracion = segundos === undefined ? 8 : Number(segundos);
            if (!Number.isFinite(duracion) || duracion <= 0) duracion = 8;
            duracion = Math.min(duracion, 2147483);
            var humorNormalizado = contrato.normalizar(humor);
            mochi.setMood(humorNormalizado);
            mochi.mostrarAviso('', duracion * 1000);
            return humorNormalizado;
        }
    };
}

VP_DEBUG.grupos = {
    reproduccion: ['Player', 'Media', 'Eventos', 'Subtitulos', 'Carga', 'Listas', 'DOM'],
    ia: ['Ollama', 'ComentariosIA', 'ChatIA', 'CapitulosIA', 'SummaryIA', 'VisionIA', 'EtiquetasIA', 'TraduccionIA', 'RecomendacionesIA', 'RAGCore'],
    datos: ['DB', 'Ajustes', 'Eliminar']
};

VP_DEBUG.actualizarEstadoRendimiento = function () {
    var estado = {
        ok: true,
        largeLibrary: true,
        playerBusy: true,
        embedRunning: false,
        bgQueueSize: 0
    };

    var vp = window.VP;
    var player = vp && vp.refs && vp.refs.videoPlayer ? vp.refs.videoPlayer : null;
    var totalVideos = vp && Array.isArray(vp.estado && vp.estado.videos) ? vp.estado.videos.length : 0;

    if (player) {
        estado.playerBusy = !!(!player.paused && !player.ended && player.readyState >= 2);
    }
    if (totalVideos > 200) {
        estado.largeLibrary = true;
    }
    if (vp && vp.recomendacionesIA && typeof vp.recomendacionesIA.getStats === 'function') {
        try {
            var stats = vp.recomendacionesIA.getStats();
            if (stats) {
                estado.embedRunning = !!stats.embedRunning;
                estado.bgQueueSize = Number(stats.bgQueueSize || 0);
            }
        } catch (_) {}
    }

    Object.assign(VP_DEBUG.rendimiento, estado);
    return estado;
};

VP_DEBUG.logRendimiento = function (forzar) {
    if (!VP_DEBUG.rendimiento || (VP_DEBUG.rendimiento.activar !== true && !forzar)) return VP_DEBUG.rendimiento;
    var estado = VP_DEBUG.actualizarEstadoRendimiento();
    console.info('[VP_DEBUG] Rendimiento:', estado);
    return estado;
};

if (typeof window !== 'undefined' && !window.__VP_DEBUG_RND_INTERVAL__) {
    window.__VP_DEBUG_RND_INTERVAL__ = setInterval(function () {
        if (VP_DEBUG.rendimiento && VP_DEBUG.rendimiento.activar === true) {
            VP_DEBUG.logRendimiento();
        }
    }, 4000);
}

VP_DEBUG.activarGrupo = function (nombre) {
    var grupo = VP_DEBUG.grupos[String(nombre || '').trim().toLowerCase()];
    if (!grupo) {
        console.warn('[VP_DEBUG] Grupo desconocido. Opciones:', Object.keys(VP_DEBUG.grupos).join(', '));
        return false;
    }
    grupo.forEach(function (modulo) { VP_DEBUG.VP[modulo] = true; });
    console.info('[VP_DEBUG] Registros activados para:', nombre, grupo);
    return true;
};

VP_DEBUG.desactivarGrupo = function (nombre) {
    var grupo = VP_DEBUG.grupos[String(nombre || '').trim().toLowerCase()];
    if (!grupo) {
        console.warn('[VP_DEBUG] Grupo desconocido. Opciones:', Object.keys(VP_DEBUG.grupos).join(', '));
        return false;
    }
    grupo.forEach(function (modulo) { VP_DEBUG.VP[modulo] = false; });
    console.info('[VP_DEBUG] Registros desactivados para:', nombre, grupo);
    return true;
};

VP_DEBUG.estadoProyecto = function () {
    var video = window.VP && VP.refs && VP.refs.videoPlayer;
    var raizMochi = document.querySelector('.vp-mochi');
    var carga = null;
    var ollama = null;
    var rendimiento = VP_DEBUG.estadoRendimiento();
    try { if (VP.carga && typeof VP.carga.estadisticas === 'function') carga = VP.carga.estadisticas(); } catch (_) {}
    try { if (VP.mochiOllama && typeof VP.mochiOllama.configuracion === 'function') ollama = VP.mochiOllama.configuracion(); } catch (_) {}

    var modulos = Object.keys((VP && VP.modulos) || {}).map(function (nombre) {
        var modulo = VP.modulos[nombre] || {};
        return { nombre: nombre, cargado: modulo.cargado !== false, version: modulo.version || '' };
    });
    var videoError = video && video.error ? {
        code: video.error.code || 0,
        message: video.error.message || ''
    } : null;
    var memoria = performance && performance.memory ? {
        heapUsadoMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
        heapLimiteMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576)
    } : null;

    var informe = {
        aplicacion: {
            version: VP && VP.version || null,
            inicializado: !!(VP && VP.runtime && VP.runtime.inicializado),
            online: navigator.onLine,
            protocolo: location.protocol
        },
        video: video ? {
            pausado: video.paused,
            tiempo: Math.round(video.currentTime * 10) / 10,
            duracion: isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
            readyState: video.readyState,
            networkState: video.networkState,
            tamano: video.videoWidth && video.videoHeight ? video.videoWidth + 'x' + video.videoHeight : null,
            error: videoError
        } : null,
        carga: carga,
        mochi: raizMochi ? {
            perfil: raizMochi.dataset.profile || null,
            humor: raizMochi.dataset.mood || null,
            estado: raizMochi.dataset.state || null,
            ollamaEstado: raizMochi.dataset.ollamaStatus || null
        } : null,
        modeloMochi: ollama && ollama.modelo || null,
        rendimiento: rendimiento,
        metricas: VP && VP.metricas ? Object.assign({}, VP.metricas) : null,
        memoria: memoria,
        modulos: modulos
    };

    if (console.groupCollapsed) console.groupCollapsed('[VP_DEBUG] Estado del proyecto');
    console.log('Aplicación:', informe.aplicacion);
    console.log('Video:', informe.video);
    console.log('Carga:', informe.carga);
    console.log('Rendimiento:', informe.rendimiento);
    console.log('Mochi:', informe.mochi, '| Modelo:', informe.modeloMochi);
    console.log('Métricas:', informe.metricas, '| Memoria:', informe.memoria);
    if (console.table) console.table(informe.modulos);
    else console.log('Módulos:', informe.modulos);
    if (console.groupEnd) console.groupEnd();
    return informe;
};

if (VP_DEBUG.Mochi.pruebaEstadosMacho === true && typeof document !== 'undefined') {
    console.info('[mochiQA] Bandera activa; cargando el monitor de Mochi macho…');
    var scriptQAEstadosMacho = document.createElement('script');
    scriptQAEstadosMacho.src = new URL('mascota/prueba/QA_macho_maquina_estados.js', document.currentScript.src).href;
    scriptQAEstadosMacho.async = true;
    scriptQAEstadosMacho.onload = function () {
        console.info('[mochiQA] Archivo del monitor cargado.');
    };
    scriptQAEstadosMacho.onerror = function () {
        console.error('[mochiQA] No se pudo cargar el monitor:', scriptQAEstadosMacho.src);
    };
    (document.head || document.documentElement).appendChild(scriptQAEstadosMacho);
}
VP_DEBUG.Mochi.activarPruebaEstadosHembra = function () {
    if (typeof document === 'undefined') return false;
    VP_DEBUG.Mochi.pruebaEstadosHembra = true;

    if (window.mochiQAhembra && typeof window.mochiQAhembra.resumen === 'function') {
        console.info('[mochiQA hembra] El monitor ya está cargado.');
        return true;
    }
    if (document.querySelector('script[data-mochi-qa="hembra"]')) {
        console.info('[mochiQA hembra] El monitor se está cargando; espera un momento.');
        return true;
    }

    console.info('[mochiQA hembra] Cargando el monitor…');
    var scriptQAEstadosHembra = document.createElement('script');
    scriptQAEstadosHembra.dataset.mochiQa = 'hembra';
    scriptQAEstadosHembra.src = new URL('mascota/prueba/QA_hembra_maquina_estados.js', VP_DEBUG_SCRIPT_URL).href;
    scriptQAEstadosHembra.async = true;
    scriptQAEstadosHembra.onload = function () {
        console.info('[mochiQA hembra] Archivo del monitor cargado.');
    };
    scriptQAEstadosHembra.onerror = function () {
        console.error('[mochiQA hembra] No se pudo cargar el monitor:', scriptQAEstadosHembra.src);
    };
    (document.head || document.documentElement).appendChild(scriptQAEstadosHembra);
    return true;
};

if (VP_DEBUG.Mochi.pruebaEstadosHembra === true && typeof document !== 'undefined') {
    VP_DEBUG.Mochi.activarPruebaEstadosHembra();
}
