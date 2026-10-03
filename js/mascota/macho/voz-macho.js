/* Voz de Mochi (macho) — motor sanoTTS 100% offline (WASM incrustado en base64).
 *
 * Adaptador de perfil: traduce la API pública de voz (hablar / detener / activar /
 * liberar / setVolume / getVolume / estaListo / estaHablando, con onStart y onEnd)
 * al motor sanoTTS que vive en js/tts-sano/voz-sano.js. Ese módulo es un script
 * normal: se inyecta una sola vez y no descarga ningún modelo hasta que se le pide
 * hablar, así que con la voz apagada no se carga nada.
 *
 * El runtime es compartido, igual que antes: la voz femenina (voz-hembra.js) se
 * apoya en este mismo núcleo, de modo que ambos perfiles usan el WASM una sola vez.
 */
(function (window) {
    'use strict';

    var VP = window.VP = window.VP || {};
    VP._mochiMacho = VP._mochiMacho || {};

    var scriptActual = document.currentScript;
    var urlModulo = scriptActual && scriptActual.src
        ? scriptActual.src
        : new URL('js/mascota/macho/voz-macho.js', document.baseURI).href;
    var urlSano = new URL('../../tts-sano/voz-sano.js', urlModulo).href;

    /* ------------------------------------------------------- núcleo sanoTTS */

    var nucleo = VP._mochiSano = VP._mochiSano || (function crearNucleo() {
        var cargaSano = null;   // promesa de carga de js/tts-sano/voz-sano.js
        var volumen = 1;

        function log(mensaje, error) {
            if (!window.console) return;
            try {
                if (error !== undefined) window.console.warn('[Mochi] ' + mensaje, error);
                else window.console.warn('[Mochi] ' + mensaje);
            } catch (_) { /* la consola nunca debe romper la voz */ }
        }

        function motor() { return window.VozSano || null; }

        function cargar() {
            if (cargaSano) return cargaSano;
            if (motor()) { cargaSano = Promise.resolve(motor()); return cargaSano; }
            cargaSano = new Promise(function (resolve, reject) {
                var s = document.createElement('script');
                s.src = urlSano;
                s.async = false;
                s.onload = function () {
                    s.onload = s.onerror = null;
                    if (motor()) resolve(motor());
                    else reject(new Error('El motor sanoTTS no se registró al cargar.'));
                };
                s.onerror = function () {
                    s.onload = s.onerror = null;
                    cargaSano = null;
                    reject(new Error('No se pudo cargar ' + urlSano));
                };
                document.head.appendChild(s);
            }).catch(function (error) {
                cargaSano = null;
                log('No se pudo cargar el motor de voz sanoTTS; seguirá funcionando con texto.', error);
                throw error;
            });
            return cargaSano;
        }

        function setVolumen(valor) {
            var n = Number(valor);
            if (!isFinite(n)) n = 1;
            volumen = Math.max(0, Math.min(1, n));
            // sanoTTS aplica config.volumen sobre su nodo de ganancia en cada
            // reproducción, así que basta con mantenerlo al día.
            var s = motor();
            if (s && s.config) s.config.volumen = volumen;
            return volumen;
        }

        function getVolumen() { return volumen; }

        function detener() {
            var s = motor();
            if (s && typeof s.detener === 'function') {
                try { s.detener(); } catch (error) { log('No se pudo detener la voz.', error); }
            }
        }

        // Descarga el runtime y el modelo. La usa voz-comun al cambiar de género
        // y el propio adaptador al desactivar la voz.
        function liberar() {
            var s = motor();
            if (!s || typeof s.liberar !== 'function') return Promise.resolve();
            try { return Promise.resolve(s.liberar()).catch(function () { }); }
            catch (_) { return Promise.resolve(); }
        }

        /* Crea la fachada de un perfil (macho / hembra) sobre sanoTTS. */
        function perfil(genero, opciones) {
            opciones = opciones || {};
            var activada = false;

            function disponible() {
                var s = motor();
                return activada && !!(s && s.estaListo && s.estaListo());
            }

            function hablando() {
                var s = motor();
                if (!activada || !s || !s.estaHablando) return false;
                try { return !!s.estaHablando(); } catch (_) { return false; }
            }

            function activar(valor) {
                if (!valor) {
                    activada = false;
                    detener();
                    return liberar();
                }
                if (activada) return Promise.resolve(true);
                activada = true;
                return cargar().then(function (s) {
                    if (!activada) return false;
                    return s.precargar(genero);
                }).then(function () {
                    setVolumen(volumen);
                    return true;
                }).catch(function (error) {
                    activada = false;
                    log('No se pudo activar la voz ' + genero + ' de Mochi.', error);
                    throw error;
                });
            }

            function hablar(texto, opcionesHablar) {
                opcionesHablar = opcionesHablar || {};
                var s = motor();
                if (!activada || !s) return Promise.resolve({ silenciado: true });
                // Un perfil de Mochi habla únicamente mientras es el género activo.
                if (opciones.soloEnPerfil && !opciones.soloEnPerfil()) {
                    return Promise.resolve({ cancelado: true });
                }
                if (!String(texto == null ? '' : texto).trim()) return Promise.resolve({ omitido: true });

                var finNotificado = false;
                function notificarFin(resultado) {
                    if (finNotificado) return;
                    finNotificado = true;
                    if (typeof opcionesHablar.onEnd === 'function') {
                        try { opcionesHablar.onEnd(resultado || { terminado: true }); }
                        catch (error) { log('No se pudo restaurar el estado de voz.', error); }
                    }
                }

                // onStart se dispara antes de cargar el modelo, igual que con el
                // motor anterior: la animación de "hablando" no espera a la carga.
                if (typeof opcionesHablar.onStart === 'function') {
                    try { opcionesHablar.onStart({ genero: genero }); }
                    catch (error) { log('No se pudo iniciar el estado de voz.', error); }
                }

                setVolumen(volumen);

                var p;
                try {
                    p = s.hablar(texto, {
                        genero: genero,
                        alEmpezar: function () {
                            if (typeof opcionesHablar.alEmpezar === 'function') {
                                try { opcionesHablar.alEmpezar(); } catch (_) { }
                            }
                        },
                        alTerminar: function () { notificarFin({ terminado: true }); }
                    });
                } catch (error) {
                    var inmediato = error.message || 'No se pudo iniciar la voz.';
                    notificarFin({ error: inmediato });
                    return Promise.resolve({ error: inmediato });
                }

                return Promise.resolve(p).then(function (empezo) {
                    // sanoTTS no llama a alTerminar si no llegó a hablar (texto
                    // vacío, modelo ausente o voz cancelada a mitad): hay que
                    // cerrar la tarea igualmente para no dejar la UI colgada.
                    if (!empezo) notificarFin({ error: 'La voz no está disponible.' });
                    else notificarFin({ terminado: true });
                    return empezo ? { terminado: true } : { error: 'La voz no está disponible.' };
                }, function (error) {
                    var mensaje = (error && error.message) || 'Falló la síntesis.';
                    notificarFin({ error: mensaje });
                    log('Falló la síntesis; seguirá funcionando con texto.', error);
                    return { error: mensaje };
                });
            }

            function liberarPerfil() {
                activada = false;
                detener();
                return liberar();
            }

            return {
                hablar: hablar,
                detener: detener,
                activar: activar,
                liberar: liberarPerfil,
                setVolume: setVolumen,
                getVolume: getVolumen,
                estaListo: disponible,
                estaHablando: hablando,
                getGenero: function () { return genero; }
            };
        }

        return {
            cargar: cargar,
            perfil: perfil,
            setVolumen: setVolumen,
            getVolumen: getVolumen,
            detener: detener,
            liberar: liberar
        };
    })();

    var api = nucleo.perfil('macho');
    // voz-comun empuja el volumen al cambiar de género; ese camino no pasa por el
    // control, así que el wrapper refresca el slider además de aplicarlo.
    var setVolumeBase = api.setVolume;
    api.setVolume = function (valor) {
        var v = setVolumeBase(valor);
        if (v > 0) ultimoVolumen = v;
        actualizarUIVolumen();
        return v;
    };
    VP._mochiMacho.voz = api;
    VP.mochiVozMacho = api;
    // Contrato conservado para el perfil femenino y para diagnóstico.
    VP._mochiMacho.esperarMotor = function () { return nucleo.cargar(); };
    VP._mochiMacho.getMotor = function () { return window.VozSano || null; };

    /* ------------------------------------------------------ controles de la UI */

    var ultimoVolumen = 1;

    function actualizarUIVolumen() {
        var volumen = nucleo.getVolumen();
        var slider = document.getElementById('ttsVolumeSlider');
        var bar = document.getElementById('ttsVolumeBar');
        var boton = document.getElementById('ttsVolumeBtn');
        var control = document.querySelector('.tts-volume-control');
        var porcentaje = Math.round(volumen * 100);
        var silenciado = volumen <= 0;
        if (bar) bar.style.width = porcentaje + '%';
        if (slider) slider.setAttribute('aria-valuenow', String(porcentaje));
        if (boton) {
            boton.setAttribute('aria-pressed', silenciado ? 'true' : 'false');
            boton.setAttribute('aria-label', silenciado ? 'Activar voz IA' : 'Silenciar voz IA');
            boton.setAttribute('data-tooltip', silenciado ? 'Activar voz IA' : 'Volumen de voz IA');
        }
        if (control) control.setAttribute('data-muted', silenciado ? 'true' : 'false');
        var iconUp = document.getElementById('ttsIconVolUp');
        var iconDown = document.getElementById('ttsIconVolDown');
        var iconMute = document.getElementById('ttsIconMute');
        if (iconUp) iconUp.style.display = !silenciado && volumen >= 0.5 ? '' : 'none';
        if (iconDown) iconDown.style.display = !silenciado && volumen < 0.5 ? '' : 'none';
        if (iconMute) iconMute.style.display = silenciado ? '' : 'none';
    }

    function establecerVolumen(valor, guardar) {
        var volumen = nucleo.setVolumen(valor);
        if (volumen > 0) ultimoVolumen = volumen;
        if (guardar && VP.ajustes) {
            VP.ajustes.ttsVolume = volumen;
            VP.ajustes.ttsLastVolume = ultimoVolumen;
            if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar();
        }
        actualizarUIVolumen();
        return volumen;
    }

    function aplicarPreferencia(activado) {
        var control = document.getElementById('mochiVoiceEnabled');
        var estado = document.getElementById('mochiVoiceStatus');
        var controladorVoz = VP.mochiVoz || api;
        if (!activado) {
            controladorVoz.activar(false);
            if (estado) estado.textContent = 'Voz silenciada';
            return;
        }
        if (controladorVoz.estaListo && controladorVoz.estaListo()) {
            if (estado) estado.textContent = 'Voz activada · sanoTTS';
            return;
        }
        if (estado) estado.textContent = 'Cargando voz…';
        controladorVoz.activar(true).then(function () {
            if (estado) estado.textContent = 'Voz activada · sanoTTS';
        }).catch(function () {
            controladorVoz.activar(false);
            if (control) control.checked = false;
            if (VP.ajustes) {
                VP.ajustes.vozMochiActivada = false;
                if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(true);
            }
            if (estado) estado.textContent = 'Voz no disponible';
        });
    }

    function conectarControl() {
        var control = document.getElementById('mochiVoiceEnabled');
        var slider = document.getElementById('ttsVolumeSlider');
        var botonVolumen = document.getElementById('ttsVolumeBtn');

        if (slider) {
            function desdePuntero(evento) {
                var rect = slider.getBoundingClientRect();
                if (!rect.width) return;
                establecerVolumen((evento.clientX - rect.left) / rect.width, true);
            }
            var arrastrando = false;
            var punteroActivo = null;
            var volumenControl = slider.closest ? slider.closest('.tts-volume-control') : null;
            function quitarColapsoTemporal() {
                if (volumenControl) volumenControl.classList.remove('is-collapsed-after-drag');
            }
            function moverPuntero(evento) {
                if (arrastrando && evento.pointerId === punteroActivo) desdePuntero(evento);
            }
            function finalizarArrastre(evento) {
                if (!arrastrando || (evento && evento.pointerId !== punteroActivo)) return;
                arrastrando = false;
                punteroActivo = null;
                if (volumenControl) {
                    volumenControl.classList.remove('is-dragging');
                    volumenControl.classList.add('is-collapsed-after-drag');
                }
                document.removeEventListener('pointermove', moverPuntero);
                document.removeEventListener('pointerup', finalizarArrastre);
                document.removeEventListener('pointercancel', finalizarArrastre);
                if (document.activeElement === slider) slider.blur();
            }
            if (volumenControl) {
                volumenControl.addEventListener('pointerenter', quitarColapsoTemporal);
                volumenControl.addEventListener('pointerleave', quitarColapsoTemporal);
            }
            slider.addEventListener('pointerdown', function (evento) {
                arrastrando = true;
                punteroActivo = evento.pointerId;
                if (volumenControl) {
                    volumenControl.classList.remove('is-collapsed-after-drag');
                    volumenControl.classList.add('is-dragging');
                }
                desdePuntero(evento);
                document.addEventListener('pointermove', moverPuntero);
                document.addEventListener('pointerup', finalizarArrastre);
                document.addEventListener('pointercancel', finalizarArrastre);
            });
            slider.addEventListener('keydown', function (evento) {
                var cambio = 0;
                if (evento.key === 'ArrowLeft' || evento.key === 'ArrowDown') cambio = -0.05;
                else if (evento.key === 'ArrowRight' || evento.key === 'ArrowUp') cambio = 0.05;
                else if (evento.key === 'Home') cambio = -1;
                else if (evento.key === 'End') cambio = 1;
                else return;
                evento.preventDefault();
                establecerVolumen(cambio === -1 ? 0 : cambio === 1 ? 1 : nucleo.getVolumen() + cambio, true);
            });
        }
        if (botonVolumen) botonVolumen.addEventListener('click', function () {
            establecerVolumen(nucleo.getVolumen() > 0 ? 0 : (ultimoVolumen || 1), true);
        });
        actualizarUIVolumen();

        if (!control) return;
        function sincronizarPreferencia() {
            var preferida = !!(VP.ajustes && VP.ajustes.vozMochiActivada);
            if (VP.ajustes && isFinite(Number(VP.ajustes.ttsVolume))) {
                ultimoVolumen = Math.max(0.01, Math.min(1, Number(VP.ajustes.ttsLastVolume) || 1));
                establecerVolumen(VP.ajustes.ttsVolume, false);
            }
            control.checked = preferida;
            aplicarPreferencia(preferida);
        }
        control.addEventListener('change', function () {
            var activada = !!control.checked;
            if (VP.ajustes) {
                VP.ajustes.vozMochiActivada = activada;
                if (typeof VP.ajustes.guardar === 'function') VP.ajustes.guardar(true);
            }
            aplicarPreferencia(activada);
        });
        if (VP.bus && typeof VP.bus.on === 'function') VP.bus.on('ajustesAplicados', sincronizarPreferencia);
        sincronizarPreferencia();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', conectarControl, { once: true });
    else conectarControl();
})(window);
