    /* ==========================================================================
       9. ORQUESTADOR DEL REPRODUCTOR + API PÚBLICA
       ========================================================================== */
    (function (window, document) {
        'use strict';
        var VP = window.VP;
        if (!VP || window.__VP_MOCHI_CORE__) return;
        window.__VP_MOCHI_CORE__ = true;
        var CFG = VP.mochiConfig;
        var U = VP._mochiUtil || {};
        var errLog = U.error || function () {};
        var consoleEvent = U.consoleEvent || function () {};

        var video = null;
        var checkbox = null;
        var switchMochi = null;
        var destroyed = true;
        var observer = null;
        var pausadoPorPestanaOculta = false;
        var pausadoPorVideo = false;
        var pendingVideoTransition = null;
        var timerTransicionSueno = null;
        if (VP.mochiMascota) {
            VP.mochiMascota.cancelarTransicionSueno = function () {
                if (timerTransicionSueno) { clearTimeout(timerTransicionSueno); timerTransicionSueno = null; }
            };
        }
        var hasGreetedThisVideo = false;
        var MODE_KEY = 'vp_mochi_modo';
        var modoActual = null;

        function proteger(fn, nombre) {
            return function () {
                try { return fn.apply(this, arguments); }
                catch (e) { errLog('Error en ' + nombre + ':', e); }
            };
        }

        function localizarVideo() {
            var referenciado = VP.refs && VP.refs.videoPlayer;
            if (referenciado && document.documentElement.contains(referenciado)) return referenciado;
            return document.getElementById('videoPlayer') ||
                document.querySelector('video');
        }

        function escucharVideo(nodo) {
            if (!nodo) return;
            nodo.addEventListener('play', onPlaySeguro);
            nodo.addEventListener('pause', onPauseSeguro);
            nodo.addEventListener('ended', onEndedSeguro);
            nodo.addEventListener('loadstart', onLoadStartSeguro);
            nodo.addEventListener('timeupdate', onTimeUpdateSeguro);
            nodo.addEventListener('seeking', onSeekingSeguro);
            nodo.addEventListener('seeked', onSeekedSeguro);
        }

        function dejarDeEscucharVideo(nodo) {
            if (!nodo) return;
            nodo.removeEventListener('play', onPlaySeguro);
            nodo.removeEventListener('pause', onPauseSeguro);
            nodo.removeEventListener('ended', onEndedSeguro);
            nodo.removeEventListener('loadstart', onLoadStartSeguro);
            nodo.removeEventListener('timeupdate', onTimeUpdateSeguro);
            nodo.removeEventListener('seeking', onSeekingSeguro);
            nodo.removeEventListener('seeked', onSeekedSeguro);
        }

        function enabled() { return !!(VP.ajustes && VP.ajustes.activarMochiIA); }
        function leerModo() {
            if (modoActual === 'macho' || modoActual === 'hembra' || modoActual === 'off') return modoActual;
            try {
                var guardado = localStorage.getItem(MODE_KEY);
                if (guardado === 'macho' || guardado === 'hembra' || guardado === 'off') return guardado;
            } catch (_) {}
            // Una instalación previa solo guardaba activado/desactivado; activado
            // conserva el personaje femenino que ya existía.
            return enabled() ? 'hembra' : 'off';
        }
        function aplicarModo(modo, guardar) {
            if (modo !== 'macho' && modo !== 'hembra' && modo !== 'off') modo = 'off';
            modoActual = modo;
            var generoAnterior = CFG.genero;
            CFG.genero = modo === 'macho' ? 'macho' : 'hembra';
            if (VP.mochiMascota && typeof VP.mochiMascota.setGender === 'function') VP.mochiMascota.setGender(CFG.genero);
            if (generoAnterior !== CFG.genero && VP.mochiScheduler) VP.mochiScheduler.reset();
            if (VP.ajustes) VP.ajustes.activarMochiIA = modo !== 'off';
            if (checkbox) {
                checkbox.checked = modo !== 'off';
                var control = checkbox.closest ? checkbox.closest('.mochi-toggle') : checkbox.parentNode;
                if (control) {
                    control.setAttribute('data-mode', modo);
                    control.setAttribute('title', modo === 'macho' ? 'Mochi macho' : modo === 'hembra' ? 'Mochi hembra' : 'Mochi desactivado');
                }
                checkbox.setAttribute('aria-label', modo === 'macho' ? 'Mochi macho, activado. Pulsa para cambiar' : modo === 'hembra' ? 'Mochi hembra, activada. Pulsa para cambiar' : 'Mochi desactivado. Pulsa para cambiar');
            }
            try { localStorage.setItem(MODE_KEY, modo); } catch (_) {}
            if (guardar && VP.ajustes && typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(true);
            refreshEnabled();
        }
        function clearInstance() { VP.mochiScheduler.stop(); VP.mochiMascota.destroy(); hasGreetedThisVideo = false; }

        function onPlay() {
            if (!enabled()) { clearInstance(); return; }
            var pending = VP._mochiPendingVideoTransition || pendingVideoTransition;
            VP._mochiPendingVideoTransition = null;
            pendingVideoTransition = null;
            var reanudaTrasPausa = pausadoPorVideo && !pending;
            pausadoPorVideo = false;
            if (timerTransicionSueno) {
                clearTimeout(timerTransicionSueno);
                timerTransicionSueno = null;
            }
            VP.mochiMascota.show();
            // Al reanudar desde el sueño, conserva la secuencia despertar → estirar → idle.
            // En reproducción inicial Mochi se despereza directamente durante 1.2 s.
            if (pending === 'siguiente' || pending === 'anterior') {
                VP.mochiMascota.setState(pending === 'siguiente' ? 'cambiandoSiguiente' : 'cambiandoAnterior');
            } else if (pending === 'nuevo-video') {
                VP.mochiMascota.setState('videoNuevo', true, { duracion: 760, siguienteEstado: CFG.genero === 'macho' ? 'curioso' : 'curiosa', siguienteDuracion: 460 });
            } else if (reanudaTrasPausa) {
                VP.mochiMascota.setState('despertarReanudacion');
            } else {
                VP.mochiMascota.setState('estirando');
            }
            // Saludo tierno la primera vez que se reproduce cada video
            if (VP.mochiParametro('greetingEnabled') && !hasGreetedThisVideo && !VP.mochiMascota.estaOculto()) {
                hasGreetedThisVideo = true;
                setTimeout(function () {
                    if (enabled() && video && !video.paused && !video.ended) VP.mochiMascota.saludar();
                }, 900);
            }
            VP.mochiScheduler.start();
        }
        function onSubtitlesToggle(activos) {
            if (!enabled() || !VP.mochiMascota) return;
            if (activos) VP.mochiMascota.setState('leyendo', true);
            else VP.mochiMascota.setState('desactivandoLectura', true, { duracion: 560, siguienteEstado: 'idle' });
        }
        function onSubtitlesCleared() { onSubtitlesToggle(false); }
        function onPause() {
            if (!enabled() || !video || video.ended) return;
            pausadoPorVideo = true;
            VP.mochiScheduler.pause();
            if (timerTransicionSueno) clearTimeout(timerTransicionSueno);
            var videoEnPausa = video;
            var estadoSomnoliento = CFG.genero === 'macho' ? 'somnoliento' : 'somnolienta';
            var estadoDormido = CFG.genero === 'macho' ? 'durmiendo' : 'dormida';
            var terminarFrase = VP.mochiMascota.prepararSuenoDuranteHabla();
            if (!terminarFrase) VP.mochiMascota.setState(estadoSomnoliento);
            timerTransicionSueno = setTimeout(function () {
                timerTransicionSueno = null;
                if (video !== videoEnPausa || !video.paused || video.ended) return;
                if (terminarFrase && VP.mochiMascota.estaHablando()) {
                    timerTransicionSueno = setTimeout(function esperarFinFrase() {
                        timerTransicionSueno = null;
                        if (video !== videoEnPausa || !video.paused || video.ended) return;
                        if (VP.mochiMascota.estaHablando()) {
                            timerTransicionSueno = setTimeout(esperarFinFrase, 250);
                            return;
                        }
                        VP.mochiMascota.setState(estadoDormido);
                        programarCicloSueno(videoEnPausa, estadoSomnoliento, estadoDormido);
                    }, 250);
                    return;
                }
                VP.mochiMascota.setState(estadoDormido);
                programarCicloSueno(videoEnPausa, estadoSomnoliento, estadoDormido);
            }, 2000);
        }
        function programarCicloSueno(videoEnPausa, estadoSomnoliento, estadoDormido) {
            timerTransicionSueno = setTimeout(function () {
                timerTransicionSueno = null;
                if (video !== videoEnPausa || !video.paused || video.ended) return;
                VP.mochiMascota.setState(estadoSomnoliento);
                timerTransicionSueno = setTimeout(function () {
                    timerTransicionSueno = null;
                    if (video !== videoEnPausa || !video.paused || video.ended) return;
                    VP.mochiMascota.setState('despertarReanudacion', true, {
                        duracion: 1000,
                        siguienteEstado: estadoSomnoliento
                    });
                    // Despertando dura 1 s más el margen del controlador.
                    timerTransicionSueno = setTimeout(function () {
                        timerTransicionSueno = null;
                        if (video !== videoEnPausa || !video.paused || video.ended) return;
                        VP.mochiMascota.setState(estadoDormido);
                        programarCicloSueno(videoEnPausa, estadoSomnoliento, estadoDormido);
                    }, 2040);
                }, 2000);
            }, 6000);
        }
        function onEnded() {
            if (!enabled()) { clearInstance(); return; }
            VP.mochiScheduler.stop();
            VP.mochiMascota.despedir();
            hasGreetedThisVideo = false;
        }
        function onLoadStart() { hasGreetedThisVideo = false; VP.mochiScheduler.reset(); if (enabled() && video && !video.paused) onPlay(); }
        function onSeeking() { VP.mochiScheduler.seekStart(); if (enabled() && video && !video.paused) VP.mochiMascota.setState('idle'); }
        function onSeeked() { VP.mochiSubtitulos.invalidar(); VP.mochiScheduler.seekEnd(); }
        function onVideoChanged() {
            var nuevoVideo = localizarVideo();
            if (nuevoVideo && nuevoVideo !== video) {
                dejarDeEscucharVideo(video);
                video = nuevoVideo;
                VP.refs = VP.refs || {};
                VP.refs.videoPlayer = video;
                escucharVideo(video);
                if (observer) {
                    observer.disconnect();
                    observer.observe(video.parentNode || document.body, { childList: true });
                }
            }
            hasGreetedThisVideo = false;
            pausadoPorPestanaOculta = false;
            VP.mochiMascota.reiniciarOcultamiento();
            VP.mochiSubtitulos.invalidar();
            VP.mochiScheduler.reset();
            VP.mochiMascota.destroy();
            if (enabled() && video && !video.paused && !video.ended) onPlay();
        }
        function onVisibility() {
            if (document.hidden) {
                VP.mochiMascota.setMotionPaused(true);
                if (enabled() && video && !video.paused) { VP.mochiScheduler.pause(); pausadoPorPestanaOculta = true; }
                return;
            }
            VP.mochiMascota.setMotionPaused(false);
            if (enabled() && video && !video.ended) {
                var reanudarMotor = pausadoPorPestanaOculta && !video.paused;
                pausadoPorPestanaOculta = false;
                if (reanudarMotor) {
                    // Reanuda el motor sin repetir el saludo de inicio del video.
                    VP.mochiMascota.show();
                    VP.mochiScheduler.start();
                }
                VP.mochiMascota.setState('despertando');
            }
        }
        var lastBufferRefresh = 0;
        function onTimeUpdate() {
            if (!enabled() || !video || video.paused || Date.now() - lastBufferRefresh < 2000) return;
            lastBufferRefresh = Date.now();
            VP.mochiSubtitulos.actualizarBuffer(video.currentTime, VP.mochiParametro('bufferSeconds'), VP.mochiParametro('maxSubtitleChars'));
        }
        function onCuesReady() { lastBufferRefresh = 0; VP.mochiSubtitulos.invalidar(); VP.mochiScheduler.invalidateContext(); VP.mochiScheduler.wake(); }

        function refreshEnabled() {
            if (!enabled()) { clearInstance(); return; }
            if (video && !video.paused && !video.ended) onPlay();
        }
        function onSettingChange(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            // Deja que Brave/Chromium termine cualquier activación nativa del
            // checkbox antes de volver a fijar su estado visual programático.
            setTimeout(function () {
                var modos = ['macho', 'hembra', 'off'];
                var actual = leerModo();
                aplicarModo(modos[(modos.indexOf(actual) + 1) % modos.length], true);
            }, 0);
        }

        var onPlaySeguro = proteger(onPlay, 'onPlay');
        var onPauseSeguro = proteger(onPause, 'onPause');
        var onEndedSeguro = proteger(onEnded, 'onEnded');
        var onLoadStartSeguro = proteger(onLoadStart, 'onLoadStart');
        var onSeekingSeguro = proteger(onSeeking, 'onSeeking');
        var onSeekedSeguro = proteger(onSeeked, 'onSeeked');
        var onVideoChangedSeguro = proteger(onVideoChanged, 'onVideoChanged');
        var onVisibilitySeguro = proteger(onVisibility, 'onVisibility');
        var onTimeUpdateSeguro = proteger(onTimeUpdate, 'onTimeUpdate');
        var onCuesReadySeguro = proteger(onCuesReady, 'onCuesReady');
        var onSettingChangeSeguro = proteger(onSettingChange, 'onSettingChange');

        function bind() {
            video = localizarVideo();
            checkbox = document.getElementById('enableMochiAi');
            switchMochi = checkbox && checkbox.closest ? checkbox.closest('.mochi-toggle') : checkbox && checkbox.parentNode;
            if (!video) { errLog('No se encontró el elemento <video> para inicializar Mochi-IA.'); return; }
            VP.refs = VP.refs || {};
            VP.refs.videoPlayer = video;
            escucharVideo(video);
            // El perfil y el modo también deben restaurarse si la página no tiene toggle.
            aplicarModo(leerModo(), false);
            if (VP.bus && typeof VP.bus.on === 'function') {
                VP.bus.on('hdrCambiado', function (activo) {
                    if (VP.mochiMascota && typeof VP.mochiMascota.cambiarHDR === 'function') VP.mochiMascota.cambiarHDR(activo, true);
                });
            }
            if (VP.mochiMascota && typeof VP.mochiMascota.cambiarHDR === 'function') {
                VP.mochiMascota.cambiarHDR(!!(VP.estado && VP.estado.hdrActivo), false);
            }
            // Captura tanto clics sobre el control como sobre su etiqueta/slider.
            if (switchMochi) switchMochi.addEventListener('click', onSettingChangeSeguro, true);
            window.addEventListener('pagehide', destroy, { once: true });
            window.addEventListener('vpSubtitleCuesReady', onCuesReadySeguro);
            if (VP.bus && typeof VP.bus.on === 'function') VP.bus.on('subtitulosToggle', onSubtitlesToggle);
            if (VP.bus && typeof VP.bus.on === 'function') VP.bus.on('subtitulosLimpiados', onSubtitlesCleared);
            window.addEventListener('vpVideoChanged', onVideoChangedSeguro);
            document.addEventListener('visibilitychange', onVisibilitySeguro);
            if (typeof MutationObserver !== 'undefined' && document.body) {
                observer = new MutationObserver(function () {
                    var actual = localizarVideo();
                    if (actual && actual !== video) onVideoChangedSeguro();
                    else if (video && !document.documentElement.contains(video)) destroy();
                });
                observer.observe(video.parentNode || document.body, { childList: true });
            }
            destroyed = false;
            refreshEnabled();
        }
        function destroy() {
            if (destroyed) return;
            destroyed = true;
            if (VP.mochiMascota && typeof VP.mochiMascota.clearTechnicalState === 'function') VP.mochiMascota.clearTechnicalState();
            clearInstance();
            if (timerTransicionSueno) { clearTimeout(timerTransicionSueno); timerTransicionSueno = null; }
            if (observer) observer.disconnect();
            observer = null;
            dejarDeEscucharVideo(video);
            if (switchMochi) switchMochi.removeEventListener('click', onSettingChangeSeguro, true);
            switchMochi = null;
            document.removeEventListener('visibilitychange', onVisibilitySeguro);
            window.removeEventListener('pagehide', destroy);
            window.removeEventListener('vpSubtitleCuesReady', onCuesReadySeguro);
            if (VP.bus && typeof VP.bus.off === 'function') VP.bus.off('subtitulosToggle', onSubtitlesToggle);
            if (VP.bus && typeof VP.bus.off === 'function') VP.bus.off('subtitulosLimpiados', onSubtitlesCleared);
            window.removeEventListener('vpVideoChanged', onVideoChangedSeguro);
        }

        /* ---- API pública para depuración e integración avanzada ---- */
        window.VP.mochiMascotaAPI = {
            activar: function () { aplicarModo(leerModo() === 'off' ? 'hembra' : leerModo(), true); },
            desactivar: function () { aplicarModo('off', true); },
            estaActivo: enabled,
            reiniciar: function () { destroy(); bind(); },
            destruir: destroy,
            destrabar: function () { return VP.mochiScheduler.destrabar(); },
            forzarComentario: function () { return VP.mochiScheduler.forzarAhora(); },
            acariciar: function () { return VP.mochiMascota.acariciar(); },
            saludar: function () { return VP.mochiMascota.saludar(); },
            hablar: function (txt) { return VP.mochiMascota.hablarLocal(String(txt || '¡Hola! ♡')); },
            reaccionar: function (categoria) { return VP.mochiMascota.reaccionar(String(categoria || 'clic')); },
            cambiarPerfil: function (genero) {
                if (genero !== 'macho' && genero !== 'hembra') return false;
                aplicarModo(genero, true);
                return true;
            },
            posicionar: function (posicion) { return VP.mochiMascota.posicionar(posicion); },
            ocultar: function () { VP.mochiMascota.hide(); return true; },
            mostrar: function () { VP.mochiMascota.mostrar(); return true; },
            estado: function () {
                var estaHabilitado = enabled();
                var estadoActual = { habilitado: estaHabilitado,
                    genero: estaHabilitado ? CFG.genero : 'off',
                    perfil: estaHabilitado ? VP.mochiPerfilActual().id : 'off',
                    generoConfigurado: CFG.genero,
                    oculto: VP.mochiMascota.estaOculto(), scheduler: VP.mochiScheduler.estado(),
                    ollama: VP.mochiOllama.configuracion(),
                    subtitulos: (window.vpSubtitleCues || []).length };
                var mensajesEstado = {
                    'en espera': 'Mochi está lista cuando comience el video',
                    'buscando contexto': 'Mochi está buscando subtítulos para comentar',
                    'video pausado': 'Mochi está descansando mientras el video está en pausa',
                    'esperando subtítulos': 'Mochi espera subtítulos para poder comentar',
                    'esperando subtítulos nuevos': 'Mochi espera que aparezca un detalle nuevo',
                    'leyendo subtítulos': 'Mochi está leyendo los subtítulos para encontrar algo interesante',
                    'esperando una pausa': 'Mochi ya preparó un comentario y espera una pausa natural',
                    'generando con Ollama': 'Mochi está conversando con Ollama para preparar una curiosidad',
                    'Ollama ocupado': 'Ollama está ocupado; Mochi volverá a intentarlo',
                    'Ollama respondió SKIP o texto vacío': 'Mochi no encontró un dato fiable para compartir todavía',
                    'limpiando Ollama por respuesta repetida': 'Mochi detectó una respuesta repetida y esperará a que avance el video',
                    'Ollama sigue repitiendo': 'Mochi esperará un fragmento nuevo antes de volver a intentar',
                    'respuesta repetida descartada': 'Mochi espera un detalle distinto para no repetirse',
                    'buscando otra forma': 'Mochi está buscando otro enfoque para no repetir un comentario',
                    'sin alternativa nueva': 'Mochi no encontró otro enfoque y esperará un detalle distinto',
                    'comentario mostrado': 'Mochi acaba de compartir un comentario',
                    'error al leer subtítulos': 'Mochi tuvo un problema leyendo los subtítulos',
                    'error de Ollama': 'Mochi no pudo terminar su conversación con Ollama',
                    'pausa de seguridad': 'Mochi hará una pausa breve antes de volver a intentar'
                };
                var descripcion = !estadoActual.habilitado
                    ? 'Mochi está apagada'
                    : (mensajesEstado[estadoActual.scheduler.ultimoEstado] || 'Mochi está lista');
                consoleEvent('estado_actual', {
                    mensaje: descripcion,
                    habilitada: estadoActual.habilitado,
                    perfil: estadoActual.genero,
                    perfilConfigurado: estadoActual.generoConfigurado,
                    comunicacionConOllama: estadoActual.ollama.disponible ? 'disponible' : 'no disponible',
                    modelo: estadoActual.ollama.modelo,
                    subtitulosDisponibles: estadoActual.subtitulos,
                    ultimoError: estadoActual.scheduler.ultimoError || null,
                    metricas: estadoActual.scheduler.metricas
                });
                return estadoActual;
            },
            metricas: function () { return VP.mochiScheduler.metricas(); },
            configurar: function (parcial) {
                if (!parcial || typeof parcial !== 'object') return CFG;
                var generoAnterior = CFG.genero;
                var nuevoGenero = Object.prototype.hasOwnProperty.call(parcial, 'genero') ? parcial.genero : null;
                if (nuevoGenero !== 'macho' && nuevoGenero !== 'hembra') nuevoGenero = null;
                var perfil = nuevoGenero ? (VP.mochiPerfiles[nuevoGenero] || VP.mochiPerfilActual()) : VP.mochiPerfilActual();
                var parametrosPerfil = perfil.parametros || {};
                var overrides = U.fusionarObjeto
                    ? U.fusionarObjeto({}, (CFG.perfilParametros && CFG.perfilParametros[perfil.id]) || {})
                    : {};
                if (!U.fusionarObjeto && CFG.perfilParametros && CFG.perfilParametros[perfil.id]) {
                    var overridesGuardados = CFG.perfilParametros[perfil.id];
                    for (var claveOverride in overridesGuardados) {
                        if (Object.prototype.hasOwnProperty.call(overridesGuardados, claveOverride)) overrides[claveOverride] = overridesGuardados[claveOverride];
                    }
                }
                Object.keys(parcial).forEach(function (clave) {
                    if (clave === 'genero') return;
                    if (Object.prototype.hasOwnProperty.call(parametrosPerfil, clave)) overrides[clave] = parcial[clave];
                    else CFG[clave] = parcial[clave];
                });
                if (Object.keys(overrides).length) {
                    CFG.perfilParametros = CFG.perfilParametros || {};
                    CFG.perfilParametros[perfil.id] = overrides;
                }
                if (typeof CFG._validar === 'function') CFG._validar();
                if (nuevoGenero) aplicarModo(nuevoGenero, true);
                else {
                    if (VP.mochiMascota && typeof VP.mochiMascota.setGender === 'function') VP.mochiMascota.setGender(CFG.genero);
                    if (generoAnterior !== CFG.genero && VP.mochiScheduler) VP.mochiScheduler.reset();
                    if (VP._mochiEstilos) VP._mochiEstilos.inyectar();
                }
                if (VP.mochiMascota && typeof VP.mochiMascota.posicionar === 'function') {
                    VP.mochiMascota.posicionar(CFG.position);
                }
                return CFG;
            }
        };

        /* ---- Extensiones de frases y atajos de Mochi ---- */
        (function instalarMejoras() {
            var api = window.VP.mochiMascotaAPI;
            var perfiles = VP.mochiPerfiles;
            var claveFrases = 'vp_mochi_frases_personalizadas_v1';
            var atajos = { activo: true };

            function leerFrases() {
                try {
                    var raw = typeof U.storageGet === 'function'
                        ? U.storageGet(claveFrases, null)
                        : window.localStorage.getItem(claveFrases);
                    var data = raw ? JSON.parse(raw) : {};
                    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
                } catch (_) { return {}; }
            }

            function guardarFrases(data) {
                try {
                    var raw = JSON.stringify(data);
                    if (typeof U.storageSet === 'function') return U.storageSet(claveFrases, raw) !== false;
                    window.localStorage.setItem(claveFrases, raw);
                    return true;
                } catch (_) { return false; }
            }

            function inyectarFrases() {
                var data = leerFrases();
                ['macho', 'hembra'].forEach(function (genero) {
                    var perfil = perfiles[genero], grupos = data[genero];
                    if (!perfil || !grupos || typeof grupos !== 'object') return;
                    perfil.frases = perfil.frases || {};
                    Object.keys(grupos).forEach(function (categoria) {
                        if (!Array.isArray(grupos[categoria])) return;
                        perfil.frases[categoria] = perfil.frases[categoria] || [];
                        grupos[categoria].forEach(function (frase) {
                            if (typeof frase === 'string' && perfil.frases[categoria].indexOf(frase) < 0) {
                                perfil.frases[categoria].push(frase);
                            }
                        });
                    });
                });
            }

            var frasesPersonalizadas = {
                agregar: function (categoria, texto, genero) {
                    genero = genero || (VP.mochiConfig && VP.mochiConfig.genero);
                    categoria = String(categoria || '').trim().slice(0, 40);
                    texto = String(texto == null ? '' : texto).replace(/[\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
                    if ((genero !== 'macho' && genero !== 'hembra') || !categoria || !texto) return false;
                    var data = leerFrases();
                    data[genero] = data[genero] || {};
                    data[genero][categoria] = Array.isArray(data[genero][categoria]) ? data[genero][categoria] : [];
                    if (data[genero][categoria].indexOf(texto) >= 0 || data[genero][categoria].length >= 100) return false;
                    data[genero][categoria].push(texto);
                    if (!guardarFrases(data)) return false;
                    inyectarFrases();
                    return true;
                },
                listar: function (categoria, genero) {
                    genero = genero || (VP.mochiConfig && VP.mochiConfig.genero);
                    var data = leerFrases();
                    var lista = data[genero] && data[genero][categoria];
                    return Array.isArray(lista) ? lista.slice() : [];
                },
                quitar: function (categoria, texto, genero) {
                    genero = genero || (VP.mochiConfig && VP.mochiConfig.genero);
                    if (genero !== 'macho' && genero !== 'hembra') return false;
                    var data = leerFrases();
                    var lista = data[genero] && data[genero][categoria];
                    if (!Array.isArray(lista)) return false;
                    var indice = lista.indexOf(texto);
                    if (indice < 0) return false;
                    lista.splice(indice, 1);
                    if (!guardarFrases(data)) return false;
                    var base = perfiles[genero].frases && perfiles[genero].frases[categoria];
                    if (Array.isArray(base)) {
                        var indiceBase = base.indexOf(texto);
                        if (indiceBase >= 0) base.splice(indiceBase, 1);
                    }
                    return true;
                },
                exportar: leerFrases,
                importar: function (data) {
                    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
                    if (!guardarFrases(data)) return false;
                    inyectarFrases();
                    return true;
                }
            };

            function esCampoEditable(elemento) {
                if (!elemento) return false;
                var tag = String(elemento.tagName || '').toLowerCase();
                return tag === 'input' || tag === 'textarea' || tag === 'select' || !!elemento.isContentEditable;
            }

            function manejarAtajo(evento) {
                if (!atajos.activo || !evento || !evento.altKey || !evento.shiftKey || evento.ctrlKey || evento.metaKey || esCampoEditable(document.activeElement)) return;
                var acciones = {
                    M: function () { if (VP.mochiMascota && VP.mochiMascota.estaOculto()) api.mostrar(); else api.ocultar(); },
                    S: function () { api.saludar(); },
                    A: function () { api.acariciar(); },
                    C: function () { api.forzarComentario(); }
                };
                var accion = acciones[String(evento.key || '').toUpperCase()];
                if (!accion) return;
                accion();
                evento.preventDefault();
            }

            inyectarFrases();
            document.addEventListener('keydown', manejarAtajo, true);
            api.mejoras = {
                frases: frasesPersonalizadas,
                atajos: {
                    activar: function () { atajos.activo = true; },
                    desactivar: function () { atajos.activo = false; },
                    lista: function () { return ['Alt+Shift+M: mostrar/ocultar', 'Alt+Shift+S: saludar', 'Alt+Shift+A: acariciar', 'Alt+Shift+C: comentario']; }
                },
                utilidades: {
                    describeError: U.describeError,
                    computeSimilarity: U.computeSimilarity,
                    normalizeWhitespace: U.normalizeWhitespace
                }
            };
        })();

        try {
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
            else bind();
        } catch (e) {
            errLog('Fallo crítico al inicializar Mochi-IA:', e);
        }
    })(window, document);
