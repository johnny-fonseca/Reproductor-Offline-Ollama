/* js/vp-galaxia.js
 * ─────────────────────────────────────────────────────────────────
 * Parallax + nebulosas + CRT ambient light.
 * Se engancha al reproductor existente sin tocar ningún otro módulo.
 * Optimizado: menos reflows, interpolación in‑place y degradados más ligeros.
 * ─────────────────────────────────────────────────────────────────
 */
(function GalaxiaAmbient() {
    'use strict';

    /* ══════════════════════════════════════════════
       CONSTANTES
       ══════════════════════════════════════════════ */
    const EDGE_SEG   = 4;
    const SAMPLE_W   = 32;
    const SAMPLE_H   = 18;
    const PARTICLE_COUNT = 24;
    const EXTRACT_MS = 300;
    // Los halos son degradados muy difusos: no necesitan resolución nativa.
    // Resolución interna del canvas = px CSS * RENDER_SCALE (se adapta sola).
    const RENDER_SCALE_MAX = 0.4;
    const RENDER_SCALE_MIN = 0.2;
    let   renderScale      = RENDER_SCALE_MAX;
    const DRAW_BUDGET_MS   = 8;     // si un ciclo de dibujo pasa de esto 3 veces seguidas, baja la resolución
    const LAYERS_PER_TICK  = 2;     // capas que se dibujan por frame (reparte el coste)
    const EDGE_EPS         = 12;    // cambio de color acumulado mínimo para redibujar
    const INT_EPS          = 0.004; // cambio de intensidad mínimo para redibujar
    const RECT_REVALIDATE_MS = 1000;

    /* ══════════════════════════════════════════════
       1. CONSTRUCCIÓN DE LA ESCENA PARALLAX
       ══════════════════════════════════════════════ */
    function buildParallaxScene() {
        if (document.getElementById('pxScene')) return;

        const scene = document.createElement('div');
        scene.className = 'parallax-scene';
        scene.id        = 'pxScene';
        scene.setAttribute('aria-hidden', 'true');
        scene.innerHTML = `
            <div class="bg-layer-0" id="pxL0"></div>
            <div class="bg-layer-1" id="pxL1"></div>
            <div class="bg-layer-2" id="pxL2">
                <div class="nebula nebula-1"></div>
                <div class="nebula nebula-2"></div>
                <div class="nebula nebula-3"></div>
                <div class="nebula nebula-4"></div>
            </div>
            <div class="bg-layer-3" id="pxL3">
                <div class="decor-circle decor-circle-1"></div>
                <div class="decor-circle decor-circle-2"></div>
                <div class="decor-circle decor-circle-3"></div>
                <div class="decor-circle decor-circle-4"></div>
            </div>
            <div class="bg-layer-4" id="pxL4"></div>
            <div class="bg-layer-5" id="pxL5"></div>
        `;
        document.body.insertBefore(scene, document.body.firstChild);
    }

    /* ══════════════════════════════════════════════
       2. PARTÍCULAS
       ══════════════════════════════════════════════ */
    function spawnParticles() {
        const container = document.getElementById('pxL5');
        if (!container || container.dataset.populated) return;
        container.dataset.populated = '1';

        const frag = document.createDocumentFragment();
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const p = document.createElement('div');
            p.className = 'parallax-particle';

            const size = Math.random() * 3 + 1.2;
            const hue  = Math.random() < 0.33 ? 260
                       : Math.random() < 0.5  ? 330 : 200;
            const sat  = 70 + Math.random() * 30;
            const lit  = 60 + Math.random() * 25;
            const dur  = Math.random() * 5 + 3;
            const del  = Math.random() * 6;
            const mop  = Math.random() * 0.5 + 0.25;

            p.style.cssText =
                `width:${size}px;height:${size}px;` +
                `left:${(Math.random()*100).toFixed(1)}%;` +
                `top:${(Math.random()*100).toFixed(1)}%;` +
                `--pdur:${dur}s;--pdel:${del}s;--pmax:${mop};` +
                `background:hsl(${hue},${sat}%,${lit}%);` +
                `box-shadow:0 0 ${(size*4).toFixed(1)}px hsl(${hue},${sat}%,${lit}%)`;
            frag.appendChild(p);
        }
        container.appendChild(frag);
    }

    /* ══════════════════════════════════════════════
       3. PARALLAX CONTROLLER
       ══════════════════════════════════════════════ */
    function createParallax() {
        const IDS    = ['pxL0','pxL1','pxL2','pxL3','pxL4','pxL5'];
        const DEPTHS = [0.8, 1.5, 2.5, 3.8, 5.5, 8.0];
        const MAX_T  = 35;

        const els = IDS.map(id => document.getElementById(id));
        const cur = els.map(() => ({ x:0, y:0 }));
        const tgt = els.map(() => ({ x:0, y:0 }));

        let mx  = innerWidth/2,  my  = innerHeight/2;
        let tmx = innerWidth/2,  tmy = innerHeight/2;
        let wake = null;

        function applyTargets() {
            const nx = tmx / (innerWidth  / 2);
            const ny = tmy / (innerHeight / 2);
            for (let i = 0; i < DEPTHS.length; i++) {
                const t  = (DEPTHS[i] / 8) * MAX_T;
                tgt[i].x = -nx * t;
                tgt[i].y = -ny * t;
            }
        }

        let idleTimer;
        let lastPointerAt = 0;
        const resetIdle = () => {
            lastPointerAt = performance.now();
            if (idleTimer) return;

            const recenterWhenIdle = () => {
                const remaining = 3000 - (performance.now() - lastPointerAt);
                if (remaining > 0) {
                    idleTimer = setTimeout(recenterWhenIdle, remaining);
                    return;
                }
                idleTimer = null;
                tmx = innerWidth/2; tmy = innerHeight/2;
                wake?.();
            };
            idleTimer = setTimeout(recenterWhenIdle, 3000);
        };
        const updatePointer = (x, y) => {
            if (tmx !== x || tmy !== y) {
                tmx = x;
                tmy = y;
                wake?.();
            }
            resetIdle();
        };
        document.addEventListener('mousemove', e => {
            updatePointer(e.clientX, e.clientY);
        }, { passive: true });
        document.addEventListener('touchmove', e => {
            if (e.touches.length) {
                updatePointer(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: true });
        window.addEventListener('resize', () => {
            if (tmx > innerWidth)  tmx = innerWidth/2;
            if (tmy > innerHeight) tmy = innerHeight/2;
            applyTargets();
            wake?.();
        });

        applyTargets();

        return {
            tick() {
                mx += (tmx - mx) * 0.08;
                my += (tmy - my) * 0.08;
                applyTargets();

                for (let i = 0; i < els.length; i++) {
                    const el = els[i];
                    if (!el) continue;
                    cur[i].x += (tgt[i].x - cur[i].x) * 0.06;
                    cur[i].y += (tgt[i].y - cur[i].y) * 0.06;
                    el.style.transform =
                        `translate3d(${cur[i].x.toFixed(2)}px,`+
                                     `${cur[i].y.toFixed(2)}px,0)`;
                }
                return Math.abs(tmx - mx) > 0.2 || Math.abs(tmy - my) > 0.2 ||
                    cur.some((point, i) => Math.abs(tgt[i].x - point.x) > 0.05 || Math.abs(tgt[i].y - point.y) > 0.05);
            },
            setWake(callback) { wake = callback; }
        };
    }

    /* ══════════════════════════════════════════════
       4. AMBIENT WRAP — envuelve .video-player
       ══════════════════════════════════════════════ */
    function ensureAmbientCanvases(wrap) {
        if (wrap.querySelector('.crt-ambient-far')) return;
        ['far','mid','near','floor'].forEach(name => {
            const c = document.createElement('canvas');
            c.className = `crt-ambient-${name}`;
            c.id        = `crtAmb_${name}`;
            c.setAttribute('aria-hidden', 'true');
            wrap.appendChild(c);
        });
    }

    function wrapPlayer(playerEl) {
        if (playerEl.parentElement.classList.contains('crt-ambient-wrap')) {
            const wrap = playerEl.parentElement;
            ensureAmbientCanvases(wrap);
            return wrap;
        }

        const wrap = document.createElement('div');
        wrap.className = 'crt-ambient-wrap';
        playerEl.parentNode.insertBefore(wrap, playerEl);
        wrap.appendChild(playerEl);

        ['far','mid','near','floor'].forEach(name => {
            const c = document.createElement('canvas');
            c.className = `crt-ambient-${name}`;
            c.id        = `crtAmb_${name}`;
            c.setAttribute('aria-hidden', 'true');
            wrap.appendChild(c);
        });

        return wrap;
    }

    /* ══════════════════════════════════════════════
       5. EDGE SAMPLING
       ══════════════════════════════════════════════ */
    const _sampleCv  = document.createElement('canvas');
    _sampleCv.width  = SAMPLE_W;
    _sampleCv.height = SAMPLE_H;
    const _sampleCtx = _sampleCv.getContext('2d', { willReadFrequently: true });

    function sampleEdges(video) {
        if (!video || video.readyState < 2 || !video.videoWidth) return null;
        try {
            _sampleCtx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
            return edgesFromData(_sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
        } catch { return null; }
    }

    function edgesFromData(data) {
        const segW = SAMPLE_W / EDGE_SEG;
        const segH = SAMPLE_H / EDGE_SEG;
        const out  = { top:[], bottom:[], left:[], right:[] };

        for (let seg = 0; seg < EDGE_SEG; seg++) {
            const sx = Math.floor(seg * segW);
            const ex = Math.min(Math.floor((seg + 1) * segW), SAMPLE_W);
            const sy = Math.floor(seg * segH);
            const ey = Math.min(Math.floor((seg + 1) * segH), SAMPLE_H);
            let tr = 0, tg = 0, tb = 0, tn = 0;
            let br = 0, bg = 0, bb = 0, bn = 0;
            let lr = 0, lg = 0, lb = 0, ln = 0;
            let rr = 0, rg = 0, rb = 0, rn = 0;

            for (let x = sx; x < ex; x++) {
                let i = x * 4;
                tr += data[i]; tg += data[i+1]; tb += data[i+2]; tn++;
                i = ((SAMPLE_H - 1) * SAMPLE_W + x) * 4;
                br += data[i]; bg += data[i+1]; bb += data[i+2]; bn++;
            }
            for (let y = sy; y < ey; y++) {
                let i = (y * SAMPLE_W) * 4;
                lr += data[i]; lg += data[i+1]; lb += data[i+2]; ln++;
                i = (y * SAMPLE_W + (SAMPLE_W - 1)) * 4;
                rr += data[i]; rg += data[i+1]; rb += data[i+2]; rn++;
            }

            out.top.push({ r: tr/tn, g: tg/tn, b: tb/tn });
            out.bottom.push({ r: br/bn, g: bg/bn, b: bb/bn });
            out.left.push({ r: lr/ln, g: lg/ln, b: lb/ln });
            out.right.push({ r: rr/rn, g: rg/rn, b: rb/rn });
        }
        return out;
    }

    /**
     * Muestreo asíncrono: createImageBitmap reduce el fotograma fuera del hilo
     * principal, así el handler de rAF no se bloquea con la lectura del vídeo.
     * Si el navegador no lo soporta (o falla), cae al método síncrono.
     */
    let _sampling = false, _samplingSince = 0, _asyncBroken = typeof createImageBitmap !== 'function';
    function sampleEdgesAsync(video, cb) {
        const t = performance.now();
        if (_sampling && t - _samplingSince < 2000) return;
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        if (_asyncBroken) {
            const e = sampleEdges(video);
            if (e) cb(e);
            return;
        }
        _sampling = true;
        _samplingSince = t;
        createImageBitmap(video, { resizeWidth: SAMPLE_W, resizeHeight: SAMPLE_H, resizeQuality: 'low' })
            .then(bmp => {
                let edges = null;
                try {
                    _sampleCtx.drawImage(bmp, 0, 0, SAMPLE_W, SAMPLE_H);
                    edges = edgesFromData(_sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
                } finally {
                    if (bmp.close) bmp.close();
                }
                return edges;
            })
            .then(edges => { if (edges) cb(edges); })
            .catch(() => { _asyncBroken = true; })
            .then(() => { _sampling = false; });
    }

    let _edgeDelta = 0; // suma de |cambios| de la última interpolación

    /**
     * Interpola bordes in‑place para reducir GC.
     * @param {Object} cur  - objeto actual (se modifica)
     * @param {Object} tgt  - bordes objetivo
     * @param {number} f    - factor de interpolación
     * @returns {Object} cur (mutado)
     */
    function lerpEdgesInPlace(cur, tgt, f) {
        _edgeDelta = 0;
        if (!cur || !tgt) return cur;
        const sides = ['top','bottom','left','right'];
        for (let s = 0; s < sides.length; s++) {
            const side = sides[s];
            const curSide = cur[side];
            const tgtSide = tgt[side];
            for (let i = 0; i < EDGE_SEG; i++) {
                const c = curSide[i], t = tgtSide[i];
                const dr = (t.r - c.r) * f, dg = (t.g - c.g) * f, db = (t.b - c.b) * f;
                c.r += dr; c.g += dg; c.b += db;
                _edgeDelta += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
            }
        }
        return cur;
    }

    /* ══════════════════════════════════════════════
       6. CANVAS RENDERING (optimizado)
       ══════════════════════════════════════════════ */

    /**
     * Sincroniza dimensiones del canvas con DPR.
     * Ahora recibe el rect ya calculado para evitar reflow.
     */
    function syncCanvasWithRect(canvas, ctx, rect) {
        const rw = rect.width  || 1;
        const rh = rect.height || 1;
        const pw = Math.max(1, Math.round(rw * renderScale));
        const ph = Math.max(1, Math.round(rh * renderScale));
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width  = pw;
            canvas.height = ph;
        }
        // Se dibuja siempre en coordenadas CSS; el transform escala al bitmap reducido.
        ctx.setTransform(pw / rw, 0, 0, ph / rh, 0, 0);
        return { w: rect.width, h: rect.height };
    }

    /**
     * Dibuja halo de luz de un lado del reproductor.
     * cRect y pRect ya vienen calculados, sin lecturas extra.
     */
    function drawLayer(canvas, ctx, edges,
                        spreadF, intensityMult, cornerBoost,
                        intensity, cRect, pRect) {
        const { w, h } = syncCanvasWithRect(canvas, ctx, cRect);
        ctx.clearRect(0, 0, w, h);
        if (!edges || intensity <= 0.001) return;

        const alpha = intensity * intensityMult;
        const iL = pRect.left   - cRect.left;
        const iT = pRect.top    - cRect.top;
        const iR = iL + pRect.width;
        const iB = iT + pRect.height;
        const iW = pRect.width;
        const iH = pRect.height;
        const padX   = Math.max((w - iW) / 2, 40);
        const padY   = Math.max((h - iH) / 2, 40);
        const spread = Math.max(padX, padY) * spreadF;

        ctx.globalCompositeOperation = 'lighter';

        // Función glow con solo 4 paradas (antes 6)
        function glow(x, y, color, size) {
            const bri = (color.r + color.g + color.b) / 765;
            const a   = Math.max(0.06, bri * 0.9 + 0.1) * alpha;
            if (a < 0.004) return;

            const r = color.r | 0, g = color.g | 0, b = color.b | 0;
            const gr = ctx.createRadialGradient(x, y, 0, x, y, size);
            gr.addColorStop(0,    `rgba(${r},${g},${b},${(a*0.9).toFixed(3)})`);
            gr.addColorStop(0.35, `rgba(${r},${g},${b},${(a*0.35).toFixed(3)})`);
            gr.addColorStop(0.70, `rgba(${r},${g},${b},${(a*0.10).toFixed(3)})`);
            gr.addColorStop(1,    `rgba(${r},${g},${b},0)`);
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        }

        // Bordes
        for (let i = 0; i < EDGE_SEG; i++) {
            const t = (i + 0.5) / EDGE_SEG;
            glow(iL + t*iW, iT, edges.top[i],    spread * 1.05);
            glow(iL + t*iW, iB, edges.bottom[i], spread * 1.05);
            glow(iL, iT + t*iH, edges.left[i],   spread * 0.90);
            glow(iR, iT + t*iH, edges.right[i],  spread * 0.90);
        }

        // Esquinas
        if (cornerBoost > 0) {
            const mix = (a, b) => ({
                r:(a.r+b.r)/2, g:(a.g+b.g)/2, b:(a.b+b.b)/2
            });
            const cs = spread * 1.2 * cornerBoost;
            const N  = EDGE_SEG - 1;
            glow(iL, iT, mix(edges.top[0],       edges.left[0]),  cs);
            glow(iR, iT, mix(edges.top[N],        edges.right[0]), cs);
            glow(iL, iB, mix(edges.bottom[0],     edges.left[N]),  cs);
            glow(iR, iB, mix(edges.bottom[N],     edges.right[N]), cs);
        }

        ctx.globalCompositeOperation = 'source-over';
    }

    function drawFloor(canvas, ctx, edges, intensity, cRect) {
        const { w, h } = syncCanvasWithRect(canvas, ctx, cRect);
        ctx.clearRect(0, 0, w, h);
        if (!edges || intensity <= 0.001) return;

        ctx.globalCompositeOperation = 'lighter';
        const alpha = intensity * 0.45;

        for (let i = 0; i < EDGE_SEG; i++) {
            const t   = (i + 0.5) / EDGE_SEG;
            const c   = edges.bottom[i];
            const bri = (c.r + c.g + c.b) / 765;
            const a   = Math.max(0.03, bri * 0.55) * alpha;
            const x   = w * (0.05 + t * 0.9);
            const size = Math.max(w * 0.12, h * 0.7);
            const r = c.r|0, g = c.g|0, b = c.b|0;
            const gr = ctx.createRadialGradient(x, h*0.1, 0, x, h*0.1, size);
            gr.addColorStop(0,   `rgba(${r},${g},${b},${a.toFixed(3)})`);
            gr.addColorStop(0.4, `rgba(${r},${g},${b},${(a*0.35).toFixed(3)})`);
            gr.addColorStop(0.8, `rgba(${r},${g},${b},${(a*0.10).toFixed(3)})`);
            gr.addColorStop(1,   `rgba(${r},${g},${b},0)`);
            ctx.fillStyle = gr;
            ctx.fillRect(0, 0, w, h);
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    /* ══════════════════════════════════════════════
       7. MAIN INIT (con menos reflows)
       ══════════════════════════════════════════════ */
    function init() {
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReducedMotion) {
            console.info('[GalaxiaAmbient] Movimiento reducido detectado. Animaciones pausadas.');
        }

        const videoEl  = document.getElementById('videoPlayer');
        const playerEl = document.getElementById('videoPlayerWrap');
        if (!videoEl || !playerEl) {
            console.warn('[GalaxiaAmbient] Elementos no encontrados.');
            return;
        }

        buildParallaxScene();
        spawnParticles();
        const parallax = createParallax();

        const videoPlayerDiv = playerEl.querySelector('.video-player') || playerEl;
        const ambWrap = wrapPlayer(videoPlayerDiv);

        const cvFar   = ambWrap.querySelector('.crt-ambient-far');
        const cvMid   = ambWrap.querySelector('.crt-ambient-mid');
        const cvNear  = ambWrap.querySelector('.crt-ambient-near');
        const cvFloor = ambWrap.querySelector('.crt-ambient-floor');

        const ctxFar   = cvFar.getContext('2d');
        const ctxMid   = cvMid.getContext('2d');
        const ctxNear  = cvNear.getContext('2d');
        const ctxFloor = cvFloor.getContext('2d');

        const layers = [
            { key:'far',   cv:cvFar,   ctx:ctxFar,   spread:1.40, mult:0.55, corner:1.2 },
            { key:'mid',   cv:cvMid,   ctx:ctxMid,   spread:0.85, mult:0.78, corner:0.9 },
            { key:'near',  cv:cvNear,  ctx:ctxNear,  spread:0.45, mult:1.00, corner:0.6 },
            { key:'floor', cv:cvFloor, ctx:ctxFloor, floor:true }
        ];
        const DRAW_ORDER = [0, 3, 1, 2]; // far+floor / mid+near: reparte el coste entre frames

        let intensity    = 0;
        let targetInt    = prefersReducedMotion ? 0.5 : 0;
        let curEdges     = null;
        let tgtEdges     = null;
        let extractionTimer = 0;
        let epoch        = 0;     // invalida muestreos asíncronos en vuelo
        let needsDraw    = true;
        let pendingDelta = 0;
        let drawnInt     = -1;
        let remaining    = 0;     // capas pendientes del ciclo de dibujo actual
        let cursor       = 0;
        let slowStreak   = 0;

        function cloneEdges(e) {
            return {
                top:    e.top.map(c => ({ ...c })),
                bottom: e.bottom.map(c => ({ ...c })),
                left:   e.left.map(c => ({ ...c })),
                right:  e.right.map(c => ({ ...c }))
            };
        }

        function setActive(on) {
            ambWrap.classList.toggle('crt-active', on);
        }

        function stopExtractionTimer() {
            if (extractionTimer) clearTimeout(extractionTimer);
            extractionTimer = 0;
        }

        function scheduleExtraction() {
            if (extractionTimer || document.hidden || videoEl.paused) return;
            extractionTimer = window.setTimeout(function () {
                extractionTimer = 0;
                if (document.hidden || videoEl.paused) return;
                const ep = epoch;
                sampleEdgesAsync(videoEl, e => {
                    if (ep !== epoch || document.hidden) return;
                    tgtEdges = e;
                    if (!curEdges) curEdges = cloneEdges(e);
                    requestLoop();
                });
                scheduleExtraction();
            }, EXTRACT_MS);
        }

        function takeSnapshot() {
            const e = sampleEdges(videoEl);
            if (e) {
                tgtEdges = e;
                if (!curEdges) curEdges = cloneEdges(e);
                needsDraw = true;
            }
        }

        function startExtraction() {
            targetInt = 1;
            setActive(true);
            takeSnapshot();
            scheduleExtraction();
        }

        function stopExtraction(clearEdges = false) {
            stopExtractionTimer();
            targetInt = 0;
            setActive(false);
            if (clearEdges) { curEdges = null; tgtEdges = null; epoch++; needsDraw = true; }
        }

        videoEl.addEventListener('play',    startExtraction);
        videoEl.addEventListener('ended',   () => stopExtraction());
        videoEl.addEventListener('emptied', () => stopExtraction(true));
        videoEl.addEventListener('seeked',  () => {
            if (videoEl.readyState >= 2) takeSnapshot();
            requestLoop();
        });
        videoEl.addEventListener('loadeddata', () => {
            takeSnapshot();
            scheduleExtraction();
            requestLoop();
        });

        /* ── Geometría en caché: se mide al inicio del frame (antes de escribir
              transforms) y solo cuando cambia el layout, no en cada dibujo ── */
        let rects = null, rectsDirty = true, lastMeasure = -Infinity, lastSig = '';
        const plain = r => ({ left: r.left, top: r.top, width: r.width, height: r.height });

        function measureRects(now) {
            rectsDirty  = false;
            lastMeasure = now;
            const r = { p: plain(videoPlayerDiv.getBoundingClientRect()) };
            let sig = r.p.width.toFixed(1) + 'x' + r.p.height.toFixed(1);
            for (let i = 0; i < layers.length; i++) {
                const k = layers[i].key;
                const c = plain(layers[i].cv.getBoundingClientRect());
                r[k] = c;
                sig += '|' + (r.p.left - c.left).toFixed(1) + ',' + (r.p.top - c.top).toFixed(1) +
                       ',' + c.width.toFixed(1) + ',' + c.height.toFixed(1);
            }
            rects = r;
            if (sig !== lastSig) { lastSig = sig; needsDraw = true; }
        }

        function drawOne(i) {
            const L = layers[i];
            if (L.floor) {
                drawFloor(L.cv, L.ctx, curEdges, intensity, rects[L.key]);
            } else {
                drawLayer(L.cv, L.ctx, curEdges, L.spread, L.mult, L.corner,
                          intensity, rects[L.key], rects.p);
            }
        }

        const DRAW_INTERVAL = 1000 / 15;
        let rafId = 0;
        let tickTimer = 0;
        let lastDraw = 0;
        function requestLoop() {
            if (document.hidden) return;
            if (tickTimer) {
                clearTimeout(tickTimer);
                tickTimer = 0;
            }
            if (!rafId) rafId = requestAnimationFrame(loop);
        }

        function scheduleNextTick(now, moving, fading, edgesMoving) {
            if (moving) {
                requestLoop();
            } else if (fading || edgesMoving || remaining > 0) {
                const delay = Math.max(0, DRAW_INTERVAL - (now - lastDraw));
                if (!tickTimer) {
                    tickTimer = window.setTimeout(() => {
                        tickTimer = 0;
                        requestLoop();
                    }, delay);
                }
            }
        }
        parallax.setWake(requestLoop);

        function markRectsDirty() { rectsDirty = true; requestLoop(); }
        if (typeof ResizeObserver === 'function') {
            const ro = new ResizeObserver(markRectsDirty);
            ro.observe(ambWrap);
            ro.observe(videoPlayerDiv);
        }
        window.addEventListener('resize', markRectsDirty, { passive: true });
        document.addEventListener('fullscreenchange', markRectsDirty);
        document.addEventListener('webkitfullscreenchange', markRectsDirty);

        function loop(now) {
            rafId = 0;
            if (document.hidden) return;

            // 1) LECTURAS de layout primero (sin escrituras previas → sin reflow forzado)
            if (rectsDirty || now - lastMeasure >= RECT_REVALIDATE_MS) measureRects(now);

            const fading  = Math.abs(targetInt - intensity) > 0.002;

            // 3) Estado y ESCRITURAS (parallax, interpolación)
            const moving = prefersReducedMotion ? false : parallax.tick();
            intensity += (targetInt - intensity) * 0.12;
            if (intensity !== targetInt && Math.abs(targetInt - intensity) <= 0.002) {
                intensity = targetInt;   // cierra el fundido con el valor exacto
                needsDraw = true;
            }
            let edgesMoving = false;
            if (tgtEdges && curEdges) {
                lerpEdgesInPlace(curEdges, tgtEdges, 0.12);
                pendingDelta += _edgeDelta;
                edgesMoving = _edgeDelta > 0.05;
            }

            // 4) ¿Hace falta redibujar? Solo si algo cambió de forma visible
            if (remaining === 0 && rects && rects.p.width && rects.p.height &&
                (needsDraw || pendingDelta > EDGE_EPS || Math.abs(intensity - drawnInt) > INT_EPS)) {
                remaining    = DRAW_ORDER.length;
                cursor       = 0;
                pendingDelta = 0;
                drawnInt     = intensity;
                needsDraw    = false;
            }

            // 5) Dibujo repartido: máx. LAYERS_PER_TICK capas por frame, a 15 fps
            if (remaining > 0 && now - lastDraw >= DRAW_INTERVAL) {
                lastDraw = now;
                const n  = Math.min(LAYERS_PER_TICK, remaining);
                const t0 = performance.now();
                for (let k = 0; k < n; k++) drawOne(DRAW_ORDER[cursor++]);
                remaining -= n;

                // Calidad adaptativa: si el dibujo sigue siendo caro, baja la resolución
                if (performance.now() - t0 > DRAW_BUDGET_MS) {
                    if (++slowStreak >= 3 && renderScale > RENDER_SCALE_MIN) {
                        renderScale = Math.max(RENDER_SCALE_MIN, renderScale * 0.8);
                        slowStreak  = 0;
                        needsDraw   = true;
                        console.debug('[GalaxiaAmbient] Resolución de halos reducida a', renderScale.toFixed(2));
                    }
                } else {
                    slowStreak = 0;
                }
            }

            scheduleNextTick(now, moving, fading, edgesMoving);
        }

        videoEl.addEventListener('play', requestLoop);
        videoEl.addEventListener('pause', () => {
            stopExtractionTimer();
            requestLoop();
        });
        videoEl.addEventListener('ended', requestLoop);
        videoEl.addEventListener('emptied', requestLoop);
        videoEl.addEventListener('loadeddata', requestLoop);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                scheduleExtraction();
                requestLoop();
            } else {
                stopExtractionTimer();
                if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
                if (tickTimer) { clearTimeout(tickTimer); tickTimer = 0; }
            }
        });
        requestLoop();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-galaxia.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})();
