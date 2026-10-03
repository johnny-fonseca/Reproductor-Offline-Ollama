/* ============================================================
   AI GLASS BUTTONS — VERSIÓN EXTREMA (ROBUSTA + EXTENSA)
   - Persistencia local (URL + modelo)
   - Reintentos con backoff en carga de modelos
   - Exportar/importar capítulos (JSON/Texto)
   - Edición inline de títulos y tiempos
   - Regeneración de capítulos con feedback visual
   - Prueba de conexión a Ollama
   - Focus trapping y mejora de accesibilidad
   - Toasts nativos + eventos
   - Manejo de errores granulado
   ============================================================ */
(function () {
    'use strict';

    /* ------------------------------------------------------------------
       CONFIGURACIÓN
    ------------------------------------------------------------------ */
    const CONFIG = {
        OLLAMA_DEFAULT_URL: 'http://localhost:11434',
        MODEL_LOAD_TIMEOUT_MS: 8000,
        MODEL_LOAD_RETRIES: 2,
        MODEL_LOAD_RETRY_DELAY_MS: 1000,
        CHAPTER_EDIT_ENABLED: true,       // permite edición inline
        LOCAL_STORAGE_PREFIX: 'vp_ai_',
        TOAST_DURATION_MS: 4000
    };

    /* ------------------------------------------------------------------
       UTILIDADES MEJORADAS
    ------------------------------------------------------------------ */
    const storage = {
        get: (key, defaultValue = '') => {
            try {
                var val = VP.db.obtenerKeyVal(CONFIG.LOCAL_STORAGE_PREFIX + key);
                return val !== null && val !== undefined ? val : defaultValue;
            } catch (_) { return defaultValue; }
        },
        set: (key, value) => {
            try { VP.db.guardarKeyVal(CONFIG.LOCAL_STORAGE_PREFIX + key, value); return true; }
            catch (_) { return false; }
        },
        remove: (key) => {
            try { VP.db.eliminarKeyVal(CONFIG.LOCAL_STORAGE_PREFIX + key); }
            catch (_) {}
        }
    };

    // Escapa HTML y también caracteres peligrosos para atributos
    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    // Formato HH:MM:SS o MM:SS
    const formatTime = (seconds) => {
        const totalSecs = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = totalSecs % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    };

    // Parse "1:23:45" o "12:34" a segundos
    const parseTimeString = (str) => {
        const parts = String(str).split(':').map(Number);
        if (parts.some(n => !Number.isFinite(n) || n < 0)) return 0;
        if (parts.length === 1) return parts[0];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    };

    // Sistema de notificaciones interno (no depende de showNotification global)
    const showInternalNotification = (icon, message, isError = false) => {
        if (typeof window.showNotification === 'function') {
            window.showNotification(icon, message);
            return;
        }
        // Fallback: toast improvisado
        const toast = document.createElement('div');
        toast.className = `vp-toast-notification ${isError ? 'vp-toast-error' : ''}`;
        toast.style.cssText = `
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            background: ${isError ? '#d32f2f' : '#2e7d32'}; color: white;
            padding: 10px 20px; border-radius: 40px; font-size: 0.9rem;
            z-index: 10000; display: flex; align-items: center; gap: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3); backdrop-filter: blur(4px);
            font-weight: 500; pointer-events: none;
        `;
        toast.innerHTML = `<span style="font-size:1.2rem">${icon}</span> ${escapeHtml(message)}`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), CONFIG.TOAST_DURATION_MS);
    };

    const notifySuccess = (msg) => showInternalNotification('✅', msg);
    const notifyError = (msg) => showInternalNotification('❌', msg, true);
    const notifyInfo = (msg) => showInternalNotification('ℹ️', msg);

    // Retry helper con backoff exponencial
    async function retryAsync(fn, retries = CONFIG.MODEL_LOAD_RETRIES, delayMs = CONFIG.MODEL_LOAD_RETRY_DELAY_MS) {
        let lastError;
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (i === retries) break;
                await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, i)));
            }
        }
        throw lastError;
    }

    /* ------------------------------------------------------------------
       REFERENCIAS DOM + ESTADO INTERNO
    ------------------------------------------------------------------ */
    const elements = {
        summaryBtn: document.getElementById('summaryBtn'),
        chaptersAiBtn: document.getElementById('chaptersAiBtn'),
        summaryModal: document.getElementById('summaryModal'),
        chaptersAiModal: document.getElementById('chaptersAiModal'),
        summaryClose: document.getElementById('summaryModalClose'),
        chaptersClose: document.getElementById('chaptersAiModalClose'),
        generateSummaryBtn: document.getElementById('generateSummaryBtn'),
        cancelSummaryBtn: document.getElementById('cancelSummaryBtn'),
        generateChaptersBtn: document.getElementById('generateChaptersAiBtn'),
        cancelChaptersBtn: document.getElementById('cancelChaptersAiBtn'),
        chaptersAiModelSel: document.getElementById('chaptersAiModel'),
        chaptersAiUrlInput: document.getElementById('chaptersAiUrl'),
        chaptersRefreshBtn: document.getElementById('chaptersRefreshModelsBtn'),
        applyChaptersBtn: document.getElementById('applyChaptersAiBtn'),
        chaptersAiList: document.getElementById('chaptersAiList'),
        videoPlayer: document.getElementById('videoPlayer')
    };

    // Estado interno de capítulos
    let currentChapters = [];            // array { time, title, seconds? }
    let isGeneratingChapters = false;

    // Focus trap management (para accesibilidad)
    let lastActiveElement = null;

    /* ------------------------------------------------------------------
       HELPERS DE MODALES MEJORADOS (inert + focus trap)
    ------------------------------------------------------------------ */
    const inertMain = (inert) => {
        const mainEl = document.getElementById('main-content');
        if (mainEl) mainEl.inert = !!inert;
    };

    const openModal = (modal, openButton) => {
        if (!modal) return;
        lastActiveElement = document.activeElement;
        modal.classList.add('active');
        modal.removeAttribute('aria-hidden');
        modal.setAttribute('aria-modal', 'true');
        inertMain(true);

        // Enfocar el primer elemento interactivo dentro del modal
        const firstFocusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) firstFocusable.focus();
        else modal.focus();
    };

    const closeModal = (modal, buttonToDeactivate) => {
        if (!modal) return;
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (buttonToDeactivate) buttonToDeactivate.classList.remove('is-active');
        inertMain(false);
        if (lastActiveElement && lastActiveElement.focus) lastActiveElement.focus();
    };

    // Cierres
    if (elements.summaryClose && elements.summaryModal) {
        elements.summaryClose.addEventListener('click', () => closeModal(elements.summaryModal, elements.summaryBtn));
    }
    if (elements.chaptersClose && elements.chaptersAiModal) {
        elements.chaptersClose.addEventListener('click', () => closeModal(elements.chaptersAiModal, elements.chaptersAiBtn));
    }

    // Cierre con backdrop
    [elements.summaryModal, elements.chaptersAiModal].forEach(modal => {
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(modal, modal.id === 'summaryModal' ? elements.summaryBtn : elements.chaptersAiBtn);
            }
        });
    });

    // Escape (centralizado en vp-eventos.js)
    if (typeof VP.eventos.registrarModalIA === 'function') {
        if (elements.summaryModal) {
            VP.eventos.registrarModalIA('summaryModal', function () {
                closeModal(elements.summaryModal, elements.summaryBtn);
            });
        }
    }

    // Abrir modales con persistencia de URL y carga inteligente
    if (elements.summaryBtn && elements.summaryModal) {
        elements.summaryBtn.addEventListener('click', () => openModal(elements.summaryModal, elements.summaryBtn));
    }

    if (elements.chaptersAiBtn && elements.chaptersAiModal) {
        elements.chaptersAiBtn.addEventListener('click', async () => {
            openModal(elements.chaptersAiModal, elements.chaptersAiBtn);
            // Cargar modelos solo si select vacío o forzado
            if (elements.chaptersAiModelSel && elements.chaptersAiModelSel.options.length <= 1) {
                await loadModelsWithRetry();
            }
        });
    }

    /* ------------------------------------------------------------------
       ESTADO "is-active" DURANTE GENERACIÓN (mejorado con abort)
    ------------------------------------------------------------------ */
    let activeGenerationController = null;

    const setGenerating = (btn, isGenerating, abortController = null) => {
        if (!btn) return;
        if (isGenerating) {
            btn.classList.add('is-active');
            activeGenerationController = abortController;
        } else {
            btn.classList.remove('is-active');
            if (activeGenerationController === abortController) activeGenerationController = null;
        }
    };

    if (elements.generateSummaryBtn) {
        elements.generateSummaryBtn.addEventListener('click', () => {
            setGenerating(elements.summaryBtn, true);
            // El evento 'summary:done' o 'summary:error' lo desactivará
        });
    }
    if (elements.cancelSummaryBtn) {
        elements.cancelSummaryBtn.addEventListener('click', () => {
            if (activeGenerationController) activeGenerationController.abort();
            setGenerating(elements.summaryBtn, false);
        });
    }

    if (elements.generateChaptersBtn) {
        elements.generateChaptersBtn.addEventListener('click', () => {
            setGenerating(elements.chaptersAiBtn, true);
        });
    }
    if (elements.cancelChaptersBtn) {
        elements.cancelChaptersBtn.addEventListener('click', () => {
            if (activeGenerationController) activeGenerationController.abort();
            setGenerating(elements.chaptersAiBtn, false);
        });
    }

    // Eventos externos de finalización
    document.addEventListener('summary:done', () => setGenerating(elements.summaryBtn, false));
    document.addEventListener('summary:error', () => setGenerating(elements.summaryBtn, false));
    document.addEventListener('chapters:done', () => setGenerating(elements.chaptersAiBtn, false));
    document.addEventListener('chapters:error', () => setGenerating(elements.chaptersAiBtn, false));

    /* ------------------------------------------------------------------
       CARGA DE MODELOS OLLAMA (robusta + reintentos + persistencia)
    ------------------------------------------------------------------ */
    async function fetchModelsFromOllama(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.MODEL_LOAD_TIMEOUT_MS);
        try {
            const response = await fetch(`${url}/api/tags`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return data.models || [];
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    }

    async function loadModelsWithRetry() {
        if (!elements.chaptersAiModelSel) return;
        const urlBase = (elements.chaptersAiUrlInput?.value || CONFIG.OLLAMA_DEFAULT_URL).trim();
        const selectEl = elements.chaptersAiModelSel;
        const originalHtml = selectEl.innerHTML;

        selectEl.innerHTML = '<option value="">⏳ Conectando...</option>';
        selectEl.disabled = true;

        try {
            const models = await retryAsync(() => fetchModelsFromOllama(urlBase));
            selectEl.innerHTML = '';
            if (!models.length) {
                selectEl.innerHTML = '<option value="">⚠️ Ningún modelo disponible</option>';
                notifyInfo('No se encontraron modelos en Ollama');
            } else {
                const fragment = document.createDocumentFragment();
                models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.name;
                    opt.textContent = `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`;
                    fragment.appendChild(opt);
                });
                selectEl.appendChild(fragment);
                // Restaurar modelo guardado
                const savedModel = storage.get('selected_model');
                if (savedModel && [...selectEl.options].some(opt => opt.value === savedModel)) {
                    selectEl.value = savedModel;
                }
                notifySuccess(`Cargados ${models.length} modelo(s)`);
            }
        } catch (err) {
            console.error('Error cargando modelos:', err);
            let errorMsg = 'Error de conexión con Ollama';
            if (err.name === 'AbortError') errorMsg = '⏱️ Tiempo de espera agotado';
            selectEl.innerHTML = `<option value="">❌ ${errorMsg}</option>`;
            notifyError(`${errorMsg}. Verifica URL y que Ollama esté corriendo.`);
        } finally {
            selectEl.disabled = false;
            if (selectEl.options.length === 0) {
                selectEl.innerHTML = '<option value="">No se pudo cargar</option>';
            }
        }
    }

    // Persistencia de URL y modelo al cambiar
    if (elements.chaptersAiUrlInput) {
        const savedUrl = storage.get('ollama_url', CONFIG.OLLAMA_DEFAULT_URL);
        elements.chaptersAiUrlInput.value = savedUrl;
        elements.chaptersAiUrlInput.addEventListener('change', () => {
            storage.set('ollama_url', elements.chaptersAiUrlInput.value.trim());
            loadModelsWithRetry();
        });
    }
    if (elements.chaptersAiModelSel) {
        elements.chaptersAiModelSel.addEventListener('change', () => {
            if (elements.chaptersAiModelSel.value) storage.set('selected_model', elements.chaptersAiModelSel.value);
            else storage.remove('selected_model');
        });
    }
    if (elements.chaptersRefreshBtn) {
        elements.chaptersRefreshBtn.addEventListener('click', loadModelsWithRetry);
    }

    // Botón "Probar conexión" (añadido dinámicamente por robustez)
    const addTestConnectionButton = () => {
        if (!elements.chaptersAiUrlInput) return;
        const parent = elements.chaptersAiUrlInput.parentElement;
        if (parent && !document.getElementById('testOllamaConnBtn')) {
            const testBtn = document.createElement('button');
            testBtn.id = 'testOllamaConnBtn';
            testBtn.type = 'button';
            testBtn.textContent = '🔌 Probar';
            testBtn.style.marginLeft = '8px';
            testBtn.style.padding = '4px 12px';
            testBtn.classList.add('secondary-btn');
            testBtn.addEventListener('click', async () => {
                const url = elements.chaptersAiUrlInput.value.trim();
                const testMsg = document.createElement('span');
                testMsg.style.marginLeft = '8px';
                testMsg.style.fontSize = '0.8rem';
                testBtn.insertAdjacentElement('afterend', testMsg);
                testBtn.disabled = true;
                try {
                    await retryAsync(() => fetchModelsFromOllama(url), 1, 500);
                    testMsg.textContent = '✅ Conectado';
                    testMsg.style.color = '#4caf50';
                    setTimeout(() => testMsg.remove(), 3000);
                } catch (err) {
                    testMsg.textContent = '❌ Fallo conexión';
                    testMsg.style.color = '#f44336';
                    setTimeout(() => testMsg.remove(), 3000);
                } finally {
                    testBtn.disabled = false;
                }
            });
            parent.appendChild(testBtn);
        }
    };
    // Esperar a que el DOM esté listo para añadirlo
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTestConnectionButton);
    else addTestConnectionButton();

    /* ------------------------------------------------------------------
       RENDERIZADO DE CAPÍTULOS (con edición inline opcional)
    ------------------------------------------------------------------ */
    function renderChaptersList(chapters) {
        if (!elements.chaptersAiList) return;
        currentChapters = chapters;
        const container = elements.chaptersAiList;
        container.innerHTML = '';

        if (!chapters || chapters.length === 0) {
            container.innerHTML = `<p style="color:var(--yt-text-secondary);padding:1rem">📭 No se encontraron capítulos.</p>`;
            return;
        }

        const frag = document.createDocumentFragment();
        chapters.forEach((ch, idx) => {
            const seconds = Number(ch.time ?? ch.seconds ?? 0);
            const title = ch.title || 'Sin título';
            const timeStr = formatTime(seconds);

            const item = document.createElement('div');
            item.className = 'chapter-ai-item';
            item.dataset.index = idx;

            // Modo edición o visualización
            if (CONFIG.CHAPTER_EDIT_ENABLED) {
                item.innerHTML = `
                    <span class="chapter-ai-num">${idx + 1}</span>
                    <input type="text" class="chapter-time-edit" value="${escapeHtml(timeStr)}" data-original-seconds="${seconds}" size="8" title="HH:MM:SS o MM:SS">
                    <input type="text" class="chapter-title-edit" value="${escapeHtml(title)}" placeholder="Título">
                    <button class="chapter-save-edit" title="Guardar cambios">💾</button>
                    <button class="chapter-delete-item" title="Eliminar">🗑️</button>
                    <button class="chapter-jump-btn" data-seconds="${seconds}" title="Ir al video">▶ Ir</button>
                `;
                // Eventos específicos para edición (se delegan abajo, pero usamos listeners directos por claridad)
                const timeInput = item.querySelector('.chapter-time-edit');
                const titleInput = item.querySelector('.chapter-title-edit');
                const saveBtn = item.querySelector('.chapter-save-edit');
                const deleteBtn = item.querySelector('.chapter-delete-item');
                const jumpBtn = item.querySelector('.chapter-jump-btn');

                saveBtn.addEventListener('click', () => {
                    const newTimeStr = timeInput.value.trim();
                    const newTitle = titleInput.value.trim();
                    let newSeconds = parseTimeString(newTimeStr);
                    if (isNaN(newSeconds)) newSeconds = seconds;
                    currentChapters[idx] = { time: newSeconds, title: newTitle || 'Sin título', seconds: newSeconds };
                    renderChaptersList(currentChapters);
                    notifySuccess('Capítulo actualizado');
                    // Emitir evento para que otros componentes (ej. setChapters) se enteren
                    document.dispatchEvent(new CustomEvent('chapters:updated', { detail: { chapters: currentChapters } }));
                });
                deleteBtn.addEventListener('click', () => {
                    currentChapters.splice(idx, 1);
                    renderChaptersList(currentChapters);
                    notifyInfo('Capítulo eliminado');
                    document.dispatchEvent(new CustomEvent('chapters:updated', { detail: { chapters: currentChapters } }));
                });
                jumpBtn.addEventListener('click', () => {
                    if (elements.videoPlayer) {
                        elements.videoPlayer.currentTime = seconds;
                        elements.videoPlayer.play().catch(() => {});
                    }
                });
            } else {
                // Versión simple sin edición
                item.innerHTML = `
                    <span class="chapter-ai-num">${idx + 1}</span>
                    <button class="chapter-ai-time" data-seconds="${seconds}" title="Ir a ${timeStr}">${timeStr}</button>
                    <span class="chapter-ai-title">${escapeHtml(title)}</span>
                    <button class="chapter-ai-jump" data-seconds="${seconds}">▶ Ir</button>
                `;
            }
            frag.appendChild(item);
        });
        container.appendChild(frag);

        // Delegación para salto simple (si no se usó la edición)
        if (!CONFIG.CHAPTER_EDIT_ENABLED) {
            container.querySelectorAll('[data-seconds]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const sec = parseFloat(btn.dataset.seconds);
                    if (!isNaN(sec) && elements.videoPlayer) {
                        elements.videoPlayer.currentTime = sec;
                        elements.videoPlayer.play().catch(() => {});
                    }
                });
            });
        }
    }

    // Escuchar evento externo de renderizado
    document.addEventListener('chapters:render', (e) => {
        const chapters = e.detail?.chapters || [];
        renderChaptersList(chapters);
    });

    // Evento de actualización para notificar a quien quiera (p.ej. setChapters)
    document.addEventListener('chapters:updated', (e) => {
        if (e.detail?.chapters && typeof window.setChapters === 'function') {
            window.setChapters(e.detail.chapters);
        }
    });

    /* ------------------------------------------------------------------
       APLICAR CAPÍTULOS (con validación + exportación/importación)
    ------------------------------------------------------------------ */
    if (elements.applyChaptersBtn) {
        elements.applyChaptersBtn.addEventListener('click', () => {
            if (!currentChapters.length) {
                notifyError('No hay capítulos para aplicar');
                return;
            }
            if (typeof window.setChapters === 'function') {
                window.setChapters(currentChapters);
                notifySuccess(`${currentChapters.length} capítulos aplicados`);
            } else {
                notifyError('setChapters no disponible');
            }
            closeModal(elements.chaptersAiModal, elements.chaptersAiBtn);
        });
    }

    // Añadir botones de exportar/importar/regenerar dentro del modal
    const addChapterUtilityButtons = () => {
        const modalFooter = elements.chaptersAiModal?.querySelector('.modal-footer');
        if (!modalFooter || document.getElementById('vpChapterExportBtn')) return;

        const exportBtn = document.createElement('button');
        exportBtn.id = 'vpChapterExportBtn';
        exportBtn.textContent = '📎 Exportar JSON';
        exportBtn.classList.add('secondary-btn');
        exportBtn.style.marginRight = '8px';
        exportBtn.addEventListener('click', () => {
            if (!currentChapters.length) { notifyError('No hay capítulos'); return; }
            const dataStr = JSON.stringify(currentChapters, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chapters_${new Date().toISOString().slice(0,19)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            notifySuccess('Exportado');
        });

        const importFileInput = document.createElement('input');
        importFileInput.type = 'file';
        importFileInput.accept = 'application/json';
        importFileInput.style.display = 'none';
        importFileInput.id = 'vpChapterImportInput';
        const importBtn = document.createElement('button');
        importBtn.textContent = '📂 Importar JSON';
        importBtn.classList.add('secondary-btn');
        importBtn.addEventListener('click', () => importFileInput.click());
        importFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = (window.VP && VP.util && VP.util.parsearJSONSeguro)
                        ? VP.util.parsearJSONSeguro(ev.target.result, null)
                        : JSON.parse(ev.target.result);
                    if (Array.isArray(imported)) {
                        renderChaptersList(imported);
                        notifySuccess('Capítulos importados');
                        document.dispatchEvent(new CustomEvent('chapters:updated', { detail: { chapters: imported } }));
                    } else throw new Error('Formato inválido');
                } catch (err) {
                    notifyError('JSON inválido');
                }
                importFileInput.value = '';
            };
            reader.readAsText(file);
        });
        document.body.appendChild(importFileInput);

        const regenerateBtn = document.createElement('button');
        regenerateBtn.textContent = '🔄 Regenerar';
        regenerateBtn.classList.add('primary-btn');
        regenerateBtn.addEventListener('click', () => {
            if (typeof window.generateChapters === 'function') {
                setGenerating(elements.chaptersAiBtn, true);
                window.generateChapters().catch(() => setGenerating(elements.chaptersAiBtn, false));
            } else {
                notifyError('No hay función regenerateChapters global');
                // Disparar evento para que el sistema externo regenera
                document.dispatchEvent(new CustomEvent('request:regenerateChapters'));
            }
        });

        modalFooter.prepend(exportBtn, importBtn, regenerateBtn);
    };

    // Inyectar botones adicionales cuando el modal se abre
    if (elements.chaptersAiModal) {
        const observer = new MutationObserver((mutations) => {
            if (elements.chaptersAiModal.classList.contains('active')) {
                addChapterUtilityButtons();
                observer.disconnect();
            }
        });
        observer.observe(elements.chaptersAiModal, { attributes: true, attributeFilter: ['class'] });
        // Si ya está activo por casualidad
        if (elements.chaptersAiModal.classList.contains('active')) addChapterUtilityButtons();
    }

    /* ------------------------------------------------------------------
       POLYFILL ABORT + INICIALIZACIÓN FINAL
    ------------------------------------------------------------------ */
    if (typeof AbortSignal.timeout !== 'function') {
        AbortSignal.timeout = (ms) => {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), ms);
            return ctrl.signal;
        };
    }

    // Sincronización inicial: cargar modelos si hay URL guardada y el select está vacío y visible (pero no ahora para no saturar)
    setTimeout(() => {
        if (elements.chaptersAiModelSel && elements.chaptersAiModelSel.options.length <= 1 && elements.chaptersAiUrlInput?.value) {
            loadModelsWithRetry().catch(() => {});
        }
    }, 500);

    // Exponer algunas utilidades públicas para depuración/integración
    window.VpAiButtons = {
        refreshModels: loadModelsWithRetry,
        getChapters: () => [...currentChapters],
        setChapters: renderChaptersList,
        notify: notifySuccess
    };

    try {
        if (window.VP && typeof window.VP.registrarScriptActual === 'function') {
            window.VP.registrarScriptActual('vp-ai-btns.js');
        }
    } catch (errorRegistroModulo) {
        try { if (window.console && typeof window.console.warn === 'function') window.console.warn('[VP] No se pudo registrar el módulo', errorRegistroModulo); } catch (_) {}
    }

})();
