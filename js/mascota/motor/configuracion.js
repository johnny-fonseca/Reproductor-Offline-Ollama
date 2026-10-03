    /* ==========================================================================
       1. CONFIGURACIÓN CENTRAL
       ========================================================================== */
    (function (window) {
        'use strict';
        var VALID_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
        var VALID_PERSONALIDADES = ['dulce-curiosa', 'traviesa', 'mimosa', 'chispita'];
        var VALID_GENEROS = ['hembra', 'macho'];
        var VALID_IDIOMAS = ['es', 'en', 'pt'];
        var CONFIG_VERSION = 2;

        function isPlainObject(value) {
            if (value == null || typeof value !== 'object') return false;
            if (Array.isArray(value)) return false;
            if (value instanceof Error) return false;
            var proto = Object.getPrototypeOf ? Object.getPrototypeOf(value) : Object.prototype;
            return proto === Object.prototype || proto === null;
        }

        // Fusión superficial (compatibilidad heredada).
        function fusionarObjetos(destino, origen) {
            if (!origen) return destino;
            for (var clave in origen) {
                if (Object.prototype.hasOwnProperty.call(origen, clave)) destino[clave] = origen[clave];
            }
            return destino;
        }

        // Fusión profunda para objetos planos: preserva subclaves de defaults
        // cuando el usuario solo define una parte (p. ej. perfilParametros).
        function fusionarProfundo(destino, origen) {
            if (!isPlainObject(origen)) return destino;
            for (var clave in origen) {
                if (!Object.prototype.hasOwnProperty.call(origen, clave)) continue;
                var valor = origen[clave];
                if (isPlainObject(valor) && isPlainObject(destino[clave])) {
                    fusionarProfundo(destino[clave], valor);
                } else if (isPlainObject(valor)) {
                    var copia = {};
                    fusionarProfundo(copia, valor);
                    destino[clave] = copia;
                } else {
                    destino[clave] = valor;
                }
            }
            return destino;
        }

        function cloneDeep(value) {
            if (Array.isArray(value)) {
                var arr = new Array(value.length);
                for (var i = 0; i < value.length; i++) arr[i] = cloneDeep(value[i]);
                return arr;
            }
            if (isPlainObject(value)) {
                var obj = {};
                for (var key in value) {
                    if (Object.prototype.hasOwnProperty.call(value, key)) obj[key] = cloneDeep(value[key]);
                }
                return obj;
            }
            return value;
        }

        function deepFreeze(obj, seen) {
            if (!obj || typeof obj !== 'object') return obj;
            seen = seen || [];
            // Evita ciclos (no debería haberlos en defaults, pero por seguridad).
            for (var i = 0; i < seen.length; i++) if (seen[i] === obj) return obj;
            seen.push(obj);
            try { Object.freeze(obj); } catch (_) {}
            for (var key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) deepFreeze(obj[key], seen);
            }
            return obj;
        }

        var defaults = {
            configVersion: CONFIG_VERSION,
            enabled: false,
            model: 'Qwen3.5:9B-H',
            endpoint: 'http://localhost:11434',
            bufferSeconds: 90,
            minIntervalMs: 8000,
            baseIntervalMs: 8000,
            maxIntervalMs: 8000,
            timeoutMs: 90000,
            maxSubtitleChars: 5000,
            minContextChars: 35,
            recentFactCount: 6,
            duplicateSimilarity: 0.72,
            commentaryTimingMarginSeconds: 1.5,
            staleContextSeconds: 90,
            busyPollMinMs: 500,
            busyPollMaxMs: 2000,
            position: 'bottom-right',
            maxFactChars: 150,
            idioma: 'es',
            genero: 'hembra',
            jitterRatio: 0,
            maxConsecutiveFailures: 5,
            sleepCooldownMs: 300000,
            maxRetries: 1,
            respectReducedMotion: true,
            typewriterMs: 22,
            bubbleDurationMs: 8000,
            greetingEnabled: true,
            idleGestures: true,
            clickReactions: true,
            particleEffects: true,
            personalidad: 'dulce-curiosa',
            debug: false,
            // Extensiones de robustez:
            maxPromptChars: 8000,
            maxHistoryChars: 2000,
            maxResponseChars: 600,
            maxResponseWords: 100,
            maxEndpointLength: 512,
            maxModelLength: 128,
            sanitizeHtml: true,
            logLevel: 'info',
            featureFlags: {
                experimentales: false,
                telemetria: false,
                promptHardening: true
            }
        };

        function clampNumber(value, min, max, fallback) {
            var num = Number(value);
            if (!isFinite(num)) return fallback;
            if (min != null) num = Math.max(min, num);
            if (max != null) num = Math.min(max, num);
            return num;
        }

        function safeString(value, maxLen, fallback) {
            if (value == null) return fallback;
            var str = String(value);
            if (typeof maxLen === 'number' && maxLen > 0) str = str.slice(0, maxLen);
            return str;
        }

        function sanitizeUrl(raw, fallback) {
            var value = String(raw == null ? '' : raw).trim();
            if (!value) return fallback;
            if (value.length > defaults.maxEndpointLength) value = value.slice(0, defaults.maxEndpointLength);
            if (!/^https?:\/\//i.test(value)) return fallback;
            return value.replace(/\/+$/, '');
        }

        function validar(cfg) {
            if (!isPlainObject(cfg)) cfg = {};
            cfg.configVersion = CONFIG_VERSION;
            cfg.bufferSeconds = clampNumber(cfg.bufferSeconds, 10, 600, defaults.bufferSeconds);
            cfg.minIntervalMs = clampNumber(cfg.minIntervalMs, 1000, 300000, defaults.minIntervalMs);
            cfg.baseIntervalMs = clampNumber(cfg.baseIntervalMs, cfg.minIntervalMs, 600000, defaults.baseIntervalMs);
            cfg.maxIntervalMs = clampNumber(cfg.maxIntervalMs, cfg.baseIntervalMs, 900000, Math.max(defaults.maxIntervalMs, cfg.baseIntervalMs));
            cfg.timeoutMs = clampNumber(cfg.timeoutMs, 5000, 300000, defaults.timeoutMs);
            cfg.maxSubtitleChars = clampNumber(cfg.maxSubtitleChars, 500, 20000, defaults.maxSubtitleChars);
            cfg.minContextChars = clampNumber(cfg.minContextChars, 5, cfg.maxSubtitleChars, defaults.minContextChars);
            cfg.recentFactCount = clampNumber(cfg.recentFactCount, 1, 50, defaults.recentFactCount);
            cfg.duplicateSimilarity = clampNumber(cfg.duplicateSimilarity, 0, 1, defaults.duplicateSimilarity);
            cfg.commentaryTimingMarginSeconds = clampNumber(cfg.commentaryTimingMarginSeconds, 0.1, 10, defaults.commentaryTimingMarginSeconds);
            cfg.staleContextSeconds = clampNumber(cfg.staleContextSeconds, 10, 600, defaults.staleContextSeconds);
            cfg.busyPollMinMs = clampNumber(cfg.busyPollMinMs, 500, 60000, defaults.busyPollMinMs);
            cfg.busyPollMaxMs = clampNumber(cfg.busyPollMaxMs, cfg.busyPollMinMs, 120000, Math.max(defaults.busyPollMaxMs, cfg.busyPollMinMs));
            cfg.maxFactChars = clampNumber(cfg.maxFactChars, 40, 2000, defaults.maxFactChars);
            cfg.jitterRatio = clampNumber(cfg.jitterRatio, 0, 0.5, defaults.jitterRatio);
            cfg.maxConsecutiveFailures = clampNumber(cfg.maxConsecutiveFailures, 1, 50, defaults.maxConsecutiveFailures);
            cfg.sleepCooldownMs = clampNumber(cfg.sleepCooldownMs, 10000, 3600000, defaults.sleepCooldownMs);
            cfg.maxRetries = clampNumber(cfg.maxRetries, 0, 5, defaults.maxRetries);
            cfg.typewriterMs = clampNumber(cfg.typewriterMs, 5, 200, defaults.typewriterMs);
            cfg.bubbleDurationMs = clampNumber(cfg.bubbleDurationMs, 2000, 60000, defaults.bubbleDurationMs);
            cfg.maxPromptChars = clampNumber(cfg.maxPromptChars, 1000, 64000, defaults.maxPromptChars);
            cfg.maxHistoryChars = clampNumber(cfg.maxHistoryChars, 100, 20000, defaults.maxHistoryChars);
            cfg.maxResponseChars = clampNumber(cfg.maxResponseChars, 40, 4000, defaults.maxResponseChars);
            cfg.maxResponseWords = clampNumber(cfg.maxResponseWords, 5, 500, defaults.maxResponseWords);
            cfg.maxEndpointLength = clampNumber(cfg.maxEndpointLength, 32, 2048, defaults.maxEndpointLength);
            cfg.maxModelLength = clampNumber(cfg.maxModelLength, 8, 512, defaults.maxModelLength);
            if (VALID_POSITIONS.indexOf(cfg.position) === -1) cfg.position = defaults.position;
            if (VALID_PERSONALIDADES.indexOf(cfg.personalidad) === -1) cfg.personalidad = defaults.personalidad;
            if (VALID_GENEROS.indexOf(cfg.genero) === -1) cfg.genero = defaults.genero;
            if (VALID_IDIOMAS.indexOf(cfg.idioma) === -1) cfg.idioma = defaults.idioma;
            cfg.enabled = !!cfg.enabled;
            cfg.respectReducedMotion = !!cfg.respectReducedMotion;
            cfg.greetingEnabled = !!cfg.greetingEnabled;
            cfg.idleGestures = !!cfg.idleGestures;
            cfg.clickReactions = !!cfg.clickReactions;
            cfg.particleEffects = !!cfg.particleEffects;
            cfg.debug = !!cfg.debug;
            cfg.sanitizeHtml = cfg.sanitizeHtml !== false;
            if (typeof cfg.logLevel !== 'string' ||
                ['debug', 'info', 'warn', 'error', 'silent'].indexOf(cfg.logLevel) === -1) {
                cfg.logLevel = defaults.logLevel;
            }
            cfg.model = safeString(cfg.model, cfg.maxModelLength, defaults.model).trim() || defaults.model;
            cfg.endpoint = sanitizeUrl(cfg.endpoint, defaults.endpoint);
            if (!isPlainObject(cfg.perfilParametros)) cfg.perfilParametros = {};
            if (!isPlainObject(cfg.featureFlags)) cfg.featureFlags = cloneDeep(defaults.featureFlags);
            else {
                for (var flag in defaults.featureFlags) {
                    if (!Object.prototype.hasOwnProperty.call(cfg.featureFlags, flag)) {
                        cfg.featureFlags[flag] = defaults.featureFlags[flag];
                    }
                }
            }
            return cfg;
        }

        window.VP = window.VP || {};
        var mezclado = fusionarProfundo(
            fusionarProfundo(cloneDeep(defaults), window.VP.mochiConfig || {}),
            {}
        );
        window.VP.mochiConfig = validar(mezclado);
        window.VP.mochiConfig._validar = function () { return validar(window.VP.mochiConfig); };
        // Se exponen defaults congelados: evita mutaciones accidentales desde
        // consumidores que no deberían tocar los valores base.
        window.VP.mochiConfig._defaults = deepFreeze(cloneDeep(defaults));
        window.VP.mochiConfig._version = CONFIG_VERSION;
        window.VP.mochiPerfilActual = function () {
            var cfg = window.VP.mochiConfig || {};
            var perfiles = window.VP.mochiPerfiles || {};
            return perfiles[cfg.genero] || perfiles.hembra || {};
        };
        window.VP.mochiParametro = function (nombre) {
            // La cadencia de conversación solicitada es fija, incluso si una
            // preferencia antigua dejó guardado un intervalo mayor.
            if (nombre === 'minIntervalMs' || nombre === 'baseIntervalMs' || nombre === 'maxIntervalMs') return 8000;
            if (nombre === 'jitterRatio') return 0;
            var perfil = window.VP.mochiPerfilActual();
            var parametros = perfil.parametros || {};
            var overrides = window.VP.mochiConfig.perfilParametros || {};
            var overridePerfil = overrides[perfil.id] || {};
            if (Object.prototype.hasOwnProperty.call(overridePerfil, nombre)) return overridePerfil[nombre];
            return Object.prototype.hasOwnProperty.call(parametros, nombre)
                ? parametros[nombre]
                : window.VP.mochiConfig[nombre];
        };
        // Expone helpers útiles a otros módulos sin obligarlos a reimplementar.
        window.VP._mochiConfigHelpers = {
            isPlainObject: isPlainObject,
            cloneDeep: cloneDeep,
            fusionarProfundo: fusionarProfundo,
            deepFreeze: deepFreeze,
            validar: validar
        };
    })(window);
