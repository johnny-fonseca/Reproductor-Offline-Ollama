// ============================================================
// VP-BUSQUEDA.JS — Módulo centralizado de búsqueda de videos
// v2.0 — Motor de búsqueda avanzado con:
//   · Índice invertido con puntuación de relevancia (TF-IDF simplificado)
//   · Búsqueda difusa (Levenshtein) con umbral configurable
//   · Stemming básico en español e inglés
//   · Stop-words multilingüe filtradas del índice
//   · Caché LRU con TTL configurable
//   · Historial de búsquedas persistido en almacenamiento
//   · Autocompletado desde el corpus de términos indexados
//   · Sistema de filtros activos (categoría, duración, extensión)
//   · Resaltado de coincidencias (highlight) en el DOM
//   · Navegación por teclado en sugerencias
//   · Paginación de resultados
//   · Analytics internos (queries populares, tasa de éxito)
//   · Eventos personalizados (CustomEvent) para extensibilidad
//   · Serialización / restauración del índice
//   · Modo de búsqueda configurable (normal | fuzzy | exacta)
//
// Requiere: vp-base.js, vp-utilidades.js, vp-dom.js
// ============================================================

'use strict';

(function (window, document) {
    'use strict';

    if (!window || !document) return;

    var VP = window.VP;
    if (!VP) {
        throw new Error('[VP] vp-busqueda.js: vp-base.js debe cargarse primero.');
    }

    var util = VP.util;
    var log  = VP.log;
    log.setContext('Busqueda');

    // ============================================================
    // NAMESPACE
    // ============================================================

    VP.busqueda = VP.busqueda || {};

    // ============================================================
    // CONFIGURACIÓN (sobreescribible desde VP.config)
    // ============================================================

    var CFG = Object.assign({
        debounce               : 180,       // ms debounce input
        fuzzyMaxDistancia      : 2,         // edits máximos Levenshtein
        fuzzyMinLongitud       : 4,         // longitud mínima para aplicar fuzzy
        cacheMaxEntradas       : 60,        // entradas LRU máximas
        cacheTTL               : 120000,    // TTL caché en ms (2 min)
        historialMaxItems      : 20,        // búsquedas en historial
        historialKey           : 'vp_search_history',
        sugerenciasMax         : 8,         // sugerencias autocomplete
        sugerenciasMinChars    : 2,         // chars mínimos para sugerir
        highlightClass         : 'vp-highlight', // clase CSS para resaltado
        modoDefecto            : 'normal',  // 'normal' | 'fuzzy' | 'exacta'
        scoreExactoBonus       : 10,        // bonus puntuación coincidencia exacta
        scorePrefixBonus       : 5,         // bonus coincidencia de prefijo
        animacionBusqueda      : true,      // animar aparición/ocultación items
        paginacionActiva       : false,     // activar paginación
        itemsPorPagina         : 24,
        emitirEventos          : true,      // emitir CustomEvents
    }, (VP.config && VP.config.busqueda) || {});

    var _cacheIndicePrefijos = null;
    var _cacheIndicesTerminos = new WeakMap();

    // ============================================================
    // STOP-WORDS (ES + EN)
    // ============================================================

    var STOP_WORDS = new Set([
        // Español
        'de','la','el','en','y','a','los','del','se','las','por','un',
        'con','una','su','para','es','al','lo','como','más','pero','sus',
        'le','ya','o','fue','este','ha','me','si','sin','sobre','este',
        'entre','cuando','muy','sin','ser','hay','nos','también','mi',
        // Inglés
        'the','a','an','and','or','but','in','on','at','to','for',
        'of','with','by','from','is','was','are','were','be','been',
        'this','that','it','its','we','you','he','she','they',
    ]);

    // ============================================================
    // MAPA DE STEMS BÁSICOS (español + inglés)
    // Reemplazos simples sin librería externa
    // ============================================================

    var STEM_RULES = [
        // Español — plurales y sufijos comunes
        [/aciones$/i, 'acion'], [/ciones$/i,  'cion'],
        [/idades$/i,  'idad'],  [/ientes$/i,  'iente'],
        [/adores$/i,  'ador'],  [/encias$/i,  'encia'],
        [/mente$/i,   ''],      [/ando$/i,    ''],
        [/iendo$/i,   ''],      [/ados$/i,    'ado'],
        [/idos$/i,    'ido'],   [/es$/i,      ''],
        [/os$/i,      ''],      [/s$/i,       ''],
        // Inglés — sufijos comunes
        [/ings$/i,    'ing'],   [/tion$/i,    'te'],
        [/ations$/i,  'ate'],   [/ness$/i,    ''],
        [/ment$/i,    ''],      [/ies$/i,     'y'],
        [/ied$/i,     'y'],     [/ing$/i,     ''],
        [/ed$/i,      ''],      [/er$/i,      ''],
        [/ly$/i,      ''],
    ];

    function _stem(palabra) {
        if (!palabra || palabra.length < 4) return palabra;
        var resultado = palabra.toLowerCase();
        for (var i = 0; i < STEM_RULES.length; i++) {
            var candidato = resultado.replace(STEM_RULES[i][0], STEM_RULES[i][1]);
            if (candidato.length >= 3 && candidato !== resultado) {
                return candidato;
            }
        }
        return resultado;
    }

    // ============================================================
    // DISTANCIA DE LEVENSHTEIN
    // ============================================================

    function _levenshtein(a, b) {
        var la = a.length, lb = b.length;
        var limite = Number(CFG.fuzzyMaxDistancia);
        if (isNaN(limite) || limite < 0) return 0;
        if (!isFinite(limite)) limite = Math.max(la, lb);
        limite = Math.floor(limite);

        if (Math.abs(la - lb) > limite) return limite + 1;
        if (la === 0) return lb;
        if (lb === 0) return la;
        if (la < lb) {
            var texto = a;
            a = b;
            b = texto;
            la = a.length;
            lb = b.length;
        }

        var fueraDeBanda = limite + 1;
        var anterior = new Array(lb + 1).fill(fueraDeBanda);
        var actual   = new Array(lb + 1).fill(fueraDeBanda);
        for (var inicial = 0; inicial <= Math.min(lb, limite); inicial++) {
            anterior[inicial] = inicial;
        }

        for (var i = 1; i <= la; i++) {
            var inicio = Math.max(1, i - limite);
            var fin = Math.min(lb, i + limite);
            if (inicio > 1) actual[inicio - 1] = fueraDeBanda;
            else actual[0] = i;

            var minimoFila = fueraDeBanda;
            for (var j = inicio; j <= fin; j++) {
                var costo = a[i - 1] === b[j - 1] ? 0 : 1;
                actual[j] = Math.min(
                    anterior[j] + 1,
                    actual[j - 1] + 1,
                    anterior[j - 1] + costo
                );
                if (actual[j] < minimoFila) minimoFila = actual[j];
            }

            if (fin < lb) actual[fin + 1] = fueraDeBanda;
            if (minimoFila > limite) return fueraDeBanda;

            var filaAnterior = anterior;
            anterior = actual;
            actual = filaAnterior;
        }

        return anterior[lb] <= limite ? anterior[lb] : fueraDeBanda;
    }

    // ============================================================
    // TOKENIZADOR
    // Devuelve { tokens, stems, tokenRaw } para un texto
    // ============================================================

    function _tokenizar(texto) {
        if (!texto || typeof texto !== 'string') return [];
        var normalizado = texto.toLowerCase();
        if (typeof normalizado.normalize === 'function') normalizado = normalizado.normalize('NFD');
        normalizado = normalizado
            .replace(/[\u0300-\u036f]/g, '') // quitar acentos
            .replace(/[_\-\.\/\\]/g, ' ')
            .replace(/[^a-z0-9\s]/g, '')
            .trim();

        var partes = normalizado.split(/\s+/).filter(function (t) {
            return t.length > 0 && !STOP_WORDS.has(t);
        });

        var resultado = [];
        for (var i = 0; i < partes.length; i++) {
            resultado.push({
                raw  : partes[i],
                stem : _stem(partes[i]),
            });
        }
        return resultado;
    }

    // ============================================================
    // ESTADO INTERNO
    // ============================================================

    var _estado = {
        indiceGaleria      : null,   // Map<id, EntradaIndice>
        indicePlaylist     : null,
        corpusTerminos     : null,   // Set<string> de todos los términos indexados
        cacheLRU           : null,   // caché LRU
        historial          : [],
        filtrosActivos     : {},
        paginaActual       : 0,
        modoActual         : CFG.modoDefecto,
        analytics          : {
            totalBusquedas : 0,
            exitosas       : 0,
            fallidas       : 0,
            queriesTop     : {},     // query → count
        },
        sugerenciasVisible : false,
        sugerenciasIdxActivo : -1,
        sugerenciasDescartadas : false,
        ultimaQuery        : null,   // null fuerza re-búsqueda
        ultimosResultados  : null,
        _listeners         : {},     // eventos internos
        _aplicandoResultados: false, // bandera anti-reentrada
    };

    // ============================================================
    // CACHÉ LRU CON TTL
    // ============================================================

    function _crearCacheLRU(max, ttl) {
        var mapa  = new Map();
        var orden = [];  // FIFO simple (suficiente para <100 entradas)

        return {
            get: function (key) {
                if (!mapa.has(key)) return null;
                var entrada = mapa.get(key);
                if (Date.now() - entrada.ts > ttl) {
                    mapa.delete(key);
                    return null;
                }
                return entrada.valor;
            },
            set: function (key, valor) {
                if (mapa.has(key)) mapa.delete(key);
                if (orden.indexOf(key) !== -1)
                    orden.splice(orden.indexOf(key), 1);

                mapa.set(key, { valor: valor, ts: Date.now() });
                orden.push(key);

                if (orden.length > max) {
                    var vieja = orden.shift();
                    mapa.delete(vieja);
                }
            },
            invalidar: function () { mapa.clear(); orden = []; },
            size: function () { return mapa.size; },
            claves: function () { return Array.from(mapa.keys()); },
        };
    }

    // ============================================================
    // HISTORIAL DE BÚSQUEDAS


    function _cargarHistorial() {
        try {
            var raw = VP.db.obtenerKeyVal(CFG.historialKey);
            _estado.historial = Array.isArray(raw) ? raw : [];
        } catch (e) {
            _estado.historial = [];
        }
    }

    function _guardarHistorial(query) {
        if (!query || query.length < 2) return;
        var h = _estado.historial;
        var idx = h.indexOf(query);
        if (idx !== -1) h.splice(idx, 1);
        h.unshift(query);
        if (h.length > CFG.historialMaxItems) h.length = CFG.historialMaxItems;
        try {
            VP.db.guardarKeyVal(CFG.historialKey, h);
        } catch (e) { /**/ }
    }

    VP.busqueda.obtenerHistorial = function () {
        return _estado.historial.slice();
    };

    VP.busqueda.limpiarHistorial = function () {
        _estado.historial = [];
        try { VP.db.eliminarKeyVal(CFG.historialKey); } catch (e) { /**/ }
        _emitirEvento('historialLimpiado', {});
    };

    VP.busqueda.eliminarEntradaHistorial = function (query) {
        var idx = _estado.historial.indexOf(query);
        if (idx !== -1) {
            _estado.historial.splice(idx, 1);
            try {
                VP.db.guardarKeyVal(CFG.historialKey, _estado.historial);
            } catch (e) { /**/ }
        }
    };

    // ============================================================
    // EVENTOS PERSONALIZADOS
    // ============================================================

    function _emitirEvento(nombre, detalle) {
        if (!CFG.emitirEventos) return;
        try {
            document.dispatchEvent(new CustomEvent('vp:busqueda:' + nombre, {
                bubbles: true,
                detail : detalle || {},
            }));
        } catch (e) { /**/ }
    }

    // API pública para suscribirse a eventos internos del módulo
    VP.busqueda.on = function (nombre, fn) {
        if (!_estado._listeners[nombre]) _estado._listeners[nombre] = [];
        _estado._listeners[nombre].push(fn);
    };

    VP.busqueda.off = function (nombre, fn) {
        if (!_estado._listeners[nombre]) return;
        _estado._listeners[nombre] = _estado._listeners[nombre]
            .filter(function (f) { return f !== fn; });
    };

    function _emitirInterno(nombre, datos) {
        var fns = _estado._listeners[nombre] || [];
        for (var i = 0; i < fns.length; i++) {
            try { fns[i](datos); } catch (e) { /**/ }
        }
    }

    // ============================================================
    // VALIDAR VIDEO
    // ============================================================

    function _esVideoValido(v) {
        if (util && typeof util.validarVideoBasico === 'function') {
            return util.validarVideoBasico(v) && v.id != null;
        }
        return v != null &&
               typeof v === 'object' &&
               !Array.isArray(v) &&
               v.id   != null &&
               typeof v.name === 'string' &&
               v.name.trim().length > 0;
    }

    // ============================================================
    // CONSTRUIR ÍNDICE INVERTIDO CON SCORING
    //
    // Estructura por entrada:
    // Map<id, {
    //   tokens     : [{raw, stem}],   ← términos del nombre
    //   campos     : { name, tags, descripcion, ext, categoria },
    //   frecuencia : Map<stem, Number>,  ← TF
    //   metadatos  : { duracion, fecha, categoria, ext }
    // }>
    // ============================================================

    VP.busqueda._construirIndice = function (videos) {
        var indice  = new Map();
        var corpus  = new Set();

        if (!Array.isArray(videos)) return { indice: indice, corpus: corpus };

        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (!_esVideoValido(v)) continue;
            var nombreVideo = String(v.name || v.nombre || v.fileName || '').trim();
            if (!nombreVideo) continue;

            // Campos a indexar con sus pesos
            var camposTexto = [
                { campo: 'name',       valor: nombreVideo, peso: 3 },
                { campo: 'tags',       valor: (Array.isArray(v.tags)
                    ? v.tags.join(' ')
                    : (v.tags || '')),          peso: 2 },
                { campo: 'descripcion', valor: v.descripcion || v.description || '', peso: 1 },
                { campo: 'categoria',  valor: v.categoria   || v.category || '', peso: 2 },
            ];

            // Extraer extensión del nombre
            var extMatch = nombreVideo.match(/\.([^.]+)$/);
            var ext = extMatch ? extMatch[1].toLowerCase() : '';
            if (ext) camposTexto.push({ campo: 'ext', valor: ext, peso: 1 });

            var todosTokens = [];
            var tokensRaw = new Set();
            var frecuencia  = new Map();
            var camposMap   = {};

            for (var c = 0; c < camposTexto.length; c++) {
                var tokens = _tokenizar(camposTexto[c].valor);
                camposMap[camposTexto[c].campo] = tokens;

                for (var t = 0; t < tokens.length; t++) {
                    var tk = tokens[t];
                    todosTokens.push(tk);
                    tokensRaw.add(tk.raw);
                    corpus.add(tk.raw);
                    if (tk.stem) corpus.add(tk.stem);

                    // Frecuencia ponderada por peso del campo
                    var freq = frecuencia.get(tk.stem) || 0;
                    frecuencia.set(tk.stem, freq + camposTexto[c].peso);
                }
            }

            indice.set(String(v.id), {
                tokens    : todosTokens,
                tokensRaw : tokensRaw,
                campos    : camposMap,
                frecuencia: frecuencia,
                metadatos : {
                    duracion  : v.duracion   || v.duration  || 0,
                    fecha     : v.fecha      || v.date      || '',
                    categoria : v.categoria  || v.category  || '',
                    ext       : ext,
                },
            });
        }

        return { indice: indice, corpus: corpus };
    };

    function _agregarPosting(mapa, clave, id) {
        var ids = mapa.get(clave);
        if (!ids) {
            ids = new Set();
            mapa.set(clave, ids);
        }
        ids.add(id);
    }

    function _obtenerIndiceTerminos(indice) {
        var cache = _cacheIndicesTerminos.get(indice);
        if (cache && cache.tamano === indice.size) return cache;

        var postingsRaw = new Map();
        var postingsStem = new Map();
        var tokensPorCaracter = new Map();
        var tokensPorBigram = new Map();
        var tokensPorStem = new Map();
        var tokensIndexados = new Set();
        var stemsPorRaw = new Map();
        var ordenIds = new Map();
        var orden = 0;

        indice.forEach(function (entrada, id) {
            ordenIds.set(id, orden++);
            if (!entrada || !Array.isArray(entrada.tokens)) return;
            var rawEntrada = new Set();
            var stemsEntrada = new Set();

            for (var i = 0; i < entrada.tokens.length; i++) {
                var token = entrada.tokens[i];
                var raw = token && token.raw;
                var stem = token && token.stem;
                if (typeof raw !== 'string' || !raw) continue;

                if (!rawEntrada.has(raw)) {
                    rawEntrada.add(raw);
                    _agregarPosting(postingsRaw, raw, id);
                }
                if (typeof stem === 'string' && stem && !stemsEntrada.has(stem)) {
                    stemsEntrada.add(stem);
                    _agregarPosting(postingsStem, stem, id);
                }

                if (tokensIndexados.has(raw)) continue;
                tokensIndexados.add(raw);
                var stemRaw = typeof stem === 'string' ? stem : _stem(raw);
                stemsPorRaw.set(raw, stemRaw);
                if (stemRaw) {
                    var rawPorStem = tokensPorStem.get(stemRaw);
                    if (!rawPorStem) tokensPorStem.set(stemRaw, rawPorStem = new Set());
                    rawPorStem.add(raw);
                }
                for (var c = 0; c < raw.length; c++) {
                    _agregarPosting(tokensPorCaracter, raw.charAt(c), raw);
                    if (c + 1 < raw.length) {
                        _agregarPosting(tokensPorBigram, raw.slice(c, c + 2), raw);
                    }
                }
            }
        });

        cache = {
            tamano: indice.size,
            postingsRaw: postingsRaw,
            postingsStem: postingsStem,
            tokensPorCaracter: tokensPorCaracter,
            tokensPorBigram: tokensPorBigram,
            tokensPorStem: tokensPorStem,
            tokensIndexados: tokensIndexados,
            stemsPorRaw: stemsPorRaw,
            ordenIds: ordenIds,
        };
        _cacheIndicesTerminos.set(indice, cache);
        return cache;
    }

    function _obtenerCandidatosTermino(indiceTerminos, termino, modo) {
        var candidatos = new Set();

        function agregarIds(ids) {
            if (ids) ids.forEach(function (id) { candidatos.add(id); });
        }

        if (modo === 'exacta') {
            agregarIds(indiceTerminos.postingsRaw.get(termino.raw));
            return candidatos;
        }

        var tokens = termino.raw.length === 1
            ? indiceTerminos.tokensPorCaracter.get(termino.raw)
            : indiceTerminos.tokensPorBigram.get(termino.raw.slice(0, 2));
        if (tokens) {
            tokens.forEach(function (raw) {
                if (raw.indexOf(termino.raw) === -1) return;
                agregarIds(indiceTerminos.postingsRaw.get(raw));
            });
        }

        for (var longitud = 1; longitud < termino.raw.length; longitud++) {
            agregarIds(indiceTerminos.postingsRaw.get(termino.raw.slice(0, longitud)));
        }
        agregarIds(indiceTerminos.postingsStem.get(termino.stem));
        return candidatos;
    }

    // ============================================================
    // BUSCAR EN ÍNDICE CON PUNTUACIÓN
    //
    // Devuelve Array<{id, score}> ordenado descendente
    // ============================================================

    VP.busqueda._buscarEnIndice = function (indice, query, modo) {
        var resultados = [];
        if (!indice || !query) return resultados;
        modo = modo || _estado.modoActual;

        var terminos = _tokenizar(query);
        if (!terminos.length) return resultados;

        if (modo === 'fuzzy') {
            // Las distancias dependen del término y del token, no del video.
            // Usa postings de caracteres/stem para evitar recorrer vocabularios
            // grandes en cada búsqueda. Si el umbral puede borrar todos los
            // caracteres del término, conserva el recorrido completo.
            var fuzzyIndex = _obtenerIndiceTerminos(indice);
            var candidatosFuzzy = new Set();
            var tokensFuzzy = new Set();
            var distanciaConfigurada = Number(CFG.fuzzyMaxDistancia);
            var distanciaMaxima = Number.isFinite(distanciaConfigurada)
                ? Math.max(0, Math.floor(distanciaConfigurada))
                : Infinity;
            for (var ti = 0; ti < terminos.length; ti++) {
                var terminoBase = terminos[ti];
                if (terminoBase.raw.length <= distanciaMaxima) {
                    fuzzyIndex.tokensIndexados.forEach(function (raw) { tokensFuzzy.add(raw); });
                } else {
                    var charsQuery = new Set();
                    for (var cq = 0; cq < terminoBase.raw.length; cq++) {
                        charsQuery.add(terminoBase.raw.charAt(cq));
                    }
                    charsQuery.forEach(function (caracter) {
                        var tokensConCaracter = fuzzyIndex.tokensPorCaracter.get(caracter);
                        if (tokensConCaracter) tokensConCaracter.forEach(function (raw) { tokensFuzzy.add(raw); });
                    });
                }
                var tokensMismoStem = fuzzyIndex.tokensPorStem.get(terminoBase.stem);
                if (tokensMismoStem) tokensMismoStem.forEach(function (raw) { tokensFuzzy.add(raw); });
            }

            tokensFuzzy.forEach(function (raw) {
                for (var t = 0; t < terminos.length; t++) {
                    var termino = terminos[t];
                    var coincide = raw === termino.raw ||
                        raw.indexOf(termino.raw) === 0 || termino.raw.indexOf(raw) === 0 ||
                        raw.indexOf(termino.raw) !== -1 ||
                        (!!termino.stem && termino.stem === fuzzyIndex.stemsPorRaw.get(raw)) ||
                        (raw.length >= CFG.fuzzyMinLongitud &&
                         termino.raw.length >= CFG.fuzzyMinLongitud &&
                         _levenshtein(termino.raw, raw) <= CFG.fuzzyMaxDistancia);
                    if (coincide) {
                        var ids = fuzzyIndex.postingsRaw.get(raw);
                        if (ids) ids.forEach(function (id) { candidatosFuzzy.add(id); });
                        break;
                    }
                }
            });
            candidatosFuzzy.forEach(function (id) {
                var entrada = indice.get(id);
                if (!entrada) return;
                var score = _calcularScore(entrada, terminos, modo);
                if (score > 0) resultados.push({ id: id, score: score });
            });
        } else {
            var indiceTerminos = _obtenerIndiceTerminos(indice);
            var candidatos = null;
            for (var t = 0; t < terminos.length; t++) {
                var porTermino = _obtenerCandidatosTermino(indiceTerminos, terminos[t], modo);
                if (!porTermino.size) return resultados;

                if (!candidatos) {
                    candidatos = porTermino;
                } else {
                    candidatos.forEach(function (id) {
                        if (!porTermino.has(id)) candidatos.delete(id);
                    });
                    if (!candidatos.size) return resultados;
                }
            }

            candidatos.forEach(function (id) {
                var entrada = indice.get(id);
                if (!entrada) return;
                var score = _calcularScore(entrada, terminos, modo);
                if (score > 0) resultados.push({ id: id, score: score });
            });
        }

        resultados.sort(function (a, b) {
            var diferencia = b.score - a.score;
            if (diferencia || modo === 'fuzzy') return diferencia;
            return indiceTerminos.ordenIds.get(a.id) - indiceTerminos.ordenIds.get(b.id);
        });
        return resultados;
    };

    function _calcularScore(entrada, terminos, modo) {
        var scoreTotal = 0;

        for (var t = 0; t < terminos.length; t++) {
            var termRaw  = terminos[t].raw;
            var termStem = terminos[t].stem;
            var scoreTermino = 0;

            if (modo === 'exacta') {
                // Solo coincidencia exacta de raw
                var encontradoExacto = entrada.tokensRaw
                    ? entrada.tokensRaw.has(termRaw)
                    : entrada.tokens.some(function (tk) { return tk.raw === termRaw; });
                if (!encontradoExacto) return 0; // AND estricto
                scoreTermino = CFG.scoreExactoBonus +
                    (entrada.frecuencia.get(termStem) || 0);

            } else {
                // Buscar coincidencia en tokens: exacta > prefijo > stem > fuzzy
                var mejorMatch = 0;
                var tokens = entrada.tokens;

                for (var k = 0; k < tokens.length; k++) {
                    var tkRaw  = tokens[k].raw;
                    var tkStem = tokens[k].stem;
                    var matchLocal = 0;

                    if (tkRaw === termRaw) {
                        matchLocal = CFG.scoreExactoBonus + (entrada.frecuencia.get(tkStem) || 0);
                    } else if (tkRaw.indexOf(termRaw) === 0 || termRaw.indexOf(tkRaw) === 0) {
                        matchLocal = CFG.scorePrefixBonus + (entrada.frecuencia.get(tkStem) || 0);
                    } else if (tkRaw.indexOf(termRaw) !== -1) {
                        matchLocal = 3 + (entrada.frecuencia.get(tkStem) || 0);
                    } else if (tkStem && termStem && tkStem === termStem) {
                        matchLocal = 4 + (entrada.frecuencia.get(tkStem) || 0);
                    } else if (modo === 'fuzzy' &&
                               termRaw.length >= CFG.fuzzyMinLongitud &&
                               tkRaw.length   >= CFG.fuzzyMinLongitud) {
                        var dist = _levenshtein(termRaw, tkRaw);
                        if (dist <= CFG.fuzzyMaxDistancia) {
                            matchLocal = Math.max(1, CFG.fuzzyMaxDistancia + 1 - dist);
                        }
                    }

                    if (matchLocal > mejorMatch) mejorMatch = matchLocal;
                }

                if (mejorMatch === 0) {
                    // Si modo normal, el término no matchea → excluir (AND implícito)
                    if (modo !== 'fuzzy') return 0;
                    // En fuzzy, permitimos que falte un término con penalización
                    scoreTotal -= 1;
                    continue;
                }
                scoreTermino = mejorMatch;
            }

            scoreTotal += scoreTermino;
        }

        return scoreTotal;
    }

    // ============================================================
    // SISTEMA DE FILTROS ACTIVOS
    // Filtros se combinan en AND con la búsqueda textual
    // ============================================================

    VP.busqueda.establecerFiltro = function (campo, valor) {
        if (valor === null || valor === undefined || valor === '') {
            delete _estado.filtrosActivos[campo];
        } else {
            _estado.filtrosActivos[campo] = valor;
        }
        _estado.ultimaQuery = null; // forzar re-búsqueda
        _emitirEvento('filtrosCambiados', { filtros: _estado.filtrosActivos });
    };

    VP.busqueda.limpiarFiltros = function () {
        _estado.filtrosActivos = {};
        _estado.ultimaQuery    = null;
        _emitirEvento('filtrosLimpiados', {});
    };

    VP.busqueda.obtenerFiltros = function () {
        return Object.assign({}, _estado.filtrosActivos);
    };

    function _pasaFiltros(metadatos) {
        var filtros = _estado.filtrosActivos;
        if (!metadatos) return true;

        if (filtros.ext && metadatos.ext !== filtros.ext) return false;

        if (filtros.categoria &&
            metadatos.categoria &&
            metadatos.categoria.toLowerCase() !== filtros.categoria.toLowerCase())
            return false;

        if (filtros.duracionMin !== undefined &&
            metadatos.duracion < filtros.duracionMin) return false;

        if (filtros.duracionMax !== undefined &&
            metadatos.duracion > filtros.duracionMax) return false;

        if (filtros.fechaDesde && metadatos.fecha &&
            metadatos.fecha < filtros.fechaDesde) return false;

        if (filtros.fechaHasta && metadatos.fecha &&
            metadatos.fecha > filtros.fechaHasta) return false;

        return true;
    }

    // ============================================================
    // AUTOCOMPLETADO / SUGERENCIAS
    // ============================================================

    function _obtenerIndicePrefijos(corpus) {
        if (_cacheIndicePrefijos && _cacheIndicePrefijos.corpus === corpus &&
                _cacheIndicePrefijos.size === corpus.size) {
            return _cacheIndicePrefijos.indice;
        }

        var indice = new Map();
        corpus.forEach(function (termino) {
            var prefijo = termino.slice(0, 2);
            var grupo = indice.get(prefijo);
            if (!grupo) {
                grupo = [];
                indice.set(prefijo, grupo);
            }
            grupo.push(termino);
        });

        _cacheIndicePrefijos = {
            corpus: corpus,
            size: corpus.size,
            indice: indice,
        };
        return indice;
    }

    VP.busqueda._generarSugerencias = function (queryParcial) {
        var sugerencias = [];
        if (!queryParcial || queryParcial.length < CFG.sugerenciasMinChars) return sugerencias;

        var prefix = queryParcial.toLowerCase().trim();
        var corpus = _estado.corpusTerminos;
        if (!corpus) return sugerencias;

        // 1. Buscar primero en el grupo de términos con el mismo prefijo corto.
        var candidatos = prefix.length >= 2
            ? _obtenerIndicePrefijos(corpus).get(prefix.slice(0, 2)) || []
            : corpus;
        var agregarCandidato = function (termino) {
            if (termino.indexOf(prefix) === 0 && termino !== prefix) {
                sugerencias.push({ texto: termino, tipo: 'corpus', score: 10 });
            }
        };
        if (Array.isArray(candidatos)) {
            for (var c = 0; c < candidatos.length; c++) agregarCandidato(candidatos[c]);
        } else {
            candidatos.forEach(agregarCandidato);
        }

        // 2. Historial que contiene el prefijo
        var historial = _estado.historial;
        for (var i = 0; i < historial.length && i < CFG.historialMaxItems; i++) {
            if (historial[i].toLowerCase().indexOf(prefix) !== -1) {
                sugerencias.push({ texto: historial[i], tipo: 'historial', score: 8 + (historial.length - i) });
            }
        }

        // Ordenar, deduplicar y recortar
        sugerencias.sort(function (a, b) { return b.score - a.score; });
        var vistos = new Set();
        var filtradas = [];
        for (var j = 0; j < sugerencias.length; j++) {
            var clave = sugerencias[j].texto.toLowerCase();
            if (!vistos.has(clave)) {
                vistos.add(clave);
                filtradas.push(sugerencias[j]);
                if (filtradas.length >= CFG.sugerenciasMax) break;
            }
        }

        return filtradas;
    };

    // ============================================================
    // RESALTADO DE TÉRMINOS EN TEXTO
    // ============================================================

    VP.busqueda.resaltarTexto = function (texto, query) {
        texto = String(texto == null ? '' : texto);
        if (!query) return _escapeHtml(texto);
        var terminos = _tokenizar(query).map(function (t) { return t.raw; });
        if (!terminos.length) return _escapeHtml(texto);

        // Escapar para RegExp
        var patron = terminos
            .map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); })
            .join('|');

        try {
            var re = new RegExp('(' + patron + ')', 'gi');
            var resultado = '';
            var cursor = 0;
            var match;
            while ((match = re.exec(texto))) {
                resultado += _escapeHtml(texto.slice(cursor, match.index));
                resultado += '<mark class="' + CFG.highlightClass + '">' +
                    _escapeHtml(match[0]) + '</mark>';
                cursor = re.lastIndex;
            }
            return resultado + _escapeHtml(texto.slice(cursor));
        } catch (e) {
            return _escapeHtml(texto);
        }
    };

    // Aplicar resaltado a un elemento DOM
    VP.busqueda._aplicarHighlightDom = function (el, query) {
        if (!el) return;
        var textoNodes = [];
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var nodo;
        while ((nodo = walker.nextNode())) {
            textoNodes.push(nodo);
        }

        for (var i = 0; i < textoNodes.length; i++) {
            var tn = textoNodes[i];
            var parent = tn.parentNode;
            if (!parent || parent.nodeName === 'SCRIPT' || parent.nodeName === 'STYLE') continue;
            var resaltado = VP.busqueda.resaltarTexto(tn.textContent, query);
            if (resaltado.indexOf('<mark ') !== -1) {
                var span = document.createElement('span');
                span.innerHTML = resaltado;
                parent.replaceChild(span, tn);
            }
        }
    };

    // Quitar resaltado previo del DOM
    VP.busqueda._limpiarHighlightDom = function (contenedor) {
        if (!contenedor) return;
        var marks = contenedor.querySelectorAll('.' + CFG.highlightClass);
        for (var i = 0; i < marks.length; i++) {
            var mark = marks[i];
            var parent = mark.parentNode;
            if (parent) {
                parent.replaceChild(
                    document.createTextNode(mark.textContent), mark
                );
                parent.normalize();
            }
        }
    };

    // ============================================================
    // PAGINACIÓN
    // ============================================================

    VP.busqueda.establecerPagina = function (num) {
        _estado.paginaActual = Math.max(0, num);
        if (_estado.ultimaQuery !== null) {
            VP.busqueda.ejecutarBusqueda(_estado.ultimaQuery, true);
        }
    };

    VP.busqueda.paginaSiguiente = function () {
        VP.busqueda.establecerPagina(_estado.paginaActual + 1);
    };

    VP.busqueda.paginaAnterior = function () {
        VP.busqueda.establecerPagina(Math.max(0, _estado.paginaActual - 1));
    };

    function _paginadoResultados(resultados) {
        if (!CFG.paginacionActiva) return resultados;
        var inicio = _estado.paginaActual * CFG.itemsPorPagina;
        return resultados.slice(inicio, inicio + CFG.itemsPorPagina);
    }

    // ============================================================
    // RENDERIZAR PLAYLIST FILTRADA POR BÚSQUEDA
    // ============================================================

    function _renderizarPlaylistFiltrada(playlistIds, query) {
        if (!VP.refs.playlistEl || !VP.listas ||
                typeof VP.listas.renderizarPlaylistFiltrada !== 'function') return;

        var playlistCompleta = Array.isArray(VP.estado.playlist) ? VP.estado.playlist : [];
        var mapaPorId = Object.create(null);
        for (var i = 0; i < playlistCompleta.length; i++) {
            var video = playlistCompleta[i];
            if (video && video.id != null) mapaPorId[String(video.id)] = i;
        }

        var videosFiltrados = [];
        var indicesOriginales = [];
        var idsOrdenados = Array.isArray(playlistIds) ? playlistIds : [];
        for (var j = 0; j < idsOrdenados.length; j++) {
            var id = String(idsOrdenados[j].id);
            if (!Object.prototype.hasOwnProperty.call(mapaPorId, id)) continue;
            var idx = mapaPorId[id];
            videosFiltrados.push(playlistCompleta[idx]);
            indicesOriginales.push(idx);
        }

        VP.listas.renderizarPlaylistFiltrada(videosFiltrados, indicesOriginales, query);
    }

    function _actualizarMensajeVacioPlaylist(query, cantidadResultados) {
        var empty = VP.refs.playlistEmpty;
        var mensaje = empty && empty.querySelector('p');
        if (!mensaje) return;

        if (!mensaje.hasAttribute('data-vp-mensaje-original')) {
            mensaje.setAttribute('data-vp-mensaje-original', mensaje.textContent || '');
        }
        mensaje.textContent = query && !cantidadResultados
            ? 'No se encontraron videos para esta búsqueda.'
            : mensaje.getAttribute('data-vp-mensaje-original');
    }

    // ============================================================
    // APLICAR RESULTADOS AL DOM
    // ============================================================

    function _aplicarResultadosBusqueda(resultados, query) {
        var galleryEl  = VP.refs.galleryEl;
        var playlistEl = VP.refs.playlistEl;
        var galeriaIds  = resultados.galeriaIds;
        var playlistIds = resultados.playlistIds;

        // La caja de búsqueda pertenece a la playlist; la galería conserva su colección completa.
        if (galleryEl) {
            VP.busqueda._limpiarHighlightDom(galleryEl);

            var itemsGal = galleryEl.querySelectorAll('.gallery-item');
            for (var g = 0; g < itemsGal.length; g++) {
                var el = itemsGal[g];
                el.style.order = '';
                if (CFG.animacionBusqueda) {
                    el.style.display = '';
                    el.classList.remove('vp-hidden-search');
                } else {
                    el.style.display = '';
                }
            }
        }

        // ── Playlist — Re-renderizar con resultados filtrados ────
        // Cuando hay búsqueda, re-renderizamos la playlist con solo
        // los items que coinciden para evitar problemas con virtualización
        if (playlistEl && query) {
            _renderizarPlaylistFiltrada(playlistIds, query);
        } else if (playlistEl && !_estado._aplicandoResultados) {
            // Sin búsqueda: re-renderizar playlist completa (solo si no estamos ya aplicando resultados)
            _estado._aplicandoResultados = true;
            try {
                if (VP.listas && typeof VP.listas.renderizarPlaylist === 'function') {
                    VP.listas.renderizarPlaylist();
                }
            } finally {
                _estado._aplicandoResultados = false;
            }
        }

        _actualizarMensajeVacioPlaylist(query, playlistIds ? playlistIds.length : 0);

        // ── Estado vacío ─────────────────────────────────────────
        var sinResults = VP.refs.searchEmpty;
        if (sinResults) {
            var hayRes = !query ||
                (galeriaIds  && galeriaIds.length  > 0) ||
                (playlistIds && playlistIds.length > 0);
            sinResults.style.display = (query && !hayRes) ? 'flex' : 'none';
        }

        // ── Paginación UI ─────────────────────────────────────────
        _actualizarPaginacionUI(resultados);
    }

    function _actualizarPaginacionUI(resultados) {
        if (!CFG.paginacionActiva) return;
        var totalGaleria  = resultados.galeriaIds  ? resultados.galeriaIds.length  : 0;
        var totalPlaylist = resultados.playlistIds ? resultados.playlistIds.length : 0;
        var total         = Math.max(totalGaleria, totalPlaylist);
        var totalPaginas  = Math.ceil(total / CFG.itemsPorPagina);

        _emitirEvento('paginacionActualizada', {
            pagina       : _estado.paginaActual,
            totalPaginas : totalPaginas,
            totalItems   : total,
        });
        _emitirInterno('paginacionActualizada', {
            pagina: _estado.paginaActual, totalPaginas: totalPaginas,
        });
    }

    // ============================================================
    // MODO DE BÚSQUEDA
    // ============================================================

    VP.busqueda.establecerModo = function (modo) {
        var modos = ['normal', 'fuzzy', 'exacta'];
        if (modos.indexOf(modo) === -1) {
            log.warn('Modo desconocido:', modo, '— usando normal');
            modo = 'normal';
        }
        _estado.modoActual = modo;
        _estado.ultimaQuery = null; // forzar re-búsqueda
        _emitirEvento('modoActualizado', { modo: modo });
    };

    VP.busqueda.obtenerModo = function () {
        return _estado.modoActual;
    };

    // ============================================================
    // SERIALIZACIÓN DEL ÍNDICE
    // Útil para pre-construirlo en servidor y restaurarlo en cliente
    // ============================================================

    VP.busqueda.serializarIndice = function (tipo) {
        var indice = tipo === 'playlist' ? _estado.indicePlaylist : _estado.indiceGaleria;
        if (!indice) return null;

        var obj = {};
        indice.forEach(function (entrada, id) {
            var frecObj = {};
            entrada.frecuencia.forEach(function (val, key) { frecObj[key] = val; });
            obj[id] = {
                tokens    : entrada.tokens,
                metadatos : entrada.metadatos,
                frecuencia: frecObj,
            };
        });
        return JSON.stringify(obj);
    };

    VP.busqueda.restaurarIndice = function (serializado, tipo) {
        if (!serializado) return false;
        try {
            var obj    = JSON.parse(serializado);
            var indice = new Map();
            Object.keys(obj).forEach(function (id) {
                var e   = obj[id];
                var fMap = new Map();
                Object.keys(e.frecuencia).forEach(function (k) {
                    fMap.set(k, e.frecuencia[k]);
                });
                indice.set(id, {
                    tokens    : e.tokens,
                    metadatos : e.metadatos,
                    frecuencia: fMap,
                });
            });

            if (tipo === 'playlist') {
                _estado.indicePlaylist = indice;
            } else {
                _estado.indiceGaleria  = indice;
            }
            log.info('Índice restaurado (' + tipo + '):', indice.size, 'entradas.');
            return true;
        } catch (e) {
            log.error('Error restaurando índice:', e);
            return false;
        }
    };

    // ============================================================
    // INVALIDAR ÍNDICES
    // ============================================================

    VP.busqueda._invalidarIndices = function () {
        _estado.indiceGaleria   = null;
        _estado.indicePlaylist  = null;
        _estado.corpusTerminos  = null;
        // NO borrar ultimaQuery para mantener el estado de búsqueda activo
        // _estado.ultimaQuery     = null;
        _estado.ultimosResultados = null;
        _estado.paginaActual    = 0;
        if (_estado.cacheLRU) _estado.cacheLRU.invalidar();
        log.debug('Índices invalidados.');
        _emitirEvento('indicesInvalidados', {});
    };

    // ============================================================
    // ANALYTICS
    // ============================================================

    function _registrarAnalytics(query, numResultados) {
        var a = _estado.analytics;
        a.totalBusquedas++;
        if (numResultados > 0) {
            a.exitosas++;
        } else if (query) {
            a.fallidas++;
        }
        if (query) {
            a.queriesTop[query] = (a.queriesTop[query] || 0) + 1;
        }
    }

    VP.busqueda.obtenerAnalytics = function () {
        var a      = _estado.analytics;
        var top    = Object.keys(a.queriesTop)
            .sort(function (x, y) { return a.queriesTop[y] - a.queriesTop[x]; })
            .slice(0, 10)
            .map(function (q) { return { query: q, count: a.queriesTop[q] }; });

        return {
            totalBusquedas : a.totalBusquedas,
            exitosas        : a.exitosas,
            fallidas        : a.fallidas,
            tasaExito       : a.totalBusquedas
                ? ((a.exitosas / a.totalBusquedas) * 100).toFixed(1) + '%'
                : '0%',
            queriesTop      : top,
            cacheSize       : _estado.cacheLRU ? _estado.cacheLRU.size() : 0,
            historialSize   : _estado.historial.length,
        };
    };

    VP.busqueda.reiniciarAnalytics = function () {
        _estado.analytics = {
            totalBusquedas : 0,
            exitosas        : 0,
            fallidas        : 0,
            queriesTop      : {},
        };
    };

    // ============================================================
    // EJECUTAR BÚSQUEDA (método principal)
    // ============================================================

    VP.busqueda.ejecutarBusqueda = function (q, forzar) {
        var query = String(q == null ? '' : q).toLowerCase().trim();

        // ── Caché ────────────────────────────────────────────────
        if (!forzar && query === _estado.ultimaQuery &&
            _estado.ultimosResultados) {
            _aplicarResultadosBusqueda(_estado.ultimosResultados, query);
            return _estado.ultimosResultados;
        }

        // ── LRU + filtros ─────────────────────────────────────────
        var claveCache = query + '|' + JSON.stringify(_estado.filtrosActivos) +
                         '|' + _estado.modoActual + '|' + _estado.paginaActual;
        if (!forzar && _estado.cacheLRU) {
            var cached = _estado.cacheLRU.get(claveCache);
            if (cached) {
                _estado.ultimaQuery        = query;
                _estado.ultimosResultados  = cached;
                _aplicarResultadosBusqueda(cached, query);
                return cached;
            }
        }

        _estado.ultimaQuery = query;

        // ── Construir índices si faltan ───────────────────────────
        if (!_estado.indiceGaleria || !_estado.corpusTerminos) {
            var resGal = VP.busqueda._construirIndice(VP.estado.videos || []);
            _estado.indiceGaleria  = resGal.indice;
            _estado.corpusTerminos = resGal.corpus;
        }

        if (!_estado.indicePlaylist) {
            var resPL = VP.busqueda._construirIndice(VP.estado.playlist || []);
            _estado.indicePlaylist = resPL.indice;
            // Fusionar corpus
            resPL.corpus.forEach(function (t) { _estado.corpusTerminos.add(t); });
        }

        // ── Buscar ────────────────────────────────────────────────
        var rawGaleria  = query
            ? VP.busqueda._buscarEnIndice(_estado.indiceGaleria,  query)
            : null;
        var rawPlaylist = query
            ? VP.busqueda._buscarEnIndice(_estado.indicePlaylist, query)
            : null;

        // Si no hay coincidencias exactas, probar tolerancia a errores de escritura.
        if (query && _estado.modoActual === 'normal' && query.length >= CFG.fuzzyMinLongitud) {
            if (rawGaleria && rawGaleria.length === 0) {
                rawGaleria = VP.busqueda._buscarEnIndice(_estado.indiceGaleria, query, 'fuzzy');
            }
            if (rawPlaylist && rawPlaylist.length === 0) {
                rawPlaylist = VP.busqueda._buscarEnIndice(_estado.indicePlaylist, query, 'fuzzy');
            }
        }

        // ── Aplicar filtros sobre metadatos ───────────────────────
        var hayFiltros = Object.keys(_estado.filtrosActivos).length > 0;

        if (hayFiltros && rawGaleria) {
            rawGaleria = rawGaleria.filter(function (r) {
                var entrada = _estado.indiceGaleria.get(r.id);
                return entrada && _pasaFiltros(entrada.metadatos);
            });
        }
        if (hayFiltros && rawPlaylist) {
            rawPlaylist = rawPlaylist.filter(function (r) {
                var entrada = _estado.indicePlaylist.get(r.id);
                return entrada && _pasaFiltros(entrada.metadatos);
            });
        }

        // ── Paginación ────────────────────────────────────────────
        var galeriaIdsPaginados  = rawGaleria  ? _paginadoResultados(rawGaleria)  : null;
        var playlistIdsPaginados = rawPlaylist ? _paginadoResultados(rawPlaylist) : null;

        var resultados = {
            galeriaIds    : galeriaIdsPaginados,
            playlistIds   : playlistIdsPaginados,
            totalGaleria  : rawGaleria  ? rawGaleria.length  : 0,
            totalPlaylist : rawPlaylist ? rawPlaylist.length : 0,
        };

        _estado.ultimosResultados = resultados;

        // ── Guardar en LRU ────────────────────────────────────────
        if (_estado.cacheLRU) {
            _estado.cacheLRU.set(claveCache, resultados);
        }

        // ── Historial + analytics ─────────────────────────────────
        if (query && query.length >= 2) {
            _guardarHistorial(query);
        }
        _registrarAnalytics(query, resultados.totalGaleria + resultados.totalPlaylist);

        // ── Aplicar al DOM ────────────────────────────────────────
        _aplicarResultadosBusqueda(resultados, query);

        // ── Emitir evento ─────────────────────────────────────────
        _emitirEvento('busquedaRealizada', {
            query         : query,
            totalGaleria  : resultados.totalGaleria,
            totalPlaylist : resultados.totalPlaylist,
            modo          : _estado.modoActual,
        });
        _emitirInterno('busquedaRealizada', resultados);

        return resultados;
    };

    // ============================================================
    // BÚSQUEDA PROGRAMÁTICA (sin afectar el input UI)
    // ============================================================

    VP.busqueda.buscarProgramaticamente = function (query, opciones) {
        var opts = opciones || {};
        var modoOriginal = _estado.modoActual;

        if (opts.modo) VP.busqueda.establecerModo(opts.modo);
        if (opts.filtros) {
            Object.keys(opts.filtros).forEach(function (k) {
                VP.busqueda.establecerFiltro(k, opts.filtros[k]);
            });
        }

        var res = VP.busqueda.ejecutarBusqueda(query, true);
        if (opts.modo) VP.busqueda.establecerModo(modoOriginal);

        return res;
    };

    // ============================================================
    // INTERFAZ DE SUGERENCIAS DOM (autocomplete dropdown)
    // ============================================================

    function _crearContenedorSugerencias(input) {
        var contenedor = document.createElement('ul');
        contenedor.className  = 'vp-sugerencias';

        var wrapper = input.parentNode;
        if (wrapper && wrapper.style) {
            wrapper.style.position = 'relative';
        }
        if (wrapper) wrapper.appendChild(contenedor);
        return contenedor;
    }

    function _mostrarSugerencias(input, contenedor, sugerencias) {
        contenedor.innerHTML = '';
        _estado.sugerenciasIdxActivo = -1;

        // Una búsqueda retrasada no debe reabrir el menú tras blur/Escape.
        if (!input || document.activeElement !== input ||
                !sugerencias || !sugerencias.length) {
            _ocultarSugerencias(contenedor);
            return;
        }

        for (var i = 0; i < sugerencias.length; i++) {
            (function (sug, idx) {
                var li   = document.createElement('li');
                var icono = sug.tipo === 'historial' ? '🕒' : '🔍';
                li.innerHTML = icono + ' ' + _escapeHtml(sug.texto);
                li.dataset.valor = sug.texto;

                li.addEventListener('mousedown', function (e) {
                    e.preventDefault(); // evitar blur en input
                    _estado.sugerenciasDescartadas = true;
                    input.value = sug.texto;
                    _ocultarSugerencias(contenedor);
                    VP.busqueda.ejecutarBusqueda(sug.texto);
                });
                li.addEventListener('mouseover', function () {
                    _activarSugerencia(contenedor, idx);
                });

                contenedor.appendChild(li);
            })(sugerencias[i], i);
        }

        contenedor.style.display = 'block';
        _estado.sugerenciasVisible = true;
    }

    function _ocultarSugerencias(contenedor) {
        if (contenedor) contenedor.style.display = 'none';
        _estado.sugerenciasVisible  = false;
        _estado.sugerenciasIdxActivo = -1;
    }

    function _activarSugerencia(contenedor, idx) {
        var items = contenedor.querySelectorAll('li');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active', i === idx);
        }
        _estado.sugerenciasIdxActivo = idx;
    }

    function _escapeHtml(texto) {
        return texto
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ============================================================
    // INICIALIZAR BÚSQUEDA
    // ============================================================

    VP.busqueda.inicializarBusqueda = function () {
        var input = VP.refs.searchInput;
        if (!input) {
            log.debug('inicializarBusqueda: searchInput no encontrado.');
            return;
        }

        // Iniciar caché LRU
        _estado.cacheLRU = _crearCacheLRU(CFG.cacheMaxEntradas, CFG.cacheTTL);

        // Cargar historial desde almacenamiento
        _cargarHistorial();

        // Contenedor de sugerencias
        var contenedorSug = _crearContenedorSugerencias(input);
        _estado.sugerenciasDescartadas = false;

        // Debounce de búsqueda principal
        var fnBuscar = util.debounce(function () {
            var val = input.value || '';
            _estado.paginaActual = 0;
            VP.busqueda.ejecutarBusqueda(val);

            // Actualizar sugerencias
            if (!_estado.sugerenciasDescartadas && document.activeElement === input &&
                    val.trim().length >= CFG.sugerenciasMinChars) {
                var sugs = VP.busqueda._generarSugerencias(val);
                _mostrarSugerencias(input, contenedorSug, sugs);
            } else {
                _ocultarSugerencias(contenedorSug);
            }
        }, CFG.debounce);

        input.addEventListener('input',  fnBuscar);
        input.addEventListener('search', fnBuscar);

        input.addEventListener('focus', function () {
            _estado.sugerenciasDescartadas = false;
            if (input.value.length >= CFG.sugerenciasMinChars) {
                var sugs = VP.busqueda._generarSugerencias(input.value);
                _mostrarSugerencias(input, contenedorSug, sugs);
            } else {
                _ocultarSugerencias(contenedorSug);
            }
        });

        input.addEventListener('blur', function () {
            // Pequeño delay para permitir mousedown en sugerencia
            setTimeout(function () {
                if (document.activeElement !== input) {
                    _estado.sugerenciasDescartadas = true;
                    _ocultarSugerencias(contenedorSug);
                }
            }, 150);
        });

        input.addEventListener('input', function () {
            _estado.sugerenciasDescartadas = false;
        });

        // Navegación por teclado en sugerencias
        input.addEventListener('keydown', function (e) {
            var items = contenedorSug.querySelectorAll('li');

            if (e.key === 'Escape') {
                _estado.sugerenciasDescartadas = true;
                if (_estado.sugerenciasVisible) {
                    _ocultarSugerencias(contenedorSug);
                } else {
                    input.value = '';
                    VP.busqueda.ejecutarBusqueda('');
                    _ocultarSugerencias(contenedorSug);
                }
                return;
            }

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                var siguiente = Math.min(
                    _estado.sugerenciasIdxActivo + 1, items.length - 1
                );
                _activarSugerencia(contenedorSug, siguiente);
                return;
            }

            if (e.key === 'ArrowUp') {
                e.preventDefault();
                var anterior = Math.max(_estado.sugerenciasIdxActivo - 1, 0);
                _activarSugerencia(contenedorSug, anterior);
                return;
            }

            if (e.key === 'Enter' && _estado.sugerenciasIdxActivo >= 0) {
                var seleccionado = items[_estado.sugerenciasIdxActivo];
                if (seleccionado) {
                    input.value = seleccionado.dataset.valor;
                    _ocultarSugerencias(contenedorSug);
                    VP.busqueda.ejecutarBusqueda(input.value);
                    e.preventDefault();
                }
                return;
            }

            // Atajo global: Ctrl+K / Cmd+K → enfocar input
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                input.focus();
                input.select();
            }
        });

        // Atajo global en documento
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                if (input) { input.focus(); input.select(); }
            }
        });

        // Botón limpiar
        var btnLimpiar = VP.refs.searchClearBtn;
        if (btnLimpiar) {
            btnLimpiar.addEventListener('click', function () {
                _estado.sugerenciasDescartadas = true;
                if (fnBuscar.cancelar) fnBuscar.cancelar();
                input.value = '';
                VP.busqueda.ejecutarBusqueda('');
                _ocultarSugerencias(contenedorSug);
                input.focus();
            });
        }

        // Selector de modo (si existe en DOM)
        var selectorModo = document.querySelector('[data-vp-search-mode]');
        if (selectorModo) {
            selectorModo.addEventListener('change', function () {
                VP.busqueda.establecerModo(selectorModo.value);
                if (input.value) VP.busqueda.ejecutarBusqueda(input.value, true);
            });
        }

        log.info('Búsqueda inicializada — modo:', _estado.modoActual);
        _emitirEvento('inicializado', { modo: _estado.modoActual });
    };

    // ============================================================
    // OBTENER ESTADO COMPLETO (diagnóstico / métricas)
    // ============================================================

    VP.busqueda.obtenerEstado = function () {
        return {
            indiceGaleriaSize   : _estado.indiceGaleria
                ? _estado.indiceGaleria.size  : 0,
            indicePlaylistSize  : _estado.indicePlaylist
                ? _estado.indicePlaylist.size : 0,
            corpusSize          : _estado.corpusTerminos
                ? _estado.corpusTerminos.size : 0,
            ultimaQuery         : _estado.ultimaQuery,
            tieneCache          : _estado.cacheLRU && _estado.cacheLRU.size() > 0,
            cacheTamaño         : _estado.cacheLRU ? _estado.cacheLRU.size() : 0,
            modoActual          : _estado.modoActual,
            filtrosActivos      : Object.assign({}, _estado.filtrosActivos),
            historialItems      : _estado.historial.length,
            paginaActual        : _estado.paginaActual,
            analytics           : VP.busqueda.obtenerAnalytics(),
        };
    };

    // ============================================================
    // UTILIDADES EXTRA
    // ============================================================

    // Obtener los términos más frecuentes del corpus (top N)
    VP.busqueda.obtenerTerminosFrecuentes = function (n) {
        n = n || 10;
        var frecMap = new Map();
        var indice  = _estado.indiceGaleria;
        if (!indice) return [];

        indice.forEach(function (entrada) {
            entrada.frecuencia.forEach(function (freq, stem) {
                frecMap.set(stem, (frecMap.get(stem) || 0) + freq);
            });
        });

        var arr = [];
        frecMap.forEach(function (freq, stem) { arr.push({ termino: stem, freq: freq }); });
        arr.sort(function (a, b) { return b.freq - a.freq; });
        return arr.slice(0, n);
    };

    // Buscar videos relacionados con uno dado (por similitud de tokens)
    VP.busqueda.obtenerRelacionados = function (videoId, n) {
        n = n || 6;
        var entradaBase = _estado.indiceGaleria
            ? _estado.indiceGaleria.get(String(videoId))
            : null;
        if (!entradaBase) return [];

        var tokensFrecuentes = [];
        entradaBase.frecuencia.forEach(function (freq, stem) {
            if (freq > 0) tokensFrecuentes.push(stem);
        });
        tokensFrecuentes.sort(function (a, b) {
            return (entradaBase.frecuencia.get(b) || 0) -
                   (entradaBase.frecuencia.get(a) || 0);
        });

        var queryRelacionada = tokensFrecuentes.slice(0, 3).join(' ');
        if (!queryRelacionada) return [];

        var resultados = VP.busqueda._buscarEnIndice(
            _estado.indiceGaleria, queryRelacionada
        );

        return resultados
            .filter(function (r) { return r.id !== String(videoId); })
            .slice(0, n)
            .map(function (r) { return r.id; });
    };

    // Exportar corpus como array ordenado (útil para autocomplete externo)
    VP.busqueda.exportarCorpus = function () {
        if (!_estado.corpusTerminos) return [];
        var arr = Array.from(_estado.corpusTerminos);
        arr.sort();
        return arr;
    };

    // Restablecer todo el módulo a estado inicial
    VP.busqueda.reiniciar = function () {
        VP.busqueda._invalidarIndices();
        VP.busqueda.limpiarFiltros();
        VP.busqueda.reiniciarAnalytics();
        _estado.modoActual            = CFG.modoDefecto;
        _estado.paginaActual          = 0;
        _estado.sugerenciasVisible    = false;
        _estado.sugerenciasIdxActivo  = -1;
        log.info('Módulo de búsqueda reiniciado.');
        _emitirEvento('reiniciado', {});
    };

    // ============================================================
    // VERIFICACIÓN DEL MÓDULO
    // ============================================================

    (function _verificarModulo() {
        var REQUERIDAS = [
            'inicializarBusqueda',    'ejecutarBusqueda',
            '_construirIndice',       '_buscarEnIndice',
            '_invalidarIndices',      'obtenerEstado',
            '_generarSugerencias',    'resaltarTexto',
            '_aplicarHighlightDom',   '_limpiarHighlightDom',
            'establecerFiltro',       'limpiarFiltros',
            'obtenerFiltros',         'establecerModo',
            'obtenerModo',            'serializarIndice',
            'restaurarIndice',        'obtenerHistorial',
            'limpiarHistorial',       'eliminarEntradaHistorial',
            'obtenerAnalytics',       'reiniciarAnalytics',
            'buscarProgramaticamente','obtenerRelacionados',
            'obtenerTerminosFrecuentes','exportarCorpus',
            'establecerPagina',       'paginaSiguiente',
            'paginaAnterior',         'reiniciar',
            'on',                     'off',
        ];

        var faltantes = [];
        for (var i = 0; i < REQUERIDAS.length; i++) {
            if (typeof VP.busqueda[REQUERIDAS[i]] !== 'function')
                faltantes.push(REQUERIDAS[i]);
        }

        if (faltantes.length) {
            log.error('vp-busqueda.js: funciones faltantes →', faltantes.join(', '));
        } else {
            log.debug('vp-busqueda.js: verificación ✓ (' +
                REQUERIDAS.length + ' funciones OK)');
        }
    })();

    log.info('vp-busqueda.js v2.0 cargado.');

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-busqueda.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})(window, document);
