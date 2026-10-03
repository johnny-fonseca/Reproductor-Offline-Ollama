/* voz-sano.js — TTS 100% offline con sanoTTS (WASM incrustado en base64).
 *
 * Interfaz: hablar, detener, estaListo, estaHablando (+ precargar, liberar).
 * Voces (es-419): macho = vueltiao, hembra = chande.
 * Carga bajo demanda: con "Voz de Mochi" apagado no se descarga ni decodifica nada.
 *
 * Archivos esperados (generados por convertir-sano.sh) en js/tts-sano/:
 *   snt_voice.js, snt_g2p.js
 *   b64/snt_voice.wasm.js, b64/snt_g2p.wasm.js, b64/snt_g2p.data.js
 *   b64/voz-<clave>.js  (vueltiao, chande, vueltiao-small, chande-small)
 */
(function (global) {
  'use strict';

  var SR = 22050;
  var MAX_IDS = 1024;
  var OUT_CAP = SR * 30;

  var config = {
    variante: 'completa', // 'completa' (mejor calidad) | 'small' (mucho más rápida)
    volumen: 1,
    maxChunk: 120,        // largo máximo por frase al sintetizar; bajar si la UI se congela
    autoLiberarMs: 0      // >0: libera todo tras ese tiempo sin hablar (ej. 120000)
  };

  // Ruta base resuelta desde este mismo script: los runtime y las voces b64 son
  // hermanos de voz-sano.js, dentro de js/tts-sano/.
  var SCRIPT_URL = (document.currentScript && document.currentScript.src) || '';
  var BASE = SCRIPT_URL ? new URL('./', SCRIPT_URL).href : 'js/tts-sano/';

  var V = null, G = null;
  var setVoiceFn = null, g2pIdsFn = null, synthFn = null;
  var vozActual = null;           // {clave, meta, front:{p}, dec:{p}}
  var ctx = null, gain = null;
  var token = 0, hablando = false, cbFin = null;
  var fuentes = new Set();
  var timerLiberar = null;
  var cola = Promise.resolve();
  var glueListo = null;

  // ---------- utilidades de carga ----------

  function cargarScript(url) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { res(s); };
      s.onerror = function () { s.remove(); rej(new Error('No se pudo cargar ' + url)); };
      document.head.appendChild(s);
    });
  }

  function cargarGlue() {
    if (!glueListo) {
      glueListo = Promise.all([
        cargarScript(BASE + 'snt_voice.js'),
        cargarScript(BASE + 'snt_g2p.js')
      ]).catch(function (e) { glueListo = null; throw e; });
    }
    return glueListo;
  }

  function b64ToBytes(b64) {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Carga el script b64 si hace falta, toma el valor y lo borra de window
  async function tomarB64(clave, archivo) {
    var B = global.SANO_B64;
    if (!(B && B[clave])) {
      var s = await cargarScript(BASE + 'b64/' + archivo);
      s.remove();
      B = global.SANO_B64;
    }
    var v = B && B[clave];
    if (!v) throw new Error('Falta ' + clave + ' en ' + archivo);
    delete B[clave];
    return v;
  }

  function widenF16(bytes, dims) {
    var head = Number(dims.meta_bytes), n = Number(dims.weight_floats);
    if (bytes.length !== head + 2 * n) throw new Error('blob f16 de ' + bytes.length + ' bytes, meta indica ' + (head + 2 * n));
    var out = new Uint8Array(head + 4 * n);
    out.set(bytes.subarray(0, head), 0);
    var src = new DataView(bytes.buffer, bytes.byteOffset + head, 2 * n);
    var dst = new DataView(out.buffer, head, 4 * n);
    for (var i = 0; i < n; i++) {
      var b = src.getUint16(i * 2, true);
      var exp = (b >> 10) & 0x1f, frac = b & 0x3ff, sign = (b & 0x8000) ? -1 : 1, v;
      if (exp === 0) v = sign * frac * 5.960464477539063e-8;
      else if (exp === 31) v = frac ? NaN : sign * Infinity;
      else v = sign * Math.pow(2, exp - 25) * (1024 + frac);
      dst.setFloat32(i * 4, v, true);
    }
    return out;
  }

  function pesos(b64, dims, fmt) {
    var bytes = b64ToBytes(b64);
    if (fmt === 'f32') return bytes;
    if (fmt === 'f16') return widenF16(bytes, dims);
    throw new Error('formato de pesos no soportado: ' + fmt);
  }

  function aHeap(bytes) {
    var p = V._malloc(bytes.length);
    V.HEAPU8.set(bytes, p);
    return { p: p, len: bytes.length };
  }

  // ---------- runtime y voz ----------

  async function iniciarRuntime() {
    if (V && G) return;
    await cargarGlue();
    if (typeof global.SaanoVoice !== 'function' || typeof global.SaanoG2P !== 'function') {
      throw new Error('el runtime sanoTTS no está disponible');
    }
    // El glue de emscripten no lee Module.wasmBinary (una variable local del
    // mismo nombre la oculta) y siempre haría fetch del .wasm por red. El punto
    // de entrada soportado para inyectar los bytes ya decodificados es el hook
    // instantiateWasm, que aquí instancia directamente el módulo en memoria.
    function moduloDesdeB64(bytes) {
      var bin = bytes.buffer || bytes;
      return {
        wasmBinary: bin,
        instantiateWasm: function (imports, exito) {
          WebAssembly.instantiate(bin, imports)
            .then(function (r) { exito(r.instance); })
            .catch(function (e) { throw e; });
        },
        locateFile: function (nombre) { return BASE + nombre; },
        print: function () {},
        printErr: function () {}
      };
    }

    var wasmV = b64ToBytes(await tomarB64('snt_voice.wasm', 'snt_voice.wasm.js'));
    var v = await global.SaanoVoice(moduloDesdeB64(wasmV));
    wasmV = null;

    var wasmG = b64ToBytes(await tomarB64('snt_g2p.wasm', 'snt_g2p.wasm.js'));
    var dataG = b64ToBytes(await tomarB64('snt_g2p.data', 'snt_g2p.data.js')).buffer;
    var modG = moduloDesdeB64(wasmG);
    modG.getPreloadedPackage = function () { return dataG; };
    var g = await global.SaanoG2P(modG);
    wasmG = null;
    dataG = null; // el closure ya no retiene el paquete (queda copiado en el FS de WASM)

    setVoiceFn = g.cwrap('snt_g2p_set_voice', 'number', ['string', 'number']);
    g2pIdsFn = g.cwrap('snt_g2p_text_to_ids', 'number', ['number', 'number', 'number']);
    synthFn = v.cwrap('snt_voice_synthesize', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
    V = v; G = g;
  }

  function liberarVoz() {
    if (vozActual && V) {
      try { V._free(vozActual.front.p); V._free(vozActual.dec.p); } catch (e) {}
    }
    vozActual = null;
  }

  async function cargarVoz(clave) {
    if (vozActual && vozActual.clave === clave) return vozActual;
    liberarVoz();
    var k = 'voz:' + clave;
    var o = await tomarB64(k, 'voz-' + clave + '.js');
    var meta = o.meta;
    var fb = pesos(o.front, meta.front_dims, o.fmt); o.front = null;
    var front = aHeap(fb); fb = null;
    var db = pesos(o.dec, meta.dec_dims, o.fmt); o.dec = null;
    var dec = aHeap(db); db = null;
    vozActual = { clave: clave, meta: meta, front: front, dec: dec };
    return vozActual;
  }

  function generoGlobal() {
    try { if (typeof CFG !== 'undefined' && CFG && CFG.genero) return CFG.genero; } catch (e) {}
    return 'macho';
  }

  function claveVoz(genero) {
    var g = genero || generoGlobal();
    var base = /^(h|f)/i.test(String(g)) ? 'chande' : 'vueltiao';
    return config.variante === 'small' ? base + '-small' : base;
  }

  function enCola(fn) {
    var p = cola.then(fn);
    cola = p.catch(function () {});
    return p;
  }

  function precargar(genero) {
    var clave = claveVoz(genero);
    return enCola(async function () {
      await iniciarRuntime();
      await cargarVoz(clave);
      return true;
    });
  }

  // ---------- texto -> audio ----------

  function limpiar(t) {
    return String(t == null ? '' : t)
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
      .replace(/[*_#`~<>|\[\]{}\\\/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Los modelos se entrenaron con frases sueltas: partir en frases (igual que la demo)
  function partir(text) {
    if (!text) return [];
    var MAX = config.maxChunk, MIN = 40;
    var sents = text.match(/[^.!?।。！？]+[.!?।。！？]*\s*/g) || [text];
    for (var i = sents.length - 2; i >= 0; i--) {
      if (/\p{Nd}\.$/u.test(sents[i].trimEnd()) && /^\s*\p{Nd}/u.test(sents[i + 1])) {
        sents[i] = sents[i].trimEnd() + sents[i + 1];
        sents.splice(i + 1, 1);
      }
    }
    var chunks = [];
    for (var s of sents) {
      s = s.trim();
      if (!s) continue;
      while (s.length > MAX) {
        var cut = -1;
        for (var m of s.matchAll(/[,;:、，；：]\s*/g)) {
          var end = m.index + m[0].length;
          if (end >= MIN && end <= MAX) cut = end;
        }
        if (cut < 0) {
          var sp = s.lastIndexOf(' ', MAX);
          cut = sp > MIN ? sp + 1 : MAX;
        }
        chunks.push(s.slice(0, cut).trim());
        s = s.slice(cut).trim();
      }
      if (s) chunks.push(s);
    }
    return chunks;
  }

  function textToIds(text) {
    var nBytes = G.lengthBytesUTF8(text) + 1;
    var textP = G._malloc(nBytes);
    var outP = G._malloc(MAX_IDS * 4);
    try {
      G.stringToUTF8(text, textP, nBytes);
      var n = g2pIdsFn(textP, outP, MAX_IDS);
      if (n <= 0) throw new Error('g2p falló: rc=' + n);
      return Int32Array.from(G.HEAP32.subarray(outP >> 2, (outP >> 2) + n));
    } finally {
      G._free(textP);
      G._free(outP);
    }
  }

  function synthToPcm(voz, ids) {
    var idsBytes = new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength);
    var idsP = V._malloc(idsBytes.length);
    V.HEAPU8.set(idsBytes, idsP);
    var outP = V._malloc(OUT_CAP * 4);
    try {
      var n = synthFn(voz.front.p, voz.dec.p, idsP, ids.length, voz.meta.length_scale, outP, OUT_CAP);
      if (n <= 0) throw new Error('la síntesis falló');
      return V.HEAPF32.slice(outP >> 2, (outP >> 2) + n);
    } finally {
      V._free(idsP);
      V._free(outP);
    }
  }

  // ---------- audio ----------

  function audio() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      ctx = new AC();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
    }
    gain.gain.value = config.volumen;
    return ctx;
  }

  function cerrarHabla() {
    hablando = false;
    var f = cbFin; cbFin = null;
    if (f) { try { f(); } catch (e) { console.warn(e); } }
  }

  function detener() {
    token++;
    fuentes.forEach(function (s) { try { s.stop(); } catch (e) {} });
    fuentes.clear();
    cerrarHabla();
  }

  // ---------- API ----------

  async function hablar(texto, opts) {
    opts = opts || {};
    detener();
    var miToken = token;
    clearTimeout(timerLiberar);

    var chunks = partir(limpiar(texto));
    if (!chunks.length) return false;

    try { await precargar(opts.genero); }
    catch (e) { console.warn('[VozSano] no se pudo cargar la voz:', e); return false; }
    if (miToken !== token) return false;

    var voz = vozActual;
    var c = audio();
    try { if (c.state === 'suspended') await c.resume(); } catch (e) {}
    try {
      if (setVoiceFn(voz.meta.espeak_voice, voz.meta.g2p_voice_slot) !== 0) {
        throw new Error('set_voice(' + voz.meta.espeak_voice + ') falló');
      }
    } catch (e) { console.warn('[VozSano]', e); return false; }

    var t = 0, ultimaFin = null, empezo = false;
    for (var i = 0; i < chunks.length; i++) {
      if (miToken !== token || vozActual !== voz) break;
      var pcm;
      try { pcm = synthToPcm(voz, textToIds(chunks[i])); }
      catch (e) { console.warn('[VozSano] frase omitida:', chunks[i], e); continue; }
      if (miToken !== token) break;

      var buf = c.createBuffer(1, pcm.length, SR);
      buf.copyToChannel(pcm, 0);
      var src = c.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      var inicio = Math.max(t, c.currentTime + 0.03);
      t = inicio + buf.duration;

      fuentes.add(src);
      (function (s) {
        s.addEventListener('ended', function () { fuentes.delete(s); }, { once: true });
      })(src);
      ultimaFin = new Promise(function (r) { src.addEventListener('ended', r, { once: true }); });
      src.start(inicio);

      if (!empezo) {
        empezo = true;
        hablando = true;
        cbFin = opts.alTerminar || null;
        if (opts.alEmpezar) { try { opts.alEmpezar(); } catch (e) { console.warn(e); } }
      }
      // ceder el hilo entre frases: la UI respira y detener() puede actuar
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    if (ultimaFin) await ultimaFin;
    if (miToken === token) {
      cerrarHabla();
      if (config.autoLiberarMs > 0) {
        timerLiberar = setTimeout(function () { if (!hablando) liberar(); }, config.autoLiberarMs);
      }
    }
    return empezo;
  }

  function liberar() {
    detener();
    clearTimeout(timerLiberar);
    return enCola(async function () {
      liberarVoz();
      V = null; G = null;
      setVoiceFn = g2pIdsFn = synthFn = null;
      if (ctx) { try { await ctx.close(); } catch (e) {} ctx = null; gain = null; }
      return true;
    });
  }

  global.VozSano = {
    hablar: hablar,
    detener: detener,
    estaListo: function () { return !!(V && G && vozActual); },
    estaHablando: function () { return hablando; },
    precargar: precargar,
    liberar: liberar,
    config: config
  };
})(typeof window !== 'undefined' ? window : globalThis);
