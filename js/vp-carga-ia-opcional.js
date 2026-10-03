(function (window, document) {
    'use strict';

    var scripts = [
        'js/vp-capitulos-ia.js',
        'js/vp-resumen-ia.js',
        'js/vp-rag-core.js',
        'js/vp-rag-literal.js',
        'js/vp-rag-terminos.js',
        'js/vp-rag-definiciones.js',
        'js/vp-rag-pasos.js',
        'js/vp-rag-pipeline.js',
        'js/vp-chat-ia.js',
        'js/vp-traduccion-ia.js',
        'js/vp-vision-ia.js',
        'js/vp-etiquetas-ia.js',
        'js/vp-comentarios-ia.js'
    ];
    var recommendationsScript = 'js/vp-recomendaciones-ia.js';
    var started = false;
    var loaded = false;
    var loadPromise = null;
    var recommendationsPromise = null;
    var launcherSelector = [
        '#summaryBtn',
        '#chaptersIABtn',
        '#chatIABtn',
        '#translateIABtn',
        '#visionIABtn',
        '#tagsIABtn',
        '#commentaryIABtn'
    ].join(',');

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = src;
            script.async = false;
            script.onload = resolve;
            script.onerror = function () {
                reject(new Error('No se pudo cargar ' + src));
            };
            document.head.appendChild(script);
        });
    }

    function loadOptionalScripts() {
        if (loadPromise) return loadPromise;
        started = true;
        loadPromise = scripts.reduce(function (chain, src) {
            return chain.then(function () {
                return loadScript(src);
            });
        }, Promise.resolve()).then(function () {
            loaded = true;
        }).catch(function (error) {
            started = false;
            loaded = false;
            loadPromise = null;
            if (window.console && typeof window.console.error === 'function') {
                window.console.error('[VP] Error cargando módulos de IA:', error);
            }
            throw error;
        });
        return loadPromise;
    }

    function loadRecommendations() {
        if (recommendationsPromise) return recommendationsPromise;
        recommendationsPromise = loadScript(recommendationsScript).catch(function (error) {
            recommendationsPromise = null;
            if (window.console && typeof window.console.error === 'function') {
                window.console.error('[VP] Error cargando recomendaciones de IA:', error);
            }
            throw error;
        });
        return recommendationsPromise;
    }

    function preloadOnIntent() {
        loadOptionalScripts().catch(function () {});
    }

    function replayClickAfterLoad(event) {
        var launcher = event.target && event.target.closest
            ? event.target.closest(launcherSelector)
            : null;
        if (!launcher || loaded || launcher.dataset.vpIaReplay === '1') return;

        event.preventDefault();
        event.stopImmediatePropagation();
        launcher.setAttribute('aria-busy', 'true');
        loadOptionalScripts().then(function () {
            launcher.removeAttribute('aria-busy');
            launcher.dataset.vpIaReplay = '1';
            launcher.click();
            delete launcher.dataset.vpIaReplay;
        }).catch(function () {
            launcher.removeAttribute('aria-busy');
        });
    }

    function bindLoadOnIntent() {
        document.addEventListener('pointerover', function (event) {
            var launcher = event.target && event.target.closest
                ? event.target.closest(launcherSelector)
                : null;
            if (launcher) preloadOnIntent();
        }, { passive: true });

        document.addEventListener('focusin', function (event) {
            var launcher = event.target && event.target.closest
                ? event.target.closest(launcherSelector)
                : null;
            if (launcher) preloadOnIntent();
        });

        document.addEventListener('click', replayClickAfterLoad, true);

        var bus = window.VP && window.VP.bus;
        if (bus && typeof bus.on === 'function') {
            bus.on('videosCargados', function () {
                loadRecommendations().catch(function () {});
            });
        }
        if (window.VP && window.VP.estado &&
                Array.isArray(window.VP.estado.videos) && window.VP.estado.videos.length) {
            loadRecommendations().catch(function () {});
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindLoadOnIntent, { once: true });
    } else {
        bindLoadOnIntent();
    }
})(window, document);
