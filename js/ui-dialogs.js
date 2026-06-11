/* ══════════════════════════════════════════════════════════════════
   UI DIALOGS — Confirmación modal con escudo anti "ghost-click"
   ══════════════════════════════════════════════════════════════════
   PROBLEMA QUE RESUELVE (bug reportado):
   En móvil (especialmente iOS/Safari y algunos WebView de Android), al
   tocar el botón de confirmación el navegador sintetiza un evento
   `click` ~300 ms después del `touchend`, EN LAS MISMAS COORDENADAS.
   Si para entonces el diálogo ya fue retirado del DOM, ese click
   fantasma aterriza en lo que esté DETRÁS (inputs, botones de la hoja,
   el engranaje del header…) → "el toque traspasa".

   La versión anterior retiraba el bloqueador tras solo 2 frames
   (~32 ms), muy por debajo de la ventana de ~300 ms, y además podía
   ejecutar onConfirm DOS veces (pointerup + click).

   ESTRATEGIA (defensa en 3 capas):
   1. preventDefault() en pointerup/touchend sobre los botones
      → suprime el click sintetizado en origen (donde el navegador
        lo respeta).
   2. Bloqueador de captura a nivel de document para TODOS los eventos
      de puntero/táctiles/click que no nazcan dentro de la tarjeta.
   3. Tras cerrar, el bloqueador pasa a modo "absorber todo" y
      permanece vivo GHOST_CLICK_WINDOW ms (450 ms > 300 ms de iOS),
      de modo que el click fantasma muere antes de tocar la página.

   Además: onConfirm/onCancel con garantía de ejecución única, trampa
   de foco accesible (role=alertdialog), restauración del foco al
   elemento invocador, variante "peligro" automática, animación de
   entrada/salida y tick háptico en dispositivos compatibles.
   ══════════════════════════════════════════════════════════════════ */
'use strict';

const UI = (() => {

  /** Ventana de seguridad tras el cierre. El click sintetizado de iOS
   *  llega ~300 ms después del touchend; 450 ms da margen holgado. */
  const GHOST_CLICK_WINDOW = 450;

  /** Duración de la animación de salida (debe coincidir con el CSS). */
  const EXIT_MS = 160;

  /** Eventos que el escudo intercepta en fase de captura. */
  const SHIELD_EVENTS = [
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu',
  ];

  /** Etiquetas que activan el estilo destructivo automáticamente. */
  const DANGER_RE = /(eliminar|borrar|resetear|limpiar|sobreescribir|salir)/i;

  /** Pequeño tick háptico (no-op donde no exista la API). */
  const haptic = (ms = 12) => { try { navigator.vibrate?.(ms); } catch (_) {} };

  /**
   * Muestra un diálogo de confirmación modal.
   *
   * Mantiene la firma histórica de app._confirm para no tocar los
   * call-sites existentes:
   *
   * @param {string}   title         Título del diálogo.
   * @param {string}   body          Texto descriptivo.
   * @param {string}   confirmLabel  Etiqueta del botón de confirmación.
   * @param {Function} onConfirm     Se ejecuta UNA sola vez al confirmar.
   * @param {Element}  [container]   document.body, o un <dialog> abierto
   *                                 para renderizar por encima de él.
   * @param {Function} [onCancel]    Se ejecuta UNA sola vez al cancelar.
   */
  function confirm(title, body, confirmLabel, onConfirm,
                   container = document.body, onCancel = null) {

    const isBody = container === document.body;
    if (!isBody && getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    /* ── Construcción del DOM (estilos en css/main.css) ───────── */
    const overlay = document.createElement('div');
    overlay.className = 'ui-confirm-overlay' + (isBody ? '' : ' in-container');

    const card = document.createElement('div');
    card.className = 'ui-confirm-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');

    const titleId = 'uic-t-' + Date.now();
    const bodyId  = 'uic-b-' + Date.now();
    card.setAttribute('aria-labelledby', titleId);
    card.setAttribute('aria-describedby', bodyId);

    const danger = DANGER_RE.test(confirmLabel) || DANGER_RE.test(title);
    if (danger) card.classList.add('danger');

    const tEl = document.createElement('div');
    tEl.className = 'ui-confirm-title';
    tEl.id = titleId;
    tEl.textContent = title;

    const bEl = document.createElement('div');
    bEl.className = 'ui-confirm-body';
    bEl.id = bodyId;
    bEl.textContent = body;

    const row = document.createElement('div');
    row.className = 'ui-confirm-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ui-confirm-btn cancel';
    cancelBtn.textContent = 'Cancelar';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'ui-confirm-btn ok' + (danger ? ' danger' : '');
    okBtn.textContent = confirmLabel;

    row.append(cancelBtn, okBtn);
    card.append(tEl, bEl, row);
    overlay.append(card);
    container.append(overlay);

    /* ── Capa 2/3: escudo de captura a nivel de documento ─────── */
    // Mientras el diálogo está abierto: bloquea todo lo que no nazca
    // dentro de la tarjeta. Tras el cierre (`absorbing = true`):
    // bloquea ABSOLUTAMENTE todo hasta que expire la ventana fantasma.
    let absorbing = false;
    const shield = (e) => {
      if (absorbing || !card.contains(e.target)) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }
    };
    SHIELD_EVENTS.forEach(evt =>
      document.addEventListener(evt, shield, { capture: true, passive: false }));

    const releaseShield = () => {
      SHIELD_EVENTS.forEach(evt =>
        document.removeEventListener(evt, shield, { capture: true }));
    };

    /* ── Cierre con garantía de ejecución única ────────────────── */
    const invoker = document.activeElement;   // para restaurar el foco
    let settled = false;

    const close = (confirmed) => {
      if (settled) return;                    // ejecución única garantizada
      settled = true;
      haptic(confirmed ? 14 : 8);

      // Animación de salida; la tarjeta deja de recibir eventos ya.
      absorbing = true;
      overlay.classList.add('closing');

      setTimeout(() => overlay.remove(), EXIT_MS);

      // El escudo sobrevive a la ventana del click fantasma completa.
      setTimeout(() => {
        releaseShield();
        if (typeof app !== 'undefined') app._confirmOpen = false;
        // Restaurar el foco donde estaba antes de abrir el diálogo.
        if (invoker && document.contains(invoker)) {
          try { invoker.focus({ preventScroll: true }); } catch (_) {}
        }
      }, GHOST_CLICK_WINDOW);

      // El callback corre en el siguiente tick, fuera del manejador de
      // eventos, para que cualquier UI que abra no herede este evento.
      setTimeout(() => {
        if (confirmed) onConfirm?.();
        else onCancel?.();
      }, 0);
    };

    /* ── Capa 1: activación de los botones ─────────────────────── */
    // pointerup con preventDefault suprime el click sintetizado en la
    // mayoría de motores; el listener de click queda como respaldo para
    // teclado/escritorio y está protegido por `settled`.
    //
    // GUARDIA DE ARMADO (capa 4): si el toque que ABRIÓ el diálogo
    // genera su click fantasma ~300 ms después y este aterriza SOBRE
    // un botón del diálogo recién pintado, el escudo no lo bloquea
    // (nace "dentro de la tarjeta"). Para activarse, cada botón exige
    // un pointerdown propio POSTERIOR a la apertura. Los clicks de
    // teclado (Enter/Espacio, e.detail === 0) se aceptan siempre.
    const armed = new WeakSet();
    card.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.ui-confirm-btn');
      if (b) armed.add(b);
    }, true);

    const arm = (btn, confirmed) => {
      btn.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        if (!armed.has(btn)) return;        // pointerup huérfano → ignorar
        close(confirmed);
      }, { passive: false });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        // detail === 0 → activación por teclado (sin pointerdown previo).
        if (e.detail !== 0 && !armed.has(btn)) return;   // click fantasma
        close(confirmed);
      });
    };
    arm(cancelBtn, false);
    arm(okBtn, true);

    // Tocar el fondo oscurecido cancela (patrón estándar de modales).
    overlay.addEventListener('pointerup', (e) => {
      if (e.target === overlay) close(false);
    });

    /* ── Teclado: Escape + trampa de foco ──────────────────────── */
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const order = [cancelBtn, okBtn];
        const i = order.indexOf(document.activeElement);
        order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
      }
    });

    // El foco inicial cae en Cancelar: la acción segura por defecto.
    requestAnimationFrame(() => cancelBtn.focus({ preventScroll: true }));
  }

  /**
   * Escudo independiente reutilizable: absorbe TODOS los eventos de
   * puntero/táctiles/click a nivel de documento durante `ms` milisegundos.
   *
   * Úsalo al cerrar programáticamente un modal/diálogo en respuesta a un
   * toque (p. ej. "💾 Guardar" dentro de Ajustes): el click fantasma que
   * el navegador sintetiza ~300 ms después del touchend muere aquí en
   * lugar de aterrizar sobre la hoja que quedó al descubierto.
   *
   * @param {number} [ms]  Duración; por defecto GHOST_CLICK_WINDOW (450 ms).
   * @returns {Function}   Liberación anticipada (idempotente).
   */
  function ghostShield(ms = GHOST_CLICK_WINDOW) {
    const absorb = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };
    SHIELD_EVENTS.forEach(evt =>
      document.addEventListener(evt, absorb, { capture: true, passive: false }));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      SHIELD_EVENTS.forEach(evt =>
        document.removeEventListener(evt, absorb, { capture: true }));
    };
    setTimeout(release, ms);
    return release;
  }

  return { confirm, ghostShield, GHOST_CLICK_WINDOW };
})();
