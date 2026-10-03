/* =====================================================================
 * QA pasivo de la máquina de estados de Mochi macho.
 * Activación automática mediante VP_DEBUG.Mochi.pruebaEstadosMacho = true.
 * También se puede cargar manualmente, con esa bandera activada.
 * No modifica el reproductor: observa .vp-mochi[data-profile="macho"].
 *
 * Uso:
 *   1. Pegar este archivo en la consola.
 *   2. Ejecutar manualmente los escenarios que se quieran comprobar.
 *   3. Ver el resultado con mochiQA.resumen().
 *   4. Detener el monitor con mochiQA.parar().
 *
 * Detecta:
 *   [BUG-PEGADO]   estados transitorios que exceden su límite de seguridad.
 *   [BUG-BUCLE]    Mochi permanece visible en idle sin un gesto por 25 s,
 *                  siempre que idleGestures esté activo y no haya reduced motion.
 *   [BUG-UNDEFINED] el atributo data-state falta, está vacío o es inválido.
 *
 * Límites: es un monitor, no genera acciones de prueba. Los cambios de estado
 * repetidos se detectan si el navegador entrega la mutación del atributo.
 * ===================================================================== */
(function (window, document) {
    'use strict';

    if (window.mochiQA && typeof window.mochiQA.parar === 'function') {
        window.mochiQA.parar();
    }

    if (!window.VP_DEBUG || !window.VP_DEBUG.Mochi || window.VP_DEBUG.Mochi.pruebaEstadosMacho !== true) {
        console.info('[mochiQA] Desactivada. Cambia VP_DEBUG.Mochi.pruebaEstadosMacho a true y recarga el reproductor para activarla.');
        return;
    }

    function iniciar(root) {
    var LIMITE_PEGADO_MS = 65000;
    var LIMITE_IDLE_MS = 25000;
    var LIMITE_PENSANDO_MS = 120000;
    var LIMITE_HABLANDO_MS = 25000;
    var LIMITE_SUEÑO_MS = 12000;
    var LIMITE_DESPEDIDA_MS = 10000;
    var PERSISTENTES = ['idle', 'leyendo', 'pensando'];
    var ahora = Date.now;

    var qa = {
        transiciones: [],
        cambiosHumor: [],
        avisos: [],
        inicioEstado: ahora(),
        inicioIdleVigilado: ahora(),
        estadoActual: root.getAttribute('data-state'),
        humorActual: root.getAttribute('data-mood') || 'sin definir',
        ultimaAlertaPegado: 0,
        observador: null,
        timer: null,
        activo: true,
        estadoInvalidoReportado: false,
        esperandoReemplazo: false
    };

    function hora() { return new Date().toLocaleTimeString(); }

    function avisar(tipo, mensaje) {
        var linea = '[' + tipo + '] ' + hora() + ' — ' + mensaje;
        qa.avisos.push(linea);
        console.error('%c' + linea, 'color:#f33;font-weight:bold');
    }

    function estadoValido(estado) {
        return typeof estado === 'string' && estado.length > 0 &&
            estado !== 'undefined' && estado !== 'null';
    }

    function gestosIdleVigilables() {
        if (!root.isConnected || !root.classList.contains('is-visible') || document.hidden) return false;

        var vp = window.VP;
        if (vp && typeof vp.mochiParametro === 'function') {
            try {
                if (vp.mochiParametro('idleGestures') === false) return false;
            } catch (_) {}
        }

        var respetaReducido = !!(vp && vp.mochiConfig && vp.mochiConfig.respectReducedMotion);
        if (respetaReducido && window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        return true;
    }

    function limitePara(estado) {
        if (estado === 'hablando') {
            var bubbleMs = 8000;
            if (window.VP && typeof window.VP.mochiParametro === 'function') {
                try { bubbleMs = Number(window.VP.mochiParametro('bubbleDurationMs')) || bubbleMs; } catch (_) {}
            }
            return Math.max(LIMITE_HABLANDO_MS, bubbleMs + 10000);
        }
        if (estado === 'durmiendo' || estado === 'somnoliento') return LIMITE_SUEÑO_MS;
        if (estado === 'despidiendo') return LIMITE_DESPEDIDA_MS;
        if (estado === 'pensando') return LIMITE_PENSANDO_MS;
        if (PERSISTENTES.indexOf(estado) !== -1) return Infinity;
        return LIMITE_PEGADO_MS;
    }

    function sincronizarEstado(registros) {
        if (!qa.activo || !root.isConnected) return;
        var humorNuevo = root.getAttribute('data-mood') || 'sin definir';
        if (humorNuevo !== qa.humorActual) {
            var cambioHumor = {
                de: qa.humorActual,
                a: humorNuevo,
                estado: root.getAttribute('data-state'),
                hora: hora()
            };
            qa.cambiosHumor.push(cambioHumor);
            console.log('%c[mochiQA] ' + cambioHumor.hora + '  humor: ' +
                cambioHumor.de + ' → ' + cambioHumor.a + ' (estado: ' +
                cambioHumor.estado + ')', 'color:#a50');
            qa.humorActual = humorNuevo;
        }
        var nuevo = root.getAttribute('data-state');
        if (!estadoValido(nuevo)) {
            if (!qa.estadoInvalidoReportado) {
                avisar('BUG-UNDEFINED', 'data-state falta o contiene "' + nuevo + '".');
                qa.estadoInvalidoReportado = true;
            }
            qa.estadoActual = nuevo;
            qa.inicioEstado = ahora();
            qa.inicioIdleVigilado = ahora();
            return;
        }
        qa.estadoInvalidoReportado = false;

        var momento = ahora();
        if (nuevo !== qa.estadoActual) {
            var duracion = momento - qa.inicioEstado;
            qa.transiciones.push({
                de: qa.estadoActual,
                a: nuevo,
                humor: humorNuevo,
                duracionMs: duracion,
                hora: hora()
            });
            console.log('%c[mochiQA] ' + hora() + '  ' + qa.estadoActual + ' (' +
                (duracion / 1000).toFixed(1) + ' s) → ' + nuevo +
                '  [humor: ' + humorNuevo + ']', 'color:#08c');
            qa.estadoActual = nuevo;
            qa.inicioEstado = momento;
            qa.inicioIdleVigilado = momento;
        } else if (registros && registros.some(function (registro) {
            return registro.attributeName === 'data-state';
        })) {
            // También reinicia la medición cuando se vuelve a asignar el mismo
            // nombre de estado y el navegador notifica esa mutación.
            qa.inicioEstado = momento;
            qa.inicioIdleVigilado = momento;
        }
    }

    qa.estadoActual = root.getAttribute('data-state');
    if (!estadoValido(qa.estadoActual)) {
        avisar('BUG-UNDEFINED', 'Mochi empezó sin un data-state válido: "' + qa.estadoActual + '".');
        qa.estadoInvalidoReportado = true;
    }
    console.log('%c[mochiQA] Vigilando:', 'color:#0a0', root, '| estado inicial:', qa.estadoActual,
        '| humor inicial:', qa.humorActual);

    qa.observador = new MutationObserver(function (registros) {
        sincronizarEstado(registros);
    });
    qa.observador.observe(root, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['data-state', 'data-mood']
    });

    qa.timer = setInterval(function () {
        if (!qa.activo) return;
        if (!window.VP_DEBUG || !window.VP_DEBUG.Mochi || window.VP_DEBUG.Mochi.pruebaEstadosMacho !== true) {
            window.mochiQA.parar();
            console.info('[mochiQA] Desactivada desde VP_DEBUG.');
            return;
        }
        if (!root.isConnected) {
            // El reproductor recrea el nodo de Mochi al cambiar/iniciar un video.
            // Si el reemplazo ya está en el DOM, continúa vigilando la instancia nueva.
            var reemplazo = document.querySelector('.vp-mochi[data-profile="macho"]');
            if (reemplazo) {
                qa.observador.disconnect();
                root = reemplazo;
                qa.esperandoReemplazo = false;
                qa.estadoActual = root.getAttribute('data-state');
                qa.humorActual = root.getAttribute('data-mood') || 'sin definir';
                qa.estadoInvalidoReportado = !estadoValido(qa.estadoActual);
                qa.inicioEstado = ahora();
                qa.inicioIdleVigilado = ahora();
                qa.observador.observe(root, {
                    attributes: true,
                    attributeOldValue: true,
                    attributeFilter: ['data-state', 'data-mood']
                });
                console.info('[mochiQA] Mochi macho fue recreado; el monitor continúa con el nuevo elemento. Estado:', qa.estadoActual);
                console.info('[mochiQA] Humor actual:', qa.humorActual);
                return;
            }
            if (!qa.esperandoReemplazo) {
                qa.esperandoReemplazo = true;
                console.info('[mochiQA] Mochi fue retirado durante el cambio de video; esperando la nueva instancia.');
            }
            return;
        }
        sincronizarEstado();
        if (document.hidden || !root.classList.contains('is-visible')) {
            qa.inicioIdleVigilado = ahora();
            return;
        }

        var actual = root.getAttribute('data-state');
        if (!estadoValido(actual)) return;
        var duracion = ahora() - qa.inicioEstado;
        var limite = limitePara(actual);

        if (actual !== 'idle' && duracion > limite &&
                ahora() - qa.ultimaAlertaPegado > LIMITE_PEGADO_MS) {
            avisar('BUG-PEGADO', 'el estado "' + actual + '" lleva ' +
                Math.round(duracion / 1000) + ' s sin cambiar (límite: ' +
                Math.round(limite / 1000) + ' s).');
            qa.ultimaAlertaPegado = ahora();
        }

        if (actual === 'idle') {
            if (!gestosIdleVigilables()) {
                // No cuenta tiempo durante el cual los gestos están desactivados,
                // Mochi está oculto o el movimiento reducido los suprime.
                qa.inicioIdleVigilado = ahora();
                return;
            }
            var idleMs = ahora() - qa.inicioIdleVigilado;
            if (idleMs > LIMITE_IDLE_MS) {
                avisar('BUG-BUCLE', 'Mochi lleva ' + Math.round(idleMs / 1000) +
                    ' s visible en idle sin un gesto.');
                qa.inicioIdleVigilado = ahora();
            }
        }
    }, 1000);

    window.mochiQA = {
        resumen: function () {
            console.log('%c===== RESUMEN mochiQA =====', 'font-weight:bold');
            console.log('Transiciones registradas: ' + qa.transiciones.length);
            console.table(qa.transiciones);
            console.log('Cambios de humor registrados: ' + qa.cambiosHumor.length);
            console.table(qa.cambiosHumor);
            if (qa.avisos.length) {
                console.log('%cAVISOS (' + qa.avisos.length + '):', 'color:#f33;font-weight:bold');
                qa.avisos.forEach(function (aviso) { console.log('  ' + aviso); });
            } else {
                console.log('%cSin avisos durante el periodo observado.', 'color:#0a0;font-weight:bold');
            }
            return { transiciones: qa.transiciones, cambiosHumor: qa.cambiosHumor, avisos: qa.avisos };
        },
        parar: function () {
            if (!qa.activo) return;
            qa.activo = false;
            if (qa.observador) qa.observador.disconnect();
            if (qa.timer) clearInterval(qa.timer);
            console.log('[mochiQA] Detenido. Ejecuta mochiQA.resumen() para ver los datos.');
        }
    };

    console.log('%c[mochiQA] Activo. Ejecuta las interacciones y luego mochiQA.resumen().', 'color:#0a0');
    }

    var root = document.querySelector('.vp-mochi[data-profile="macho"]');
    if (root) {
        iniciar(root);
        return;
    }

    console.info('[mochiQA] Esperando a que Mochi macho aparezca en el reproductor…');
    var esperaActiva = true;
    var esperaObserver = new MutationObserver(function () {
        if (!esperaActiva) return;
        if (!window.VP_DEBUG || !window.VP_DEBUG.Mochi || window.VP_DEBUG.Mochi.pruebaEstadosMacho !== true) {
            window.mochiQA.parar();
            return;
        }
        var mascota = document.querySelector('.vp-mochi[data-profile="macho"]');
        if (!mascota) return;
        esperaActiva = false;
        esperaObserver.disconnect();
        clearTimeout(esperaTimer);
        iniciar(mascota);
    });
    var esperaTimer = setTimeout(function () {
        if (!esperaActiva) return;
        esperaActiva = false;
        esperaObserver.disconnect();
        console.warn('[mochiQA] Mochi macho no apareció en 2 minutos; monitor no iniciado.');
    }, 120000);
    esperaObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.mochiQA = {
        resumen: function () {
            console.info('[mochiQA] Aún no hay un Mochi macho para vigilar.');
            return { pendiente: esperaActiva, transiciones: [], avisos: [] };
        },
        parar: function () {
            if (!esperaActiva) return;
            esperaActiva = false;
            esperaObserver.disconnect();
            clearTimeout(esperaTimer);
            console.log('[mochiQA] Espera cancelada.');
        }
    };
})(window, document);
