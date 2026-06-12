const app = {
  DB: {},
  inventory: [],
  gold: 0,
  alignment: '',
  currentPage: 0,
  totalPages: 5,
  activeTalentCat: null,
  currentEditorCat: '',
  scrollPreserve: false,        // persisted: whether to remember scroll per page
  _pageScrolls: {},             // in-memory scroll positions per page index
  cropState: {img:null, x:0, y:0, zoom:1, rot:0, minZoom:.05, isDragging:false, lastX:0, lastY:0, pinch:null, velX:0, velY:0},
  _weaponDmgData: [{formula:'1',name:'Desarmado'},{formula:'1',name:'Desarmado'}],

  /** Estado único del resumen de Equipo de Combate. calc() lo escribe y
      _buildCombatSummary() SOLO lee de aquí — nunca del DOM de otras vistas.
      (La versión anterior raspaba textContent de la vista de edición, y si
      el orden de carga cambiaba, el resumen quedaba rancio.) */
  _combat: {
    ca: 10, armorName: 'Sin Armadura', armorType: 'none', shieldName: 'Sin Escudo',
    w: [
      { name: 'Desarmado', atk: '+0', dmg: '1d4', alert: '' },
      { name: 'Desarmado', atk: '+0', dmg: '1d4', alert: '' },
    ],
  },
  _weaponAtkData: [0, 0],
  _editingCustomItem: null,
  _charLoading: false,   // suppresses _markUnsaved during load/clear
  _finalStats: {FUE:8,DES:8,CON:8,INT:8,SAB:8,CAR:8},  // P1 fix: cached final stat scores
  _finalMods:  {FUE:0,DES:0,CON:0,INT:0,SAB:0,CAR:0},  // P1 fix: cached final modifiers

  init() {
    // ── Event delegation for [data-action] (Mejora 6) ──
    // A single listener dispatches simple no-arg calls to app methods.
    // CSP-friendlier and lighter than dozens of inline onclick handlers.
    document.addEventListener('click', e => {
      // Guard: if a confirm overlay is open (or just closed and is still
      // intercepting the iOS-synthesised click), ignore clicks that don't
      // originate inside it. Prevents tap bleed-through to buttons (e.g.
      // "Guardar") sitting behind the modal.
      if (this._confirmOpen) return;
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const fn = el.getAttribute('data-action');
      if (fn && typeof this[fn] === 'function') this[fn]();
    });

    // Load rules — fallback to DEFAULT_DB if storage is corrupt
    try {
      this.DB = STORAGE.loadRules();
    } catch(e) {
      this.DB = structuredClone(DEFAULT_DB);
    }
    // Init weapon data stores
    this._weaponAtkData = [0, 0];
    // Debounced calc — prevents cascading recalculations during rapid input
    this._debouncedCalc = this._debounce(this.calc, 80);
    // Build home screen
    this.renderHome();
    // Setup alignment for app
    this.buildAlignmentPicker();
    this.setupSwipe();
    this._initDiceSwipe();
    this._setupEscapeKey();
    // Crop wheel zoom (registered once, guarded inside handler)
    const ws = document.getElementById('crop_ws');
    if (ws) ws.addEventListener('wheel', e => this._cropWheel(e), {passive:false});
    this._restoreFontSize();
    this._restoreScrollPreserve();
    this._restorePortraitSettings();
    this._restoreTheme();
    this._restoreBgImages();
    // Long-press repeat on resource +/- buttons
    this._initResLongPress();

    // Mark unsaved on manual resource edits (type directly in cur_pv etc.)
    ['cur_pv','cur_adr','cur_ing','cur_carne'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => this._markUnsaved());
    });

    // Live calc on notes changes
    const notes = document.getElementById('char_notes');
    if (notes) notes.addEventListener('input', () => this._markUnsaved());
    const concept = document.getElementById('char_concept');
    if (concept) concept.addEventListener('input', () => this._markUnsaved());
  },

  showScreen(id) {
    document.getElementById('home-screen').classList.toggle('hidden', id !== 'home');
    document.getElementById('app-screen').classList.toggle('hidden', id !== 'app');

    // ── iOS fix: reset pages-track to page 0 with no transition whenever
    // we leave the app screen.  A non-zero translateX on a will-change:transform
    // ancestor creates a new stacking context that shifts position:fixed children
    // (including #home-screen) on iOS Safari.
    if (id === 'home') {
      const track = document.getElementById('pages_track');
      if (track) {
        track.style.transition = 'none';
        track.style.transform  = 'translateX(0)';
      }
      this.currentPage = 0;
      document.querySelectorAll('.nbtn').forEach((b, i) => b.classList.toggle('active', i === 0));
    }

    // Limpiar el listener de cierre de swipe cuando salimos de la home,
    // para evitar que se acumulen listeners en document con cada visita.
    if (id !== 'home') {
      const el = document.getElementById('home-roster');
      if (el?._swipeCloseHandler) {
        document.removeEventListener('touchstart', el._swipeCloseHandler);
        el._swipeCloseHandler = null;
      }
    }
  },

  goHome() {
    const name = document.getElementById('char_name')?.value?.trim();
    const lbl  = document.getElementById('last_saved_lbl');
    const hasUnsaved = lbl?.classList.contains('unsaved');
    if (name && hasUnsaved) {
      this._confirm('¿Salir sin guardar?', `"${this._esc(name)}" tiene cambios sin guardar. Se perderán.`, '✓ Salir', () => {
        this.renderHome(); this.showScreen('home');
      });
    } else {
      this.renderHome(); this.showScreen('home');
    }
  },

  newChar() {
    this._charLoading = true;
    this.clearCharData();
    // Pre-reset track before showing app screen (same iOS fix as loadCharToApp)
    const track = document.getElementById('pages_track');
    if (track) { track.style.transition = 'none'; track.style.transform = 'translateX(0)'; }
    this.currentPage = 0;
    this.showScreen('app');
    this.unlockApp();
    this.goToPage(0);
    this._pageScrolls = {}; // limpiar posiciones guardadas obsoletas
    // Abrir todas las secciones en edición para flujo de creación.
    // _bulkEditing suprime el scrollIntoView de combat/equipment para que
    // el goToPage(0) de arriba no pierda la carrera contra el RAF.
    this._bulkEditing = true;
    this.editSection('personal');
    this.editSection('identity');
    this.editSection('stats');
    this.editSection('saves');
    this.editSection('skills');
    this.editSection('combat');
    this.editSection('equipment');
    this._bulkEditing = false;
    this._charLoading = false;
    // Clear header label for fresh character
    const lbl = document.getElementById('last_saved_lbl');
    if (lbl) { lbl.textContent = ''; lbl.className = 'last-saved'; }
    // Enfocar el campo nombre automáticamente
    requestAnimationFrame(() => {
      const nameInput = document.getElementById('char_name');
      if (nameInput) nameInput.focus();
    });
  },

  loadCharToApp(name) {
    const roster = STORAGE.loadRoster();
    const data = roster[name];
    if (!data) return;
    this._charLoading = true;
    this.clearCharData();
    // Reset track to page 0 with no transition BEFORE making app-screen visible.
    // This prevents the iOS stacking-context bug where a non-zero translateX
    // on the will-change:transform track shifts position:fixed elements.
    const track = document.getElementById('pages_track');
    if (track) { track.style.transition = 'none'; track.style.transform = 'translateX(0)'; }
    this.currentPage = 0;
    this.showScreen('app');
    this.unlockApp();
    this.applyCharData(data);
    this.goToPage(0);
    // Clear last-saved label and reset unsaved state cleanly
    const lbl = document.getElementById('last_saved_lbl');
    if (lbl) { lbl.textContent = ''; lbl.className = 'last-saved'; }
    this._charLoading = false;
    this.toast(`Cargado: ${this._esc(name)}`, 'ok');
  },

  _esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  },

  /* Strip HTML tags from imported JSON text — prevents XSS from malicious rule files */
  _sanitize(str) {
    return String(str || '').replace(/<[^>]*>/g, '').replace(/javascript:/gi, '');
  },

  /** Renders the saved-character roster on the home screen. */
  renderHome() {
    const el = document.getElementById('home-roster');

    // Clean up previous document-level listener
    if (el._swipeCloseHandler) {
      document.removeEventListener('touchstart', el._swipeCloseHandler);
      el._swipeCloseHandler = null;
    }

    const roster = STORAGE.loadRoster();
    const keys   = Object.keys(roster);

    if (!keys.length) {
      el.innerHTML = `
        <div class="home-empty">
          <div class="home-empty-icon">⚔</div>
          <div class="home-empty-title">Sin personajes guardados</div>
          <div class="home-empty-sub">Crea uno nuevo o importa<br>un archivo JSON para comenzar.</div>
        </div>`;
      return;
    }

    el.innerHTML = '';
    const SNAP = 'transform .2s cubic-bezier(.25,.46,.45,.94)';
    const BTN_W = 80; // must match .char-card-delete width

    keys.forEach((name, i) => {
      const data = roster[name];
      const lvl  = data.inputs?.char_lvl || '1';
      const arq  = data.selects?.sel_arq  ? (this.DB.archetypes?.[data.selects.sel_arq]?.name  || data.selects.sel_arq) : '—';
      const desc = data.selects?.sel_desc ? (this.DB.descriptors?.[data.selects.sel_desc]?.name || '') : '';
      const bg   = data.selects?.sel_bg   ? (this.DB.backgrounds?.[data.selects.sel_bg]?.name   || '') : '';

      const hasPortrait = data.portrait && data.portrait !== DEFAULT_PORTRAIT && !data.portrait.includes('fill=');
      const portHtml = hasPortrait
        ? `<img class="char-port" src="${data.portrait}" alt="">`
        : `<div class="char-port-ph">⚔</div>`;

      // ── DOM ──────────────────────────────────────────────────────
      const wrap = document.createElement('div');
      wrap.className = 'char-card-wrap';
      wrap.style.animationDelay = `${i * 50}ms`;

      const delBtn = document.createElement('button');
      delBtn.className = 'char-card-delete';
      delBtn.setAttribute('aria-label', `Eliminar ${name}`);
      delBtn.innerHTML = `<span class="del-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></span><span>Borrar</span>`;

      const card = document.createElement('div');
      card.className = 'char-card';
      card.innerHTML = `
        ${portHtml}
        <div class="char-ci">
          <div class="char-cn">${this._esc(name)}</div>
          <div class="char-cs">${this._esc(desc||'—')} · ${this._esc(arq)}${bg?' · '+this._esc(bg):''}</div>
          <div style="margin-top:3px"><span class="char-lvl-badge">Nivel ${this._esc(lvl)}</span></div>
        </div>
        <span class="char-card-arrow">›</span>`;

      wrap.appendChild(delBtn);
      wrap.appendChild(card);
      el.appendChild(wrap);

      // ── Helpers ───────────────────────────────────────────────────
      const setPos = (x, animated) => {
        const t = animated ? SNAP : 'none';
        card.style.transition   = t;
        delBtn.style.transition = t;
        card.style.transform    = `translateX(${x}px)`;
        // delBtn slides in from the right: at x=0 it's at 100%, at x=-BTN_W it's at 0%
        const pct = 100 + (x / BTN_W) * 100;
        delBtn.style.transform  = `translateX(${pct}%)`;
      };

      const reveal  = () => { setPos(-BTN_W, true); card._swiped = true;  };
      const conceal = () => { setPos(0,       true); card._swiped = false; };

      // ── Swipe gesture ─────────────────────────────────────────────
      let startX = 0, startY = 0, curX = 0;
      let axisLocked = false, isHoriz = false;

      card.addEventListener('touchstart', e => {
        const t = e.touches[0];
        startX = curX = t.clientX; startY = t.clientY;
        axisLocked = false; isHoriz = false;
        card.style.transition   = 'none';
        delBtn.style.transition = 'none';
      }, {passive:true});

      card.addEventListener('touchmove', e => {
        const t   = e.touches[0];
        const ddx = t.clientX - startX;
        const ddy = t.clientY - startY;

        if (!axisLocked) {
          if (Math.abs(ddx) < 4 && Math.abs(ddy) < 4) return;
          isHoriz    = Math.abs(ddx) > Math.abs(ddy);
          axisLocked = true;
        }
        if (!isHoriz) return;

        e.preventDefault();
        curX = t.clientX;

        // Clamp: open up to BTN_W, close at 0
        const base = card._swiped ? -BTN_W : 0;
        const raw  = base + (curX - startX);
        const clamped = Math.max(-BTN_W, Math.min(0, raw));
        setPos(clamped, false);
      }, {passive:false});

      card.addEventListener('touchend', () => {
        if (!axisLocked || !isHoriz) return;
        const delta = curX - startX;
        if (card._swiped) {
          // Was open: close if swiped right enough
          delta > 20 ? conceal() : reveal();
        } else {
          // Was closed: open if swiped left enough
          delta < -30 ? reveal() : conceal();
        }
      }, {passive:true});

      // ── Delete action — direct, no confirm dialog ─────────────────
      // Tap the delete button → delete immediately + undo toast
      delBtn.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        this._deleteCharWithUndo(name);
      });

      // ── Open char ─────────────────────────────────────────────────
      card.addEventListener('click', (e) => {
        if (card._swiped) { conceal(); return; }
        this.loadCharToApp(name);
      });
    });

    // Close any open card when touching outside it
    el._swipeCloseHandler = (e) => {
      el.querySelectorAll('.char-card').forEach(c => {
        if (!c._swiped) return;
        if (!c.closest('.char-card-wrap').contains(e.target)) {
          const btn = c.closest('.char-card-wrap').querySelector('.char-card-delete');
          c.style.transition   = SNAP;
          if (btn) btn.style.transition = SNAP;
          c.style.transform    = 'translateX(0)';
          if (btn) btn.style.transform  = 'translateX(100%)';
          c._swiped = false;
        }
      });
    };
    document.addEventListener('touchstart', el._swipeCloseHandler, {passive:true});
  },

  /** Delete character — shows confirm dialog, same pattern as confirmClear. */
  _deleteCharWithUndo(name) {
    this._confirm(
      '¿Eliminar personaje?',
      `"${this._esc(name)}" será eliminado permanentemente.`,
      '✓ Eliminar',
      () => {
        STORAGE.deleteChar(name);
        this.renderHome();
        this.toast(`"${this._esc(name)}" eliminado`, 'ok');
      }
    );
  },

  /* ── CONFIRM HELPER ──
   * @param {string}      title
   * @param {string}      body
   * @param {string}      confirmLabel
   * @param {Function}    onConfirm
   * @param {Element}     [container=document.body]  Pass an open <dialog> when
   *                      calling from inside one so the overlay renders above it.
   */
  _confirm(title, body, confirmLabel, onConfirm, container = document.body, onCancel = null) {
    // Delegado en UI.confirm (js/ui-dialogs.js): diálogo accesible con
    // escudo anti ghost-click — el toque sobre "Confirmar" ya no puede
    // traspasar y activar lo que esté detrás del diálogo.
    this._confirmOpen = true;            // pausa el dispatcher [data-action]
    UI.confirm(title, body, confirmLabel, onConfirm, container, onCancel);
  },

  unlockApp() {
    // Preserve current identity selections before rebuilding selects
    const prevDesc = document.getElementById('sel_desc')?.value || '';
    const prevArq  = document.getElementById('sel_arq')?.value  || '';
    const prevBg   = document.getElementById('sel_bg')?.value   || '';

    this.fillSelect('sel_desc', this.DB.descriptors || {});
    this.fillSelect('sel_arq',  this.DB.archetypes  || {});
    this.fillSelect('sel_bg',   this.DB.backgrounds || {});

    // Restore if the key still exists in the (possibly updated) DB
    const sd = document.getElementById('sel_desc');
    const sa = document.getElementById('sel_arq');
    const sb = document.getElementById('sel_bg');
    if (sd && prevDesc && this.DB.descriptors?.[prevDesc]) sd.value = prevDesc;
    if (sa && prevArq  && this.DB.archetypes?.[prevArq])   sa.value = prevArq;
    if (sb && prevBg   && this.DB.backgrounds?.[prevBg])   sb.value = prevBg;

    this.updateDbSelect();
    this.syncCombatOptions();
    this.initTalentManager();
    // reset=false → keeps skill checkboxes already selected
    this.updateOptions(false);
    this.renderInventory();
  },

  setupSwipe() {
    const w     = document.getElementById('pages_wrapper');
    const track = document.getElementById('pages_track');

    // ── Tuning — matches native iOS/Android feel ──
    const DEAD_PX     = 8;     // px before ANY axis locks (iOS standard)
    const V_BIAS      = 2.2;   // H/V ratio for axis lock (high = vertical wins)
    const MIN_DIST    = 38;    // px minimum travel to count a slow drag
    const FLICK_DIST  = 22;    // px minimum travel to count a fast flick
    const FLICK_VEL   = 0.28;  // px/ms velocity threshold for flick
    const DRAG_RATIO  = 0.30;  // fraction of page width for slow drag commit
    const RUBBER      = 0.12;  // edge resistance (higher = softer bounce)
    const SNAP_MS     = 320;   // ms for snap animation
    const SNAP_EASE   = 'cubic-bezier(.25,.46,.45,.94)'; // iOS ease-out
    const SCROLL_SEL  = '.skill-area,.tms,.dbs,.tmct,.dbct,.mbd,[data-scroll]';

    // ── Velocity window — track last N samples, use peak ──
    const VEL_SAMPLES = 4;
    let velSamples = [];
    const peakVel = () => {
      if (!velSamples.length) return 0;
      return velSamples.reduce((a,b) => Math.abs(a)>Math.abs(b)?a:b, 0);
    };
    const addVelSample = (v) => {
      velSamples.push(v);
      if (velSamples.length > VEL_SAMPLES) velSamples.shift();
    };

    // ── State ──
    let startX=0, startY=0, startT=0, lastX=0, lastT=0;
    let dragging=false, locked=false, totalDist=0;

    // ── Ghost-click suppression ──
    // NOTE: inputs, textareas and selects are always excluded so the user
    // can tap, select text, and position the cursor without interference.
    let _suppress = false;
    const GUARD_EVENTS = ['touchstart','pointerdown','mousedown','click'];
    const _guard = e => {
      if (!_suppress) return;
      if (e.target.closest('input,textarea,select')) return; // never suppress text fields
      e.stopPropagation(); e.preventDefault();
    };
    GUARD_EVENTS.forEach(t => w.addEventListener(t, _guard, {capture:true,passive:false}));
    const suppressFor = (ms = TIMING.SWIPE_SUPPRESS) => {
      _suppress = true; setTimeout(() => { _suppress = false; }, ms);
    };

    const pageW = () => w.clientWidth || window.innerWidth;

    // ── Live drag with rubber-band ──
    const setLive = rawDx => {
      const base   = -this.currentPage * pageW();
      const atEdge = (this.currentPage === 0 && rawDx > 0) ||
                     (this.currentPage === this.totalPages-1 && rawDx < 0);
      track.style.transition = 'none';
      track.style.transform  = `translateX(${base + (atEdge ? rawDx*RUBBER : rawDx)}px)`;
    };

    // ── Snap decision ──
    const decide = (dx, vel) => {
      const pW   = pageW();
      const cur  = this.currentPage;
      const max  = this.totalPages - 1;
      const dist = Math.abs(dx);
      const dir  = dx < 0 ? 1 : -1; // +1 = forward, -1 = back

      const isFlick = Math.abs(vel) >= FLICK_VEL && dist >= FLICK_DIST;
      const isDrag  = dist >= MIN_DIST && dist/pW >= DRAG_RATIO;

      if (isFlick) {
        if (vel < 0 && cur < max) return cur + 1;
        if (vel > 0 && cur > 0)   return cur - 1;
      }
      if (isDrag) {
        if (dir > 0 && cur < max) return cur + 1;
        if (dir < 0 && cur > 0)   return cur - 1;
      }
      return cur;
    };

    // ── Snap to target ──
    const snapTo = target => {
      suppressFor();
      setTimeout(() => track.classList.remove('is-dragging'), TIMING.SWIPE_SUPPRESS);
      this.goToPage(target);
    };

    // ══ TOUCH ══
    w.addEventListener('touchstart', e => {
      if (e.touches.length > 1) return;
      // Never hijack touches that begin on a text field
      if (e.target.closest('input,textarea,select')) return;
      const t = e.touches[0];
      startX = lastX = t.clientX;
      startY = t.clientY;
      startT = lastT = Date.now();
      dragging = false; locked = false;
      totalDist = 0; velSamples = [];
      // Freeze any in-progress snap immediately
      const cur = getComputedStyle(track).transform;
      track.style.transition = 'none';
      track.style.transform  = cur;
      // Only steal focus away from non-text elements (never blur inputs/textareas)
      const focused = w.querySelector(':focus');
      if (focused && !focused.matches('input,textarea,select')) focused.blur();
    }, {passive:true});

    w.addEventListener('touchmove', e => {
      if (!e.cancelable || e.touches.length > 1) return;
      const t  = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (!locked) {
        // Never intercept swipes that started on a text field
        if (e.target.closest('input,textarea,select')) { locked = true; return; }
        if (e.target.closest(SCROLL_SEL)) { locked = true; return; }
        if (Math.abs(dx) < DEAD_PX && Math.abs(dy) < DEAD_PX) return;
        if (Math.abs(dx) > Math.abs(dy) * V_BIAS) {
          locked = true; dragging = true;
          track.classList.add('is-dragging');
        } else {
          locked = true; return;
        }
      }
      if (!dragging) return;
      e.preventDefault();

      const now = Date.now();
      const dt  = Math.max(now - lastT, 1);
      const iv  = (t.clientX - lastX) / dt;
      addVelSample(iv);
      totalDist += Math.abs(t.clientX - lastX);
      lastX = t.clientX; lastT = now;
      setLive(dx);
    }, {passive:false});

    w.addEventListener('touchend', e => {
      track.classList.remove('is-dragging');
      if (!dragging) { dragging=false; locked=false; velSamples=[]; return; }
      const dx = e.changedTouches[0].clientX - startX;
      const vel = peakVel();
      dragging = false; locked = false;
      snapTo(decide(dx, vel));
    }, {passive:true});

    w.addEventListener('touchcancel', () => {
      track.classList.remove('is-dragging');
      dragging=false; locked=false; velSamples=[];
      this.goToPage(this.currentPage);
    }, {passive:true});

    // ══ MOUSE ══
    let ms = null;
    w.addEventListener('mousedown', e => {
      if (e.target.closest('input,select,textarea,button,label')) return;
      ms = {x:e.clientX, lx:e.clientX, lt:Date.now(), samples:[], drag:false, dist:0};
      track.style.transition = 'none';
    });
    w.addEventListener('mousemove', e => {
      if (!ms) return;
      if (!ms.drag && Math.abs(e.clientX-ms.x)>8) {
        ms.drag=true; track.classList.add('is-dragging');
      }
      if (ms.drag) {
        const dt=Math.max(Date.now()-ms.lt,1);
        const iv=(e.clientX-ms.lx)/dt;
        ms.samples.push(iv); if(ms.samples.length>VEL_SAMPLES) ms.samples.shift();
        ms.dist += Math.abs(e.clientX-ms.lx);
        ms.lx=e.clientX; ms.lt=Date.now();
        setLive(e.clientX-ms.x);
      }
    });
    const endMouse = cx => {
      track.classList.remove('is-dragging');
      if (!ms) return;
      const {x,drag,samples,dist} = ms; ms=null;
      if (!drag) return;
      const vel = samples.reduce((a,b)=>Math.abs(a)>Math.abs(b)?a:b, 0);
      snapTo(decide(cx-x, vel));
    };
    w.addEventListener('mouseup',    e=>endMouse(e.clientX));
    w.addEventListener('mouseleave', e=>endMouse(e.clientX));

    // ══ RESIZE/ROTATION ══
    const _reSnap = this._debounce(() => {
      if (document.getElementById('app-screen')?.classList.contains('hidden')) return;
      track.style.transition='none';
      track.style.transform=`translateX(-${this.currentPage*pageW()}px)`;
    }, 100);
    window.addEventListener('resize',            _reSnap, {passive:true});
    window.addEventListener('orientationchange', _reSnap, {passive:true});
  },
  goToPage(n) {
    if (n !== this.currentPage && navigator.vibrate) navigator.vibrate(4);

    // Save current page's scroll position if preserve mode is on
    if (this.scrollPreserve) {
      const curPage = document.getElementById('page_' + this.currentPage);
      if (curPage) this._pageScrolls[this.currentPage] = curPage.scrollTop;
    }

    this.currentPage = n;
    const w = document.getElementById('pages_wrapper');
    const track = document.getElementById('pages_track');
    const pageW = w ? w.clientWidth : window.innerWidth;
    // Easing: cubic-bezier(.1,.9,.25,1) — snap rápido con deceleration suave
    // Duración 280ms — más ágil sin perder sensación de peso
    track.style.transition = 'transform .22s cubic-bezier(.25,.46,.45,.94)';
    track.style.transform  = `translateX(-${n * pageW}px)`;
    document.querySelectorAll('.nbtn').forEach((b,i) => b.classList.toggle('active', i===n));
    if (n === 4) this.buildDetailPage();
    if (n === 2) this.buildAptitudesPage();

    const destPage = document.getElementById('page_' + n);
    if (destPage) {
      if (this.scrollPreserve && this._pageScrolls[n] !== null && this._pageScrolls[n] !== undefined) {
        // Restore saved scroll position after the transition settles
        const saved = this._pageScrolls[n];
        requestAnimationFrame(() => { destPage.scrollTop = saved; });
      } else {
        destPage.scrollTop = 0;
      }
    }
  },

  editSection(sec) {
    if (sec === 'personal') {
      const ev = document.getElementById('personal_edit_view');
      const sv = document.getElementById('personal_summary_view');
      if (ev) { ev.style.display = 'block'; ev.classList.remove('section-reveal'); void ev.offsetWidth; ev.classList.add('section-reveal'); }
      if (sv) sv.style.display = 'none';
      // Restore alignment button active state
      if (this.alignment) this._syncAlignmentUI();
    } else {
      const ev = document.getElementById(`${sec}_edit_view`);
      const sv = document.getElementById(`${sec}_summary_view`);
      if (ev) { ev.style.display = 'block'; ev.classList.remove('section-reveal'); void ev.offsetWidth; ev.classList.add('section-reveal'); }
      if (sv) sv.style.display = 'none';
      // Show panel header only while in edit mode for identity
      if (sec === 'identity') ev?.closest('.panel')?.classList.add('identity-editing');
      if (sec === 'equipment') { this.updateDbSelect(); this.renderInventory(); }
      // Scroll al panel en page_3 para que sea visible al expandirse.
      // Omitido durante resets en masa (_bulkEditing) para evitar que el RAF
      // se ejecute después de goToPage(0) y desincronice el pages-track.
      if ((sec === 'combat' || sec === 'equipment') && !this._bulkEditing) {
        requestAnimationFrame(() => {
          const panel = ev?.closest('.panel');
          if (panel) panel.scrollIntoView({behavior:'smooth', block:'start'});
        });
      }
    }
  },

  confirmPersonal() {
    this._flashConfirm('personal');
    this._markUnsaved();
    const img = document.getElementById('char_img');
    this._syncPortrait(img?.src);
    const name = document.getElementById('char_name').value || 'Sin nombre';
    const lvl = document.getElementById('char_lvl').value || '1';
    const sno = document.getElementById('sum_name_ov'); if(sno) sno.textContent = name;
    const slo = document.getElementById('sum_lvl_ov'); if(slo) slo.textContent = 'Nivel ' + lvl;
    const sao = document.getElementById('sum_align_ov'); if(sao) sao.textContent = this.alignment || '';
    const sbo = document.getElementById('sum_bio_ov'); if(sbo) sbo.textContent = document.getElementById('char_concept')?.value || '';
    const ev = document.getElementById('personal_edit_view'); if(ev) ev.style.display = 'none';
    const sv = document.getElementById('personal_summary_view'); if(sv) { sv.style.display = 'block'; }
  },

  /** Fires success animation on the confirm button before collapsing the section. */
  _flashConfirm(sec) {
    const ev = document.getElementById(`${sec}_edit_view`);
    const btn = ev?.querySelector('.bcnf');
    if (!btn) return;
    btn.classList.add('success');
    if (navigator.vibrate) navigator.vibrate([6, 40, 10]);
    setTimeout(() => btn.classList.remove('success'), TIMING.CONFIRM_FLASH);
  },

  confirmSection(sec) {
    this._flashConfirm(sec);
    this._markUnsaved();
    // Update summary content then switch views
    if (sec === 'identity') {
      const desc = this.DB.descriptors?.[document.getElementById('sel_desc').value];
      const arq = this.DB.archetypes?.[document.getElementById('sel_arq').value];
      const bg = this.DB.backgrounds?.[document.getElementById('sel_bg').value];
      document.getElementById('sum_desc_badge').textContent = desc?.name || '—';
      document.getElementById('sum_arq_badge').textContent = arq?.name || '—';
      document.getElementById('sum_bg_badge').textContent = bg?.name || '—';
    }
    if (sec === 'stats') this._buildStatsSummary();
    if (sec === 'saves') this._buildSavesSummary();
    if (sec === 'skills') this._buildSkillsSummary();
    if (sec === 'combat') this._buildCombatSummary();
    if (sec === 'equipment') this.renderInventory();

    const ev = document.getElementById(`${sec}_edit_view`);
    const sv = document.getElementById(`${sec}_summary_view`);
    if (ev) ev.style.display = 'none';
    if (sv) sv.style.display = 'block';
    // Hide panel header when collapsing identity section back to summary
    if (sec === 'identity') ev?.closest('.panel')?.classList.remove('identity-editing');

    // combat/equipment viven en page_3. Al colapsar el edit_view el contenido
    // encoge y el scrollTop queda apuntando a zona vacía (pantalla negra).
    // Solución directa: resetear scroll a 0 siempre al confirmar.
    if (sec === 'combat' || sec === 'equipment') {
      const page = document.getElementById('page_3');
      if (page) page.scrollTop = 0;
    }
  },

  _buildStatsSummary() {
    const descKey  = document.getElementById('sel_desc')?.value || '';
    const descMods = this.DB.descriptors?.[descKey]?.mods || {};

    const makeBox = s => {
      const base   = parseInt(this._el('base_'+s)?.value) || 8;
      const dm     = descMods[s] || 0;
      const final  = base + dm;
      const mod    = this.getMod(final);
      const modStr = (mod >= 0 ? '+' : '') + mod;
      const box = document.createElement('div');
      box.className = 'sbox';
      box.addEventListener('click', () => this.rollCheck(s, mod));
      box.innerHTML = `<div class="lbl">${s}</div><div class="mod">${modStr}</div><div class="val">${final}</div>`;
      return box;
    };

    // Render to both the edit-section summary and the live stats display
    ['stats_summary_boxes', 'stats_boxes_display'].forEach(id => {
      const c = this._el(id);
      if (!c) return;
      c.innerHTML = '';
      STATS.forEach(s => c.appendChild(makeBox(s)));
    });
  },

  _buildSavesSummary() {
    const common   = document.querySelector('input[name="save_common"]:checked')?.value;
    const uncommon = document.querySelector('input[name="save_uncommon"]:checked')?.value;
    const prof     = parseInt(this._el('res_prof')?.textContent) || 2;

    // Compute save totals once — shared across both container renders
    const descKey  = this._el('sel_desc')?.value || '';
    const descMods = this.DB.descriptors?.[descKey]?.mods || {};
    const saveData = STATS.map(s => {
      const base   = parseInt(this._el('base_'+s)?.value) || 8;
      const final  = base + (descMods[s] || 0);
      const mod    = this.getMod(final);
      const isProf = (s === common || s === uncommon);
      const total  = mod + (isProf ? prof : 0);
      return { s, total, isProf };
    });

    ['saves_display', 'saves_summary_text'].forEach(id => {
      const c = this._el(id);
      if (!c) return;
      c.innerHTML = '';
      saveData.forEach(({ s, total, isProf }) => {
        const box = document.createElement('div');
        box.className = 'svsbox' + (isProf ? ' prof' : '');
        box.addEventListener('click', () => this.rollCheck('Salvación ' + s, total));
        box.innerHTML = `<span class="svslbl">${s}</span>${total >= 0 ? '+' : ''}${total}`;
        c.appendChild(box);
      });
    });
  },

  _buildSkillsSummary() {
    const selected = Array.from(document.querySelectorAll('input[name="chk_arq"]:checked, input[name="chk_bg"]:checked')).map(el => el.value);
    const unique = [...new Set(selected)];
    const c = this._el('final_skills_list');
    c.innerHTML = '';
    if (!unique.length) { c.innerHTML = '<span style="color:var(--muted);font-size:.8rem;font-style:italic">Sin habilidades.</span>'; return; }
    unique.forEach(sk => {
      const t = document.createElement('span');
      t.className = 'stag';
      t.textContent = sk;
      c.appendChild(t);
    });
  },

  /** Modo lectura de Equipo de Combate — reconstruido desde cero.
      Regenera la vista COMPLETA desde el estado _combat que calc() acaba de
      escribir. Cero lecturas del DOM de otras vistas ⇒ cero posibilidad de
      quedar desincronizado por el orden de carga o renderizado. */
  _buildCombatSummary() {
    const view = this._el('combat_summary_view');
    if (!view) return;
    const c = this._combat;
    const typeLbl = {none:'Sin restricción', light:'Ligera', medium:'Media', heavy:'Pesada'}[c.armorType] || c.armorType;
    const card = (n, role, extraCls) => {
      const w = c.w[n-1] || { name:'Desarmado', atk:'+0', dmg:'1d4', alert:'' };
      return `
      <div class="atk-card${extraCls}">
        <div class="atk-hdr">
          <span class="atk-nm" id="sum_wep${n}_name">${this._esc(w.name)}</span>
          <span class="atk-role-badge">${role}</span>
        </div>
        <div class="atk-stats-line" id="sum_wep${n}_stats">Ataque: ${this._esc(w.atk)} / Daño: ${this._esc(w.dmg)}</div>
        ${w.alert ? `<div class="calert" style="display:block">${this._esc(w.alert)}</div>` : ''}
        <div class="atk-btns">
          <button class="abtn abtn-a" onclick="app.rollWeaponAtk(${n})" aria-label="Tirar ataque arma ${role.toLowerCase()}">
            <span class="abtn-icon">ATK</span>
            <span class="abtn-text"><span class="asub">Atacar</span><span class="aval" id="sum_atk${n}_bonus">${this._esc(w.atk)}</span></span>
          </button>
          <div class="atk-btn-sep"></div>
          <button class="abtn abtn-d" onclick="app.rollWeaponDmg(${n})" aria-label="Tirar daño arma ${role.toLowerCase()}">
            <span class="abtn-icon">DMG</span>
            <span class="abtn-text"><span class="asub">Daño</span><span class="aval" id="sum_atk${n}_dmg">${this._esc(w.dmg)}</span></span>
          </button>
        </div>
      </div>`;
    };
    view.innerHTML = `
      <div class="g3" style="margin-bottom:6px">
        <div class="fbox"><div class="flbl g">CA</div><div class="fval" style="color:var(--goldb);font-size:1.1rem"><span id="sum_ac">${this._esc(String(c.ca))}</span></div></div>
        <div class="fbox"><div class="flbl">Armadura</div><div class="fval" style="font-size:.74rem;flex-direction:column;gap:1px"><span id="sum_armor_name">${this._esc(c.armorName)}</span><span style="font-size:.55rem;color:var(--muted)" id="sum_armor_type">${this._esc(typeLbl)}</span></div></div>
        <div class="fbox"><div class="flbl">Escudo</div><div class="fval" style="font-size:.74rem"><span id="sum_shield">${this._esc(c.shieldName)}</span></div></div>
      </div>
      ${card(1, 'Principal', '')}
      ${card(2, 'Secundaria', ' secondary')}
      <button class="bedit" onclick="app.editSection('combat')">✏ Editar</button>`;
  },

  _getInventoryItem(uid) {
    return this.inventory.find(i => String(i.uid) === String(uid));
  },

  /** uid monotónico para items de inventario. Date.now() a secas colisiona
      cuando se añaden varios items en el mismo milisegundo (randomize,
      toques rápidos) y un uid duplicado hace que _getInventoryItem y los
      <select> de combate resuelvan al item EQUIVOCADO. */
  _uidSeq: 0,
  _nextUid() {
    this._uidSeq = Math.max(this._uidSeq + 1, Date.now());
    return String(this._uidSeq);
  },

  /** Single source of truth for portrait sync — keeps both img elements in step. */
  _syncPortrait(src) {
    const s = src || DEFAULT_PORTRAIT;
    const a = document.getElementById('char_img');
    const b = document.getElementById('char_img_summary');
    if (a) a.src = s;
    if (b) b.setAttribute('src', s);
  },

  /** Shorthand for document.getElementById — used throughout for brevity. */
  _el(id) { return document.getElementById(id); },

  /** Set textContent of element by id, safely no-ops if element is missing. */
  _tc(id, val) { const el = this._el(id); if (el) el.textContent = val; },

  fillSelect(id, data) {
    const s = document.getElementById(id);
    if (!s) return;
    s.innerHTML = '<option value="" disabled selected>— Seleccionar —</option>';
    for (const k in data) {
      const o = document.createElement('option');
      o.value = k; o.textContent = String(data[k].name || k);
      s.appendChild(o);
    }
  },

  getMod(val) {
    // Tabla de modificadores de atributo S&S — NO es floor((val-10)/2)
    // 3→-3 · 4-5→-2 · 6-8→-1 · 9-11→0 · 12-14→+1 · 15-16→+2 · 17-18→+3 · 19-20→+4
    if (val <= 3)  return -3;
    if (val <= 5)  return -2;
    if (val <= 8)  return -1;
    if (val <= 11) return  0;
    if (val <= 14) return +1;
    if (val <= 16) return +2;
    if (val <= 18) return +3;
    return +4; // 19-20+
  },

  // Tabla de XP necesario para subir al siguiente nivel (acumulativo)
  // XP_TABLE is defined as a top-level constant

  updateXpHint() {
    const lvl  = parseInt(document.getElementById('char_lvl')?.value) || 1;
    const xp   = parseInt(document.getElementById('char_xp')?.value)  || 0;
    const lbl  = document.getElementById('xp_next_lbl');
    const bar  = document.getElementById('xp_bar_fill');
    const barW = document.getElementById('xp_bar_wrap');
    if (lvl >= 10) {
      if (lbl) { lbl.textContent = '(máx nivel)'; lbl.style.color = 'var(--gold)'; lbl.style.fontWeight = '700'; }
      if (barW) barW.style.display = 'none';
      return;
    }
    const need = XP_TABLE[lvl] || 0;
    const prev = lvl > 1 ? (XP_TABLE[lvl-1] || 0) : 0;
    const left = need - xp;
    const pct  = need > prev ? Math.min(100, Math.max(0, ((xp - prev) / (need - prev)) * 100)) : 100;
    if (lbl) {
      if (left <= 0) {
        lbl.textContent = '¡Sube de nivel!';
        lbl.style.color = 'var(--sage)';
        lbl.style.fontWeight = '700';
      } else {
        lbl.textContent = `(faltan ${left.toLocaleString('es')})`;
        lbl.style.color = left < need * 0.2 ? 'var(--gold)' : 'var(--muted)';
        lbl.style.fontWeight = '';
      }
    }
    if (bar)  bar.style.width = pct + '%';
    if (barW) barW.style.display = lvl < 10 ? '' : 'none';
  },

  buildAlignmentPicker() {
    const c = document.getElementById('align_sel');
    if (!c || c.dataset.built) return; // idempotente — construir una sola vez
    c.dataset.built = '1';
    ALIGNMENTS.forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'aopt'; btn.textContent = a;
      btn.dataset.ali = a;
      // preventDefault en mousedown evita que el botón robe el foco
      // y que el outline dorado de :focus-visible aparezca en el campo anterior
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        this.alignment = a;
        this._syncAlignmentUI();
      });
      c.appendChild(btn);
    });
  },

  /** Sincroniza los botones .aopt con this.alignment (fuente única de verdad). */
  _syncAlignmentUI() {
    document.querySelectorAll('.aopt').forEach(b =>
      b.classList.toggle('active', b.dataset.ali === this.alignment)
    );
    // Update feedback label
    const fb    = document.getElementById('align_feedback');
    const fbTxt = document.getElementById('align_feedback_txt');
    if (fb && fbTxt) {
      if (this.alignment) {
        fbTxt.textContent = this.alignment;
        fb.style.opacity  = '1';
      } else {
        fb.style.opacity  = '0';
      }
    }
  },

  /** Rebuilds dependent selects (filo, skills, traits) after identity changes. */
  updateOptions(reset=false) {
    if (!this.DB.archetypes) return;
    const descKey = document.getElementById('sel_desc').value;
    const arqKey = document.getElementById('sel_arq').value;
    const bgKey = document.getElementById('sel_bg').value;
    const desc = this.DB.descriptors?.[descKey];
    const arq = this.DB.archetypes?.[arqKey];
    const bg = this.DB.backgrounds?.[bgKey];

    // Info boxes
    document.getElementById('desc_info').textContent = desc ? (desc.bonus||'') + (desc.grant?.length?' · '+desc.grant.join(', '):'') : '';
    document.getElementById('arq_info').textContent = arq ? `PV base: ${arq.pv}+CON · Adr: FUE/DES+Niv+${arq.adr_bonus||0} · Ing: INT/SAB/CAR+Niv+${arq.ing_bonus||0} · Skills: ${arq.skills_count||2}` : '';
    document.getElementById('bg_info').textContent = bg ? `Habilidades: ${bg.skills?.join(', ')||'—'}${bg.defecto?' · '+bg.defecto:''}` : '';

    // Filo select
    const filoSel = document.getElementById('sel_filo');
    const curFilo = filoSel.value;
    filoSel.innerHTML = '<option value="">— Sin filo —</option>';
    if (arq?.edges) {
      arq.edges.forEach(e => {
        const o = document.createElement('option');
        o.value = e; o.textContent = e;
        filoSel.appendChild(o);
      });
      if (arq.edges.includes(curFilo)) filoSel.value = curFilo;
    }

    // Skills
    // Antes de reconstruir, leer y guardar la selección actual en _skillsSel
    // para que no se pierda cuando updateOptions reconstruye el DOM.
    if (reset) {
      this._skillsSel = { arq: new Set(), bg: new Set() };
    } else {
      // Preservar el estado actual del DOM si existe, o usar _skillsSel guardado
      const curArq = Array.from(document.querySelectorAll('input[name="chk_arq"]:checked')).map(e=>e.value);
      const curBg  = Array.from(document.querySelectorAll('input[name="chk_bg"]:checked')).map(e=>e.value);
      if (curArq.length || curBg.length) {
        this._skillsSel = { arq: new Set(curArq), bg: new Set(curBg) };
      } else if (!this._skillsSel) {
        this._skillsSel = { arq: new Set(), bg: new Set() };
      }
    }

    const buildSkills = (containerId, skills, name, limit) => {
      const div = document.getElementById(containerId);
      if (!div) return;
      const saved = name === 'chk_arq' ? this._skillsSel.arq : this._skillsSel.bg;
      div.innerHTML = '';
      (skills || []).forEach(s => {
        const lbl = document.createElement('label');
        lbl.className = 'skill-opt';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.name = name;
        chk.value = s;
        chk.addEventListener('change', () => {
          app.checkLimit(name, limit);
          // Mantener _skillsSel sincronizado con el DOM
          const set = name === 'chk_arq' ? this._skillsSel.arq : this._skillsSel.bg;
          if (chk.checked) set.add(s); else set.delete(s);
          app.calc();
        });
        if (saved.has(s)) chk.checked = true;
        lbl.appendChild(chk);
        lbl.append(' ' + s);
        div.appendChild(lbl);
      });
    };
    const arqLimit = arq?.skills_count || 2;
    const limitEl = document.getElementById('limit_arq'); if(limitEl) limitEl.textContent = arqLimit;
    buildSkills('skills_arq', arq?.skills, 'chk_arq', arqLimit);
    buildSkills('skills_bg', bg?.skills, 'chk_bg', 2);

    // Traits
    const tl = document.getElementById('traits_list');
    tl.innerHTML = '';
    const grants = [...(desc?.grant||[]), ...(bg?.grant||[])];
    grants.forEach(g => {
      const b = document.createElement('span');
      b.className = 'tbadge'; b.textContent = '✦ '+g;
      tl.appendChild(b);
    });

    this.calc();
  },

  checkLimit(name, limit) {
    const checked = Array.from(document.querySelectorAll(`input[name="${name}"]:checked`));
    if (checked.length > limit) {
      const removed = checked[checked.length-1];
      removed.checked = false;
      // Parpadeo visual en la label del checkbox removido
      const lbl = removed.closest('label');
      if (lbl) {
        lbl.style.transition = 'background .1s';
        lbl.style.background = 'rgba(176,48,64,.18)';
        setTimeout(() => { lbl.style.background = ''; }, TIMING.SKILL_FLASH);
      }
      this.toast(`Máximo ${limit} habilidades`,'err');
    }
  },

  /** Recalculates all derived stats and updates the DOM. Called on any input change. */
  calc() {
    // Local alias for readability within this dense function (mirrors this._el)
    const $ = id => document.getElementById(id);
    // Read base stat values
    const raw = {};
    STATS.forEach(s => raw[s] = parseInt($('base_'+s)?.value)||8);

    // Descriptor mods
    const descKey = $('sel_desc').value;
    const desc = this.DB.descriptors?.[descKey];
    const final = {...raw};
    if (desc?.mods) Object.entries(desc.mods).forEach(([k,v]) => final[k]=(final[k]||0)+v);

    const mods = {};
    STATS.forEach(s => mods[s] = this.getMod(final[s]));

    // Cache final stats for helpers (calcInventory, _calcWeapon) — P1 bug fix
    this._finalStats = {...final};
    this._finalMods  = {...mods};

    // Archetype
    const arqKey = $('sel_arq').value;
    const arq = this.DB.archetypes?.[arqKey];
    const lvl = parseInt($('char_lvl')?.value)||1;
    this.updateXpHint();
    const prof = (PROF_THRESHOLDS.find(([min]) => lvl >= min) ?? [1,2])[1];

    // Resources — fórmulas según tabla de Arquetipos (Cap.II Paso 3)
    // PV Nivel 1: base_arquetipo + Puntuación CON
    // PV Nivel 2+: resultado nivel 1 + MOD_CON por cada nivel adicional
    const conScoreForPV = final.CON || 8;
    const pvNivel1 = (arq?.pv||6) + conScoreForPV;
    const lethBonus = (this.lethality||1) - 1; // extra PV per level above 1
    const maxPv = pvNivel1 + ((mods.CON + lethBonus) * Math.max(0, lvl - 1));
    // Adrenalina: max(Puntuación FUE, Puntuación DES) + Nivel + bonus
    const adrScore = Math.max(final.FUE||8, final.DES||8);
    const maxAdr = adrScore + lvl + (arq?.adr_bonus||0);
    // Ingenio: max(Puntuación INT, Puntuación SAB, Puntuación CAR) + Nivel + bonus
    const ingScore = Math.max(final.INT||8, final.SAB||8, final.CAR||8);
    let maxIng = ingScore + lvl + (arq?.ing_bonus||0);

    // Talent bonuses (v5.2): Despertar Sobrenatural otorga +6 Ingenio permanente.
    // Iniciado Místico abre el Canal pero NO suma Ingenio. La Afinidad Mística
    // Innata de ciertos Descriptores suma +3 si se elige (no automática).
    const hasTalent = (id) => !!document.querySelector(`input[name="chk_talents_hidden"][data-id="${id}"]`);
    if (hasTalent('despertar_sobrenatural') || hasTalent('despertar')) maxIng += 6;
    if (hasTalent('poderio_arcano')) maxIng += 0; // Poderío no añade Ingenio base

    $('max_pv').textContent = maxPv;
    $('max_adr').textContent = Math.max(0, maxAdr);
    $('max_ing').textContent = Math.max(0, maxIng);
    $('res_prof').textContent = '+'+prof;

    // Filo
    const filoVal = $('sel_filo').value;
    $('res_filo_val').textContent = filoVal || '—';

    // Iniciativa
    let ini = mods.DES;
    if (hasTalent('alerta')) ini += 5;
    $('res_ini').textContent = (ini>=0?'+':'')+ini;

    // Velocidad
    const spd = arq?.speed || 30;
    $('res_vel').textContent = spd+' pies';

    // Flesh/Carne = puntuación de CON (el número, no el modificador)
    const conScore = parseInt($('base_CON')?.value)||8;
    const carneVal = conScore + (desc?.mods?.CON||0);
    $('res_carne').textContent = carneVal;

    // CA
    const armorUID = $('sel_armor').value;
    const shieldUID = $('sel_shield').value;
    const magicBonus  = parseInt($('sel_magic_bonus')?.value)||0;
    const otherBonus  = parseInt($('sel_ca_other')?.value)||0;
    const caMod1Key   = $('ca_mod1')?.value || 'DES';
    const caMod2Key   = $('ca_mod2')?.value || 'NONE';
    const caMod3Key   = $('ca_mod3')?.value || 'NONE';
    let armorItem = this._getInventoryItem(armorUID);
    let armorData = armorItem ? (armorItem.dbData || this.DB.armors?.[armorItem.dbKey]) : this.DB.armors?.[armorUID];
    const shieldItem = this._getInventoryItem(shieldUID);
    let shieldData = shieldItem ? (shieldItem.dbData || this.DB.shields?.[shieldItem.dbKey]) : this.DB.shields?.[shieldUID];
    // Items sin datos de juego: conservar el NOMBRE elegido por el jugador
    // (con los mismos números que antes: CA 10 / bono 0) en lugar de mostrar
    // "Sin Armadura/Escudo" mientras el select dice otra cosa.
    if (!armorData && armorItem)   armorData  = { name: armorItem.name + ' (sin datos)',  ca: 10, type: 'none' };
    if (!shieldData && shieldItem) shieldData = { name: shieldItem.name + ' (sin datos)', bonus: 0 };

    let caBase = armorData?.ca || 10;
    const armorType = armorData?.type || 'none';
    let caFinal = caBase;

    // Primary MOD (respects armor type cap)
    const getMod1 = (k) => k === 'NONE' ? 0 : (mods[k] || 0);
    if (armorType === 'heavy') {
      // heavy: no attribute bonus
    } else if (armorType === 'medium') {
      caFinal += Math.min(2, getMod1(caMod1Key));
    } else {
      caFinal += getMod1(caMod1Key);
    }
    // Extra mods (no cap)
    if (caMod2Key !== 'NONE') caFinal += (mods[caMod2Key] || 0);
    if (caMod3Key !== 'NONE') caFinal += (mods[caMod3Key] || 0);

    if (shieldData) caFinal += (shieldData.bonus || 0);
    caFinal += magicBonus;
    caFinal += otherBonus;

    // Defensa Natural talent (override if no armor)
    if (hasTalent('def_nat') && (armorType === 'none')) {
      caFinal = Math.max(caFinal, 10 + (mods.DES||0) + (mods.CON||0));
    }
    $('res_ca').textContent = caFinal;
    $('armor_base_val').textContent = caBase;
    // Estado para el resumen de combate (lo renderiza _buildCombatSummary)
    this._combat.ca = caFinal;
    this._combat.armorName  = armorData?.name  || 'Sin Armadura';
    this._combat.armorType  = armorType;
    this._combat.shieldName = shieldData?.name || 'Sin Escudo';
    const caArmorEl = $('res_ca_armor');
    if (caArmorEl) caArmorEl.textContent = armorData?.name || 'Sin armadura';

    // Armor desc
    const adesc = $('armor_desc');
    if (adesc) adesc.textContent = armorData ? `${armorData.name} · CA ${caBase} · ${({none:'Sin restricción',light:'Ligera',medium:'Media',heavy:'Pesada'}[armorType]||armorType)}` : '';

    // Weapons
    this._calcWeapon('w1', $('sel_weapon').value, $('w1_attr').value, $('w1_dmg_attr')?.value||'FUE', mods, prof, arq);
    this._calcWeapon('w2', $('sel_weapon_sec').value, $('w2_attr').value, $('w2_dmg_attr')?.value||'FUE', mods, prof, arq);

    // Attack panel (page 0) sync
    ['1','2'].forEach(n => {
      const atkEl = document.getElementById(`atk_bonus_${n}`);
      const dmgEl = document.getElementById(`atk_dmg_${n}`);
      const st    = this._combat.w[n-1];
      if (atkEl && st) atkEl.textContent = st.atk;
      if (dmgEl && st) dmgEl.textContent = st.dmg;
    });

    // Encumbrance
    const inv = this.calcInventory();
    $('res_carga').textContent = `${inv.current}/${inv.max}`;
    const pct = inv.max > 0 ? Math.min(100, (inv.current/inv.max)*100) : 0;
    const bar = $('carga_bar');
    if (bar) {
      bar.style.width = pct+'%';
      bar.style.background = inv.current > inv.max
        ? 'linear-gradient(90deg,var(--blood),var(--ember))'
        : inv.current >= inv.max * 0.8
          ? 'linear-gradient(90deg,var(--gold),var(--ember))'
          : 'linear-gradient(90deg,var(--gold),var(--goldb))';
    }
    const warn = $('carga_warn');
    warn.style.display = inv.current > inv.max ? 'block' : 'none';
    if ($('load_summary_display'))
      $('load_summary_display').textContent = `${inv.current}/${inv.max}`;

    // Saves display (live)
    this._buildSavesSummary();
    // Stats live display
    this._buildStatsSummary();
    // Resumen de Equipo de Combate (nombres y texto de ataque/daño).
    // Sin esto, applyCharData lo construía vía confirmSection ANTES del
    // recálculo final y quedaba rancio: el chip de tirada (sum_atk*) sí se
    // actualizaba arriba, pero sum_wep*_name decía "Desarmado" y
    // sum_wep*_stats mostraba los valores de desarmado tras cargar.
    this._buildCombatSummary();
  },

  _calcWeapon(wid, uid, attr, dmgAttr, mods, prof, arq) {
    const n = wid === 'w1' ? 1 : 2;
    const weapon = this._getInventoryItem(uid);
    let wData = weapon ? (weapon.dbData || this.DB.weapons?.[weapon.dbKey]) : this.DB.weapons?.[uid];
    const nameEl  = document.getElementById(`atk_name_${n}`);
    const atkEl   = document.getElementById(`${wid}_atk_val`);
    const dmgEl   = document.getElementById(`${wid}_dmg_val`);
    const alertEl = document.getElementById(`${wid}_alert`);

    // Arma del inventario SIN datos de juego (personalizada antigua, o item
    // que perdió dbData en un guardado anterior): respetar la selección del
    // jugador — mostrar SU nombre y atacar como arma genérica 1d4 — en vez
    // de degradar silenciosamente a "Desarmado" mientras el select muestra
    // otra cosa. El aviso guía a definir el daño con el editor ✎.
    let missingData = false;
    if (!wData && weapon && weapon.type === 'weapons') {
      missingData = true;
      wData = { name: weapon.name, dmg: weapon.dmg || '1d4', atk_bonus: 0 };
    }

    if (!wData || uid === 'unarmed') {
      if (nameEl) nameEl.textContent = 'Desarmado';
      if (atkEl)  atkEl.textContent = (mods[attr]>=0?'+':'')+mods[attr];
      if (dmgEl)  dmgEl.textContent = '1d4';
      if (alertEl) alertEl.textContent = '';
      // Mantener la caché de tiradas coherente con lo mostrado: antes este
      // return dejaba el bono del arma ANTERIOR en _weaponAtkData y el botón
      // de ataque tiraba con valores rancios que no coincidían con el texto.
      if (!this._weaponAtkData) this._weaponAtkData = [0, 0];
      this._weaponAtkData[n-1] = mods[attr] || 0;
      this._weaponDmgData[n-1] = {formula:'1d4', name:'Desarmado', dmgMod:0, dmgModStr:''};
      this._combat.w[n-1] = { name: 'Desarmado',
        atk: (mods[attr]>=0?'+':'')+(mods[attr]||0), dmg: '1d4', alert: '' };
      return;
    }

    if (nameEl) nameEl.textContent = wData.name;
    const attrMod = mods[attr] || 0;
    const atkBonus = attrMod + prof + (wData.atk_bonus||0);
    // Store for rollWeaponAtk — avoids DOM race conditions
    if (!this._weaponAtkData) this._weaponAtkData = [0, 0];
    this._weaponAtkData[n-1] = atkBonus;
    if (atkEl) atkEl.textContent = (atkBonus>=0?'+':'')+atkBonus;

    // Damage mod from chosen attribute (NONE = 0)
    const dmgMod = (dmgAttr && dmgAttr !== 'NONE') ? (mods[dmgAttr] || 0) : 0;
    const dmgModStr = dmgMod > 0 ? `+${dmgMod}` : dmgMod < 0 ? `${dmgMod}` : '';
    const baseDmg = wData.dmg || '1d4';
    if (dmgEl) dmgEl.textContent = baseDmg + dmgModStr;

    // Store for rollDice: formula includes modifier as static bonus
    const formulaWithMod = dmgMod !== 0
      ? `${baseDmg}${dmgMod >= 0 ? '+' : ''}${dmgMod}`
      : baseDmg;
    this._weaponDmgData[n-1] = {formula: formulaWithMod, name: wData.name, dmgMod, dmgModStr};

    // Requirements — use final attribute scores (includes descriptor bonuses)
    const fueFinal = this._finalStats?.FUE ?? (parseInt(document.getElementById('base_FUE')?.value)||8);
    const desFinal = this._finalStats?.DES ?? (parseInt(document.getElementById('base_DES')?.value)||8);
    let alert = '';
    if (missingData) alert = '⚠ Sin datos de arma — daño 1d4 genérico. Edítala (✎) en Equipo para definirlos';
    if (wData.req_FUE > 0 && fueFinal < wData.req_FUE) alert += `${alert?' · ':''}⚠ Requiere FUE ${wData.req_FUE}`;
    if (wData.req_DES > 0 && desFinal < wData.req_DES) alert += `${alert?' · ':''}⚠ Requiere DES ${wData.req_DES}`;
    if (alertEl) alertEl.textContent = alert;
    this._combat.w[n-1] = { name: wData.name,
      atk: (atkBonus>=0?'+':'')+atkBonus, dmg: baseDmg + dmgModStr, alert };
  },

  onWeaponChange(wid) {
    const uid = document.getElementById(wid==='w1'?'sel_weapon':'sel_weapon_sec').value;
    const attrSel    = document.getElementById(wid==='w1'?'w1_attr':'w2_attr');
    const dmgAttrSel = document.getElementById(wid==='w1'?'w1_dmg_attr':'w2_dmg_attr');
    const wItem = this._getInventoryItem(uid);
    const wData = wItem ? (wItem.dbData||this.DB.weapons?.[wItem.dbKey]) : this.DB.weapons?.[uid];
    // Auto-select atk attribute for ranged
    if (wData?.type === 'ranged') {
      if (attrSel?.value === 'FUE') attrSel.value = 'DES';
      if (dmgAttrSel?.value === 'FUE') dmgAttrSel.value = 'DES';
    }
    this.calc();
  },

  updateDbSelect() {
    const cat = document.getElementById('inv_db_category')?.value;
    const sel = document.getElementById('inv_db_item');
    if (!sel) return;
    sel.innerHTML = '';
    const data = this.DB[cat] || {};
    Object.entries(data).forEach(([k,v]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = v.name;
      sel.appendChild(o);
    });
  },

  addFromDB() {
    const cat = document.getElementById('inv_db_category').value;
    const key = document.getElementById('inv_db_item').value;
    if (!key) return;
    const data = this.DB[cat]?.[key];
    if (!data) return;
    const item = {
      uid: this._nextUid(),
      name: data.name,
      slots: data.slots || 1,
      type: cat === 'shields' ? 'shields' : cat,
      dbKey: key,
      dbData: data
    };
    this.inventory.push(item);
    this.renderInventory();
    this.syncCombatOptions();
    this.calc();
    this.toast(`${data.name} añadido`,'ok');
  },

  addCustomItem() {
    this._openCustomItemForm(null);
  },

  _openCustomItemForm(idx) {
    this._editingCustomItem = idx;
    const existing = idx !== null ? this.inventory[idx] : null;
    // Datos de juego actuales del item (dbData propio, o su entrada de la DB)
    const gd = existing
      ? (existing.dbData || this.DB[existing.type]?.[existing.dbKey] || {})
      : {};
    const overlay = document.createElement('div');
    overlay.id = 'custom_item_overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:var(--rl);width:100%;max-width:340px;padding:16px">
        <div style="font-family:var(--fd);color:var(--gold);font-size:.82rem;text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px">${idx!==null?'Editar':'Nuevo'} Objeto</div>
        <div style="margin-bottom:8px"><span class="fl">Nombre</span><input type="text" id="ci_name" value="${this._esc(existing?.name||'')}" placeholder="Nombre del objeto"></div>
        <div class="g2" style="gap:6px;margin-bottom:8px">
          <div><span class="fl">Slots</span><input type="number" id="ci_slots" value="${existing?.slots||1}" min="0" max="20"></div>
          <div><span class="fl">Tipo</span><select id="ci_type" onchange="app._syncCustomItemFields()">
            <option value="misc"${(!existing||existing.type==='misc')?' selected':''}>Miscelánea</option>
            <option value="weapons"${existing?.type==='weapons'?' selected':''}>Arma</option>
            <option value="armors"${existing?.type==='armors'?' selected':''}>Armadura</option>
            <option value="shields"${existing?.type==='shields'?' selected':''}>Escudo</option>
          </select></div>
        </div>
        <div id="ci_weapon_fields" class="g2" style="gap:6px;margin-bottom:8px;display:none">
          <div><span class="fl">Daño (ej. 1d8)</span><input type="text" id="ci_dmg" value="${this._esc(gd.dmg||'1d4')}" placeholder="1d4" inputmode="text" autocapitalize="off"></div>
          <div><span class="fl">Bono ataque</span><input type="number" id="ci_atkb" value="${gd.atk_bonus||0}" min="-5" max="10"></div>
        </div>
        <div id="ci_armor_fields" class="g2" style="gap:6px;margin-bottom:8px;display:none">
          <div><span class="fl">CA base</span><input type="number" id="ci_ca" value="${gd.ca||11}" min="8" max="20"></div>
          <div><span class="fl">Categoría</span><select id="ci_armor_type">
            <option value="light"${(!gd.type||gd.type==='light')?' selected':''}>Ligera</option>
            <option value="medium"${gd.type==='medium'?' selected':''}>Media</option>
            <option value="heavy"${gd.type==='heavy'?' selected':''}>Pesada</option>
          </select></div>
        </div>
        <div id="ci_shield_fields" style="margin-bottom:8px;display:none">
          <span class="fl">Bono de CA</span><input type="number" id="ci_shield_bonus" value="${gd.bonus??1}" min="0" max="5">
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-g" style="flex:1" onclick="document.getElementById('custom_item_overlay').remove()">Cancelar</button>
          <button class="btn btn-p" style="flex:1" data-action="saveCustomItem">✓ Guardar</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    this._syncCustomItemFields();
  },

  /** Muestra los campos de datos de juego que correspondan al tipo elegido. */
  _syncCustomItemFields() {
    const type = document.getElementById('ci_type')?.value;
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('ci_weapon_fields', type === 'weapons');
    show('ci_armor_fields',  type === 'armors');
    show('ci_shield_fields', type === 'shields');
  },

  saveCustomItem() {
    const name = document.getElementById('ci_name')?.value?.trim();
    if (!name) { this.toast('Se requiere nombre','err'); return; }
    const slots = parseInt(document.getElementById('ci_slots')?.value)||1;
    const type = document.getElementById('ci_type')?.value||'misc';
    const isEdit = this._editingCustomItem !== null;
    const existing = isEdit ? this.inventory[this._editingCustomItem] : null;
    // PRESERVAR la identidad y los datos del item al editar. La versión
    // anterior reconstruía {uid,name,slots,type} y DESTRUÍA dbKey/dbData:
    // un arma equipada que se editaba (aunque solo fuera el nombre) perdía
    // sus datos de juego y pasaba a calcularse como "Desarmado" pese a
    // seguir seleccionada como Principal/Secundaria.
    const item = { ...(existing || {}), uid: existing?.uid ?? this._nextUid(), name, slots, type };
    // Datos de juego según tipo, partiendo de los previos (conserva extras
    // de la DB como req_FUE) y aplicando lo editado en el formulario.
    const prevData = existing ? (existing.dbData || this.DB[existing.type]?.[existing.dbKey] || {}) : {};
    if (type === 'weapons') {
      const dmgRaw = document.getElementById('ci_dmg')?.value?.trim() || '1d4';
      const dmg = /^\d{1,2}d\d{1,3}([+-]\d{1,3})?$/i.test(dmgRaw) ? dmgRaw.toLowerCase() : '1d4';
      if (dmg !== dmgRaw.toLowerCase()) this.toast('Daño inválido — usa el formato 1d8 o 2d6+1. Aplicado 1d4','err');
      item.dbData = { ...prevData, name, dmg, atk_bonus: parseInt(document.getElementById('ci_atkb')?.value)||0 };
    } else if (type === 'armors') {
      item.dbData = { ...prevData, name,
        ca:   parseInt(document.getElementById('ci_ca')?.value)||11,
        type: document.getElementById('ci_armor_type')?.value||'light' };
    } else if (type === 'shields') {
      const sb = parseInt(document.getElementById('ci_shield_bonus')?.value);
      item.dbData = { ...prevData, name, bonus: Number.isNaN(sb) ? 1 : sb };
    } else if (item.dbData) {
      // Cambió a miscelánea: el dbData previo ya no aplica al cálculo.
      item.dbData = { ...prevData, name };
    }
    // El dbKey deja de ser fiable si los datos ya no son los de la DB.
    if (item.dbData && existing?.dbKey && existing.dbData !== item.dbData) delete item.dbKey;
    if (isEdit) this.inventory[this._editingCustomItem] = item;
    else this.inventory.push(item);
    document.getElementById('custom_item_overlay')?.remove();
    this._editingCustomItem = null;
    this.renderInventory();
    this.syncCombatOptions();
    this.calc();
    this.toast(isEdit?'Actualizado':'Añadido','ok');
  },

  removeInvItem(idx) { this.inventory.splice(idx,1); this.renderInventory(); this.syncCombatOptions(); this.calc(); },
  moveInvItem(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= this.inventory.length) return;
    [this.inventory[idx], this.inventory[newIdx]] = [this.inventory[newIdx], this.inventory[idx]];
    this.renderInventory(); this.syncCombatOptions(); this.calc();
  },
  updateInvItem(idx, field, value) {
    if (field==='slots') value = parseInt(value)||0;
    this.inventory[idx][field] = value;
    if (field==='name'||field==='type') this.syncCombatOptions();
    this.calc();
  },
  syncGold(src) {
    if (src === 'edit') this.gold = parseInt(document.getElementById('gold_coins_edit').value) || 0;
    // Update only the gold display elements — no need to re-render the full inventory list
    const gd = document.getElementById('gold_coins_display'); if (gd) gd.textContent = this.gold;
    const ge = document.getElementById('gold_coins_edit');
    if (ge && document.activeElement !== ge) ge.value = this.gold;
    this.calc();
  },

  /** Re-renders the inventory list and summary from this.inventory. */
  renderInventory() {
    const list = document.getElementById('inv_backpack_list');
    if (list) {
      list.innerHTML = '';
      this.inventory.forEach((item, i) => {
        const row = document.createElement('div'); row.className = 'iitem';
        // Type select
        const typeOpts = [{v:'misc',l:'ITEM'},{v:'weapons',l:'ARMA'},{v:'armors',l:'ARMR'},{v:'shields',l:'ESC'}];
        const selEl = document.createElement('select'); selEl.className = 'ityp';
        selEl.setAttribute('aria-label', 'Tipo de ítem');
        typeOpts.forEach(o => { const op = document.createElement('option'); op.value = o.v; op.textContent = o.l; if(item.type===o.v) op.selected = true; selEl.appendChild(op); });
        selEl.addEventListener('change', () => this.updateInvItem(i, 'type', selEl.value));
        // Name input (safe: value, not innerHTML)
        const nameIn = document.createElement('input'); nameIn.type = 'text'; nameIn.className = 'inm';
        nameIn.value = String(item.name || ''); nameIn.setAttribute('aria-label', 'Nombre del ítem');
        nameIn.addEventListener('change', () => this.updateInvItem(i, 'name', nameIn.value));
        // Slots input
        const slotsIn = document.createElement('input'); slotsIn.type = 'number'; slotsIn.className = 'isl';
        slotsIn.value = item.slots || 0; slotsIn.min = 0; slotsIn.max = 20;
        slotsIn.setAttribute('aria-label', 'Espacios del ítem');
        slotsIn.addEventListener('change', () => this.updateInvItem(i, 'slots', slotsIn.value));
        // Action buttons
        const isFirst = i === 0, isLast = i === this.inventory.length - 1;
        const mkBtn = (txt, label, fn, style = '') => {
          const b = document.createElement('button');
          b.className = 'idel';
          b.textContent = txt;
          b.setAttribute('aria-label', label);
          if (style) b.style.cssText = style;
          b.addEventListener('click', fn);
          return b;
        };
        const upBtn   = mkBtn('↑','Mover arriba', () => this.moveInvItem(i,-1), `color:var(--muted);font-size:.7rem;opacity:${isFirst?'0.2':'1'}`);
        const dnBtn   = mkBtn('↓','Mover abajo',  () => this.moveInvItem(i, 1), `color:var(--muted);font-size:.7rem;opacity:${isLast?'0.2':'1'}`);
        const editBtn = mkBtn('✎','Editar ítem',  () => this._openCustomItemForm(i), 'color:var(--dim);font-size:.78rem');
        const delBtn  = mkBtn('×','Eliminar ítem', () => this.removeInvItem(i));
        if (isFirst) upBtn.disabled = true;
        if (isLast)  dnBtn.disabled = true;
        row.appendChild(selEl); row.appendChild(nameIn); row.appendChild(slotsIn);
        row.appendChild(upBtn); row.appendChild(dnBtn); row.appendChild(editBtn); row.appendChild(delBtn);
        list.appendChild(row);
      });
    }
    const sumList = document.getElementById('inv_summary_list');
    if (sumList) {
      sumList.innerHTML = this.inventory.length ? '' : '<div style="font-style:italic;color:var(--muted);text-align:center;padding:8px">Mochila vacía.</div>';
      this.inventory.forEach(item => {
        const row = document.createElement('div'); row.className = 'irow';
        const nm = document.createElement('span'); nm.textContent = String(item.name||'');
        const sl = document.createElement('span'); sl.style.cssText = 'font-family:var(--fm);font-size:.82rem;color:var(--gold)'; sl.textContent = String(item.slots||0);
        row.appendChild(nm); row.appendChild(sl);
        sumList.appendChild(row);
      });
    }
    const gd = document.getElementById('gold_coins_display'); if (gd) gd.textContent = this.gold;
    const ge = document.getElementById('gold_coins_edit'); if (ge && document.activeElement!==ge) ge.value = this.gold;
    // Note: calc() is intentionally NOT called here.
    // renderInventory is always followed by calc() in its callers (addFromDB,
    // saveCustomItem, syncCombatOptions chain, applyCharData, etc.).
    // Calling it here would double-calculate on every inventory operation.
  },

  calcInventory() {
    // Slots = puntuación FUE FINAL (incluye bonificaciones de descriptor) + 5 del Morral gratuito
    // _finalStats se actualiza en calc() antes de llamar calcInventory — siempre es consistente
    const fueFinal = this._finalStats?.FUE ?? (parseInt(document.getElementById('base_FUE')?.value)||8);
    return { current: this.inventory.reduce((s,i)=>s+(i.slots||0),0), max: fueFinal + 5 };
  },

  syncCombatOptions() {
    const prev = {
      armor: document.getElementById('sel_armor')?.value,
      shield: document.getElementById('sel_shield')?.value,
      ca_mod1: document.getElementById('ca_mod1')?.value,
      ca_mod2: document.getElementById('ca_mod2')?.value,
      ca_mod3: document.getElementById('ca_mod3')?.value,
      ca_other: document.getElementById('sel_ca_other')?.value,
      w1_dmg_attr: document.getElementById('w1_dmg_attr')?.value,
      w2_dmg_attr: document.getElementById('w2_dmg_attr')?.value,
      w1: document.getElementById('sel_weapon')?.value,
      w2: document.getElementById('sel_weapon_sec')?.value
    };
    const fill = (id, type, defVal, defTxt) => {
      const s = document.getElementById(id); if (!s) return;
      s.innerHTML = `<option value="${defVal}">${defTxt}</option>`;
      this.inventory.filter(i=>i.type===type).forEach(item => {
        const o = document.createElement('option'); o.value = item.uid; o.textContent = item.name; s.appendChild(o);
      });
    };
    fill('sel_armor','armors','none','Sin Armadura');
    fill('sel_shield','shields','none','Sin Escudo');
    fill('sel_weapon','weapons','unarmed','Desarmado');
    fill('sel_weapon_sec','weapons','unarmed','Desarmado');
    const restore = (id, val) => {
      const s = document.getElementById(id); if (!s) return;
      if (s.querySelector(`option[value="${val}"]`)) s.value = val;
      else s.value = s.options[0]?.value;
    };
    restore('sel_armor',prev.armor); restore('sel_shield',prev.shield);
    restore('ca_mod1',prev.ca_mod1); restore('ca_mod2',prev.ca_mod2); restore('ca_mod3',prev.ca_mod3);
    restore('sel_ca_other',prev.ca_other);
    restore('w1_dmg_attr',prev.w1_dmg_attr); restore('w2_dmg_attr',prev.w2_dmg_attr);
    restore('sel_weapon',prev.w1); restore('sel_weapon_sec',prev.w2);
  },

  rollCheck(label, mod) {
    const d20 = Math.floor(Math.random()*20)+1;
    const total = d20 + mod;
    const isCrit = d20===20, isFail = d20===1;
    const modStr = (mod>=0?'+':'')+mod;
    const detailTxt = `d20: ${d20}  ${modStr !== '+0' ? `(${modStr})` : ''}`;
    this.showDiceRoll({
      label,
      die: 20,
      finalFaces: [d20],   // single d20 as array for consistency
      isCrit, isFail,
      detail: detailTxt,
      total: total,
      totalLabel: 'Total'
    });
  },

  rollDice(formula, label) {
    const match = formula.match(/(\d+)d(\d+)([+-]\d+)?/i);
    if (!match) { this.toast(`${label}: ${formula}`, 'info'); return; }
    const num = parseInt(match[1]), die = parseInt(match[2]), bonus = parseInt(match[3] || 0);
    const rolls = [];
    let total = 0;
    for (let i = 0; i < num; i++) { const r = Math.floor(Math.random() * die) + 1; rolls.push(r); total += r; }
    total += bonus;
    let bonusStr = '';
    if      (bonus > 0) bonusStr = `+${bonus}`;
    else if (bonus < 0) bonusStr = String(bonus);
    // Format mirrors rollCheck: "2d6: [4 + 3]  (+2)"
    const rollsPart = num > 1 ? `[${rolls.join(' + ')}]` : `${rolls[0]}`;
    const detailTxt = `${num}d${die}: ${rollsPart}${bonusStr !== '' ? '  (' + bonusStr + ')' : ''}`;
    this.showDiceRoll({
      label,
      die,
      finalFaces: rolls,       // pass all rolls — overlay shows one face per die
      isCrit: false, isFail: false,
      detail: detailTxt,
      total,
      totalLabel: 'Daño'
    });
  },

  /**
   * Show the dice overlay.
   * @param {object} opts
   * @param {string}   opts.label
   * @param {number}   opts.die          - die type (d6, d20…)
   * @param {number[]} opts.finalFaces   - one value per die (NEW: array)
   * @param {number}   opts.finalFace    - legacy single-die fallback
   * @param {boolean}  opts.isCrit
   * @param {boolean}  opts.isFail
   * @param {string}   opts.detail
   * @param {number}   opts.total
   * @param {string}   opts.totalLabel
   */
  showDiceRoll({label, die, finalFaces, finalFace, isCrit, isFail, detail, total, totalLabel}) {
    // Normalise: support both old finalFace (single) and new finalFaces (array)
    const faces = finalFaces ?? [finalFace ?? 1];
    const numDice = faces.length;

    const overlay   = document.getElementById('dice-overlay');
    const facesRow  = document.getElementById('dice-faces-row');
    const labelEl   = document.getElementById('dice-label');
    const detailEl  = document.getElementById('dice-detail');
    const totalRow  = document.getElementById('dice-total-row');
    const totalEl   = document.getElementById('dice-total');
    const badgeEl   = document.getElementById('dice-badge');
    const hintEl    = document.getElementById('dice-close-btn');

    // ── Reset ──
    overlay.classList.remove('closing');
    detailEl.className  = 'dice-detail';
    totalRow.className  = 'dice-total-row';
    totalEl.className   = 'dice-total';
    badgeEl.style.display = 'none';
    hintEl.className    = 'dice-close-btn';
    detailEl.textContent = '';
    totalEl.textContent  = '';

    // ── Build N die faces ──
    facesRow.innerHTML = '';
    facesRow.className = 'dice-faces-row'
      + (numDice >= 5 ? ' many5' : numDice >= 3 ? ' many' : '');

    const numEls = faces.map((_, i) => {
      if (i > 0) {
        const plus = document.createElement('span');
        plus.className = 'dice-face-plus';
        plus.textContent = '+';
        facesRow.appendChild(plus);
      }
      const face = document.createElement('div');
      face.className = 'dice-face';
      const span = document.createElement('span');
      span.className = 'dice-num';
      span.textContent = Math.floor(Math.random() * die) + 1;
      face.appendChild(span);
      facesRow.appendChild(face);
      return span;
    });

    labelEl.textContent = label;
    overlay.classList.add('active');
    if (navigator.vibrate) navigator.vibrate(12);

    // ── Animate each die, staggered ──
    const TICKS = 7;
    let settled = 0;

    numEls.forEach((numEl, dieIdx) => {
      const finalVal = faces[dieIdx];
      const staggerDelay = dieIdx * 55; // each die starts slightly later

      const doTick = (tick) => {
        numEl.classList.remove('rolling');
        void numEl.offsetWidth;
        numEl.classList.add('rolling');
        if (tick < TICKS) {
          numEl.textContent = Math.floor(Math.random() * die) + 1;
          setTimeout(() => doTick(tick + 1), staggerDelay * (tick === 0 ? 1 : 0) + 35 + tick * 12);
        } else {
          numEl.textContent = finalVal;
          numEl.classList.remove('rolling');
          numEl.classList.add('result-pop');
          // Crit/fail glow only on single d20 rolls
          if (numDice === 1 && isCrit) numEl.classList.add('crit-glow');
          if (numDice === 1 && isFail) numEl.classList.add('fail-glow');
          settled++;
          // Once all dice have settled, show summary
          if (settled === numDice) {
            setTimeout(() => {
              detailEl.textContent = detail;
              detailEl.classList.add('show');
              totalEl.textContent = (total >= 0 && totalLabel !== 'Daño' ? '+' : '') + total;
              if (isCrit) totalEl.classList.add('crit');
              if (isFail) totalEl.classList.add('fail');
              totalRow.classList.add('show');
              if (isCrit) { badgeEl.textContent = '✦ Crítico ✦'; badgeEl.className = 'dice-badge crit'; badgeEl.style.display = ''; }
              if (isFail) { badgeEl.textContent = '☠ Fallo Total ☠'; badgeEl.className = 'dice-badge fail'; badgeEl.style.display = ''; }
              hintEl.classList.add('show');
            }, 160);
          }
        }
      };
      setTimeout(() => doTick(0), staggerDelay);
    });
  },

  closeDiceOverlay() {
    const overlay = document.getElementById('dice-overlay');
    if (!overlay.classList.contains('active')) return;
    overlay.classList.add('closing');
    setTimeout(() => overlay.classList.remove('active','closing'), TIMING.DICE_CLOSE);
  },

  _initDiceSwipe() {
    const card = document.getElementById('dice-card');
    if (!card || card._swipeInit) return;
    card._swipeInit = true;
    let startY = 0, startX = 0;
    card.addEventListener('touchstart', e => { startY = e.touches[0].clientY; startX = e.touches[0].clientX; }, {passive:true});
    card.addEventListener('touchend', e => {
      const dy = e.changedTouches[0].clientY - startY;
      const dx = Math.abs(e.changedTouches[0].clientX - startX);
      if (dy > 55 && dx < 60) this.closeDiceOverlay();
    }, {passive:true});
  },

  rollWeaponAtk(n) {
    // Read from stored calc data (avoids race conditions with DOM updates)
    const stored = this._weaponAtkData?.[n-1];
    const bonus = (stored !== undefined) ? stored : (parseInt(document.getElementById(`atk_bonus_${n}`)?.textContent) || 0);
    this.rollCheck(`Ataque: ${this._weaponDmgData[n-1]?.name||'Arma'}`, bonus);
  },
  rollWeaponDmg(n) { this.rollDice(this._weaponDmgData[n-1]?.formula||'1', `Daño: ${this._weaponDmgData[n-1]?.name||'Arma'}`); },

  adjustRes(curId, maxId, delta) {
    const cur = document.getElementById(curId);
    const max = document.getElementById(maxId);
    if (!cur) return;
    let val = parseInt(cur.value) || 0;
    const maxVal = parseInt(max?.textContent) || 999;
    val = Math.max(0, Math.min(maxVal, val + delta));
    cur.value = val;
    // Flash feedback
    cur.style.transition = 'color .15s';
    cur.style.color = delta > 0 ? 'var(--sage)' : 'var(--blood)';
    // Bump animation
    cur.classList.remove('bump');
    void cur.offsetWidth;
    cur.classList.add('bump');
    setTimeout(() => { cur.style.color = ''; cur.classList.remove('bump'); }, TIMING.RES_FLASH);
    // Haptic feedback on supported devices
    if (navigator.vibrate) navigator.vibrate(8);
    // Mark unsaved
    this._markUnsaved();
  },

  /** Attach long-press repeat behavior to all .res-btn elements.
   *  Called once from init(). Holding fires at 120ms intervals, accelerating.
   *  Reads data-cur / data-max / data-delta attributes — no regex parsing. */
  _initResLongPress() {
    document.querySelectorAll('.res-btn').forEach(btn => {
      const { cur: curId, max: maxId, delta: deltaStr } = btn.dataset;
      // Skip buttons that don't carry the required data attributes
      if (!curId || !maxId || deltaStr === undefined) return;
      const delta = parseInt(deltaStr, 10);

      let _t    = null;
      let active = false;

      const fire = () => this.adjustRes(curId, maxId, delta);

      const start = () => {
        if (active) return;
        active = true;
        fire(); // immediate first fire
        let speed = 350; // initial repeat delay ms
        const tick = () => {
          if (!active) return;
          fire();
          speed = Math.max(TIMING.LONGPRESS_MIN, speed * 0.8); // accelerate: 350→280→224…→60
          _t = setTimeout(tick, speed);
        };
        _t = setTimeout(tick, TIMING.LONGPRESS_HOLD); // hold threshold before repeat starts
      };

      const stop = () => {
        active = false;
        clearTimeout(_t);
        _t = null;
      };

      btn.addEventListener('mousedown',   e => { e.preventDefault(); start(); });
      btn.addEventListener('touchstart',  e => { e.preventDefault(); start(); }, {passive:false});
      btn.addEventListener('mouseup',     stop);
      btn.addEventListener('mouseleave',  stop);
      btn.addEventListener('touchend',    stop);
      btn.addEventListener('touchcancel', stop);
      btn.addEventListener('click',       e => e.preventDefault());
    });
  },

  toast(msg, type = 'info', action = null) {
    const t = { '💾':'ok','ok':'ok','OK':'ok','✦':'ok','Error':'err','error':'err','⚠':'err' }[type] ?? 'info';

    // ── Deduplication: if an identical message is already visible, skip ──
    const containerId = (t === 'err') ? 'toast-ct-err' : 'toast-ct';
    const c = document.getElementById(containerId) || document.getElementById('toast-ct');
    const msgStr = String(msg);
    const existing = Array.from(c.querySelectorAll('.t-msg')).find(el => el.textContent === msgStr);
    if (existing) {
      // Bump opacity to full to give visual feedback that it was triggered again
      const existingToast = existing.closest('.toast');
      if (existingToast) {
        existingToast.style.transition = 'none';
        existingToast.style.opacity = '1';
      }
      return;
    }

    const icon = document.createElement('span');
    icon.className = 't-icon';
    if      (t === 'ok')  { icon.textContent = '✦'; icon.classList.add('gold'); }
    else if (t === 'err') { icon.textContent = '✕'; icon.classList.add('err'); }
    else                  { icon.textContent = '·'; icon.classList.add('dim'); }

    const m = document.createElement('span');
    m.className = 't-msg';
    m.textContent = msgStr;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:9px';
    wrap.appendChild(icon);
    wrap.appendChild(m);

    // Cap visible toasts at 2 in the polite container; 1 in the assertive one
    const cap = (t === 'err') ? 1 : 2;
    while (c.children.length >= cap) c.removeChild(c.firstChild);

    const toast = document.createElement('div');
    toast.className = `toast${t === 'err' ? ' terror' : ''}`;
    // Position the error container identically to the main toast container
    if (t === 'err') {
      toast.style.cssText = 'position:relative;left:auto;transform:none';
    }
    toast.appendChild(wrap);
    // Optional action: make the toast tappable and keep it on screen longer.
    if (typeof action === 'function') {
      toast.style.cursor = 'pointer';
      toast.setAttribute('role', 'button');
      toast.setAttribute('tabindex', '0');
      const fire = () => { try { action(); } catch(e){} toast.remove(); };
      toast.addEventListener('click', fire);
      toast.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } });
    }
    c.appendChild(toast);

    const visibleFor = (typeof action === 'function')
      ? TIMING.TOAST_VISIBLE * 4   // give the user time to act on prompts
      : TIMING.TOAST_VISIBLE;
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = '.3s';
      setTimeout(() => toast.remove(), TIMING.TOAST_FADE);
    }, visibleFor);
  },

  initTalentManager() {
    if (!this.DB.talents) return;
    const cc = document.getElementById('tm_categories'); cc.innerHTML='';
    Object.keys(this.DB.talents).forEach(k => {
      const btn = document.createElement('button'); btn.className='catbtn'; btn.type='button';
      btn.setAttribute('data-cat', k);
      btn.textContent = k.charAt(0).toUpperCase()+k.slice(1);
      btn.addEventListener('click', () => {
        const sb = document.getElementById('tm_search'); if (sb) sb.value = '';
        this.showTalentCategory(k, btn);
      });
      cc.appendChild(btn);
    });
  },

  openTalentManager() {
    if (!this.DB.talents) return;
    this._talentModalOpener = document.activeElement;
    const panel = document.getElementById('talent_panel');
    panel.classList.add('fs-open');
    document.body.style.overflow = 'hidden';
    // Fresh stats for requirement checks; reset search box (keep filter chips sticky)
    this.calc();
    const sb = document.getElementById('tm_search'); if (sb) sb.value = '';
    this._talentFilters = this._talentFilters || { eligible:false, arq:false };
    const ec = document.getElementById('tm_filter_eligible');
    const ac = document.getElementById('tm_filter_arq');
    if (ec) { ec.classList.toggle('active', this._talentFilters.eligible); ec.setAttribute('aria-pressed', String(this._talentFilters.eligible)); }
    if (ac) { ac.classList.toggle('active', this._talentFilters.arq); ac.setAttribute('aria-pressed', String(this._talentFilters.arq)); }
    const firstKey = Object.keys(this.DB.talents)[0];
    if (this.activeTalentCat) {
      const btn = document.querySelector(`#tm_categories .catbtn[data-cat="${this.activeTalentCat}"]`);
      this.showTalentCategory(this.activeTalentCat, btn);
      // Scroll active chip into view on mobile
      requestAnimationFrame(() => btn?.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'}));
    } else if (firstKey) {
      this.showTalentCategory(firstKey, document.querySelector('#tm_categories .catbtn'));
    }
    this.updateTalentCount();
    this._attachPanelSwipeBack(panel, () => this.closeTalentManager());
  },

  closeTalentManager() {
    const panel = document.getElementById('talent_panel');
    panel.style.transform = '';
    panel.style.opacity   = '';
    panel.classList.remove('fs-open');
    document.body.style.overflow = '';
    this.showTalentSummary();
    this.updateTalentCount();
    this.calc();
    if (this._talentModalOpener?.focus) {
      setTimeout(() => { try { this._talentModalOpener?.focus(); } catch(e){} this._talentModalOpener = null; }, 0);
    }
  },

  /* ── Requirement parsing & eligibility (Mejora 2) ──
     Parses free-text `req` like "FUE 13+ · Nivel 5+ · Despertar Sobrenatural"
     into checkable atoms. Returns {atoms:[{kind,attr,val,raw,met}], met:bool,
     unmet:[strings]}. Soft validation — informs, never blocks. */
  _parseTalentReq(reqText) {
    const out = { atoms: [], met: true, unmet: [] };
    if (!reqText) return out;
    // Ensure final stats are available
    const stats = this._finalStats || (() => {
      const s = {}; STATS.forEach(k => s[k] = parseInt(document.getElementById('base_'+k)?.value)||8); return s;
    })();
    const lvl = parseInt(document.getElementById('char_lvl')?.value) || 1;
    // Talents the character currently has (by name + id)
    const haveNames = new Set(
      [...document.querySelectorAll('input[name="chk_talents_hidden"]')].map(h => (h.value||'').toLowerCase())
    );
    const haveIds = new Set(
      [...document.querySelectorAll('input[name="chk_talents_hidden"]')].map(h => h.getAttribute('data-id')).filter(Boolean)
    );
    // Split on · / • first; then split remaining chunks on commas that
    // separate distinct requirements (a comma followed by a Level/attr token),
    // while keeping attribute lists like "INT, SAB o CAR 13+" intact.
    const rawParts = reqText.split(/[·•\u00B7]/).map(p => p.trim()).filter(Boolean);
    const parts = [];
    rawParts.forEach(chunk => {
      // Break "DES 16+, Nv3+" → ["DES 16+","Nv3+"] but not "INT, SAB o CAR 13+"
      const segs = chunk.split(/,\s*(?=(?:Nivel|Nv)\.?\s*\d|(?:FUE|DES|CON|INT|SAB|CAR)\s*\d)/i)
                        .map(s => s.trim()).filter(Boolean);
      segs.forEach(s => parts.push(s));
    });
    parts.forEach(part => {
      let m;
      // Attribute alternatives where EACH has its own threshold:
      //   "FUE 13+ o DES 13+"  /  "FUE 14+ / DES 12+"
      const altPairs = [...part.matchAll(/\b(FUE|DES|CON|INT|SAB|CAR)\s*(\d+)\+?/gi)];
      const hasConnector = /\b(FUE|DES|CON|INT|SAB|CAR)\b[^·]*\b[\/o]\b[^·]*\b(FUE|DES|CON|INT|SAB|CAR)\s*\d/i.test(part);

      if (altPairs.length >= 2 && hasConnector) {
        // Satisfied if ANY one attribute meets its own threshold.
        const met = altPairs.some(p => (stats[p[1].toUpperCase()] || 0) >= parseInt(p[2]));
        out.atoms.push({ kind:'attr', raw: part, met });
        if (!met) { out.met = false; out.unmet.push(altPairs.map(p => `${p[1].toUpperCase()} ${p[2]}+`).join(' o ')); }
      }
      // Shared-threshold form: "INT, SAB o CAR 13+"  /  "FUE/DES 13+"  /  "SAB o CAR 13+"
      // One trailing threshold applies to a list of attributes joined by , / o.
      else if (/\b(?:FUE|DES|CON|INT|SAB|CAR)\b[\s,\/o]*(?:\b(?:FUE|DES|CON|INT|SAB|CAR)\b[\s,\/o]*)*\d+\+?/i.test(part)
               && (m = part.match(/(\d+)\+?\s*$/) || part.match(/(\d+)\+?/))) {
        const need = parseInt(m[1]);
        // collect every attribute token that appears before the number
        const upto = part.slice(0, part.indexOf(m[1]) + m[1].length);
        const attrs = [...upto.matchAll(/\b(FUE|DES|CON|INT|SAB|CAR)\b/gi)].map(x => x[1].toUpperCase());
        if (attrs.length) {
          const best = Math.max(...attrs.map(a => stats[a] || 0));
          const met = best >= need;
          out.atoms.push({ kind:'attr', raw: part, met });
          if (!met) { out.met = false; out.unmet.push(`${[...new Set(attrs)].join('/')} ${need}+`); }
        } else {
          out.atoms.push({ kind:'info', raw: part, met:true });
        }
      }
      // Level: "Nivel 5+" / "Nv3+"
      else if ((m = part.match(/\b(?:Nivel|Nv)\.?\s*(\d+)\+?/i))) {
        const need = parseInt(m[1]);
        const met = lvl >= need;
        out.atoms.push({ kind:'level', raw: part, met });
        if (!met) { out.met = false; out.unmet.push(`Nivel ${need}+`); }
      }
      // Filo: "Filo Físico 2 (o Filo Flexible 2)" — la hoja no registra Filos: informativo, no bloquea
      else if (/^Filo\s+(F\u00edsico|Flexible|Mental)\s*\d/i.test(part)) {
        out.atoms.push({ kind:'info', raw: part, met:true });
      }
      // Competencia de Kit [v5.2.2]: "Competencia en Herramientas de Alquimia (…)" — informativo
      else if (/^Competencia\s+en\s+/i.test(part)) {
        out.atoms.push({ kind:'info', raw: part, met:true });
      }
      // Canal abierto — tres v\u00edas [v5.2.2]: Iniciado M\u00edstico se satisface por el talento,
      // por el Misticismo Innato del Sagaz o por un descriptor con Afinidad M\u00edstica Innata.
      else if (/^Iniciado M[\u00edi]stico/i.test(part)) {
        const isSagaz = (document.getElementById('sel_arq')?.value === 'sagaz');
        const desc = this.DB.descriptors?.[document.getElementById('sel_desc')?.value];
        const innate = !!desc?.innate_optional;
        const met = isSagaz || innate
          || haveNames.has('iniciado m\u00edstico') || haveIds.has('iniciado_mistico');
        out.atoms.push({ kind:'talent', raw: part, met });
        if (!met) { out.met = false; out.unmet.push(part.replace(/\s+/g,' ').trim() + ' (o Canal abierto por otra v\u00eda)'); }
      }
      // Prerequisite talent (e.g., "Despertar Sobrenatural", "Iniciado Místico", "Pacto de la Hoja G1")
      else if (/^[A-ZÁÉÍÓÚÑ]/.test(part) && !/cualquier arquetipo/i.test(part)) {
        // strip trailing "G1"/grade hints and parentheticals for the name match
        const baseName = part.replace(/\bG\d\b/g,'').replace(/\([^)]*\)/g,'').trim().toLowerCase();
        // Reserva/condición special-cases we can't verify → treat as informational, not blocking
        const informational = /reserva|sin armadura|sin despertar|restringido|racial|atributo de fuente|atributo clave|requisito/i.test(part);
        if (informational || baseName.length < 4) {
          out.atoms.push({ kind:'info', raw: part, met:true });
        } else {
          const tid = this._slugify ? this._slugify(baseName) : baseName.replace(/[^a-z0-9]+/g,'_');
          const met = haveNames.has(baseName) || haveIds.has(tid);
          out.atoms.push({ kind:'talent', raw: part, met });
          if (!met) { out.met = false; out.unmet.push(part.replace(/\s+/g,' ').trim()); }
        }
      } else {
        out.atoms.push({ kind:'info', raw: part, met:true });
      }
    });
    return out;
  },

  /** Lightweight slug used to match prerequisite talent names to ids. */
  _slugify(s) {
    return (s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
  },

  /** Is a talent available to the currently selected Arquetipo?
      Heuristic: certain category families are gated to a core Arquetipo,
      but the system is open by design, so we only flag the explicit
      "NÚCLEO DURO" / arquetipo mentions found in `req`. */
  _talentMatchesArq(t) {
    const arqKey = document.getElementById('sel_arq')?.value || '';
    const arqName = (this.DB.archetypes?.[arqKey]?.name || '').toLowerCase();
    const blob = `${t.req||''}`.toLowerCase();
    // If req names a specific arquetipo, require a match; otherwise it's open to all.
    const named = ['audaz','sutil','sagaz'].filter(a => blob.includes(a));
    if (named.length === 0) return true;            // open to everyone
    return named.includes(arqName);
  },

  /** Toggle a talent filter chip and re-render. */
  _toggleTalentFilter(which, btn) {
    this._talentFilters = this._talentFilters || { eligible:false, arq:false };
    this._talentFilters[which] = !this._talentFilters[which];
    if (btn) {
      btn.classList.toggle('active', this._talentFilters[which]);
      btn.setAttribute('aria-pressed', String(this._talentFilters[which]));
    }
    this._renderTalentList();
  },

  /** Search input handler — debounced re-render. */
  _talentFilter() {
    if (!this._debouncedTalentRender) {
      this._debouncedTalentRender = this._debounce(() => this._renderTalentList(), 90);
    }
    this._debouncedTalentRender();
  },

  showTalentCategory(key, btn) {
    this.activeTalentCat = key;
    document.querySelectorAll('#tm_categories .catbtn').forEach(b=>b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    this._renderTalentList();
  },

  /** Central renderer: respects active category, text search and filter chips. */
  _renderTalentList() {
    const list = document.getElementById('tm_list'); if (!list) return;
    list.innerHTML = '';
    if (!this.DB.talents) return;
    this._talentFilters = this._talentFilters || { eligible:false, arq:false };
    const q = (document.getElementById('tm_search')?.value || '').trim().toLowerCase();
    const searching = q.length > 0;

    // When searching, scan ALL categories; otherwise just the active one.
    let entries = [];
    if (searching) {
      Object.entries(this.DB.talents).forEach(([cat, arr]) =>
        (arr||[]).forEach(t => entries.push([cat, t])));
    } else {
      const cat = this.activeTalentCat;
      (this.DB.talents[cat] || []).forEach(t => entries.push([cat, t]));
    }

    // Apply text + filter chips
    const matchText = t => {
      if (!searching) return true;
      const hay = `${t.name} ${t.desc||''} ${(t.grades||[]).map(g=>g.d).join(' ')}`.toLowerCase();
      return hay.includes(q);
    };
    let rows = entries.filter(([,t]) => matchText(t));
    if (this._talentFilters.arq) rows = rows.filter(([,t]) => this._talentMatchesArq(t));
    if (this._talentFilters.eligible) rows = rows.filter(([,t]) => this._parseTalentReq(t.req).met);

    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'tm-empty';
      p.textContent = searching ? 'Ningún talento coincide con la búsqueda.' :
        (this._talentFilters.eligible || this._talentFilters.arq)
          ? 'Ningún talento de esta categoría pasa los filtros activos.'
          : 'Esta categoría está vacía.';
      list.appendChild(p);
      return;
    }

    rows.forEach(([cat, t]) => {
      const sel = !!document.querySelector(`input[name="chk_talents_hidden"][value="${t.name}"]`);
      const reqInfo = this._parseTalentReq(t.req);
      const card = document.createElement('div');
      card.className = `tc${sel?' sel':''}${reqInfo.met?'':' tc-locked'}`;
      const chkEl = document.createElement('input');
      chkEl.type = 'checkbox'; chkEl.value = t.name;
      if (t.id) chkEl.setAttribute('data-id', t.id);
      chkEl.setAttribute('data-desc', t.desc||'');
      if (sel) chkEl.checked = true;
      chkEl.addEventListener('change', () => app.toggleTalent(chkEl, t.name, t.id||''));
      const infoDiv = document.createElement('div');
      const h4 = document.createElement('h4'); h4.textContent = t.name; infoDiv.appendChild(h4);
      // When searching, show which category the talent belongs to
      if (searching) {
        const tag = document.createElement('span');
        tag.className = 'js-grade-block';
        tag.style.color = 'var(--gold)';
        tag.textContent = cat.charAt(0).toUpperCase()+cat.slice(1);
        infoDiv.appendChild(tag);
      }
      const p = document.createElement('p'); p.textContent = t.desc||''; infoDiv.appendChild(p);
      (t.grades||[]).forEach(g => {
        const sp = document.createElement('span');
        sp.className = 'js-grade-block';
        sp.textContent = `G${g.g}: ${g.d}`;
        infoDiv.appendChild(sp);
      });
      // Requirement line
      if (t.req) {
        const rq = document.createElement('span');
        rq.className = 'tc-req' + (reqInfo.met ? ' tc-req-ok' : '');
        rq.textContent = (reqInfo.met ? '✓ ' : '⚠ ') +
          (reqInfo.met ? `Requisitos: ${t.req}` : `Te falta: ${reqInfo.unmet.join(' · ')}`);
        infoDiv.appendChild(rq);
      }
      card.appendChild(chkEl); card.appendChild(infoDiv);
      card.addEventListener('click', e => {
        if (e.target.type === 'checkbox') return;
        const chk = card.querySelector('input');
        chk.checked = !chk.checked;
        this.toggleTalent(chk, t.name, t.id || '');
      });
      list.appendChild(card);
    });
  },

  toggleTalent(chk, name, id) {
    let hidden = document.querySelector(`input[name="chk_talents_hidden"][value="${name}"]`);
    const card = chk.closest('.tc');
    if (chk.checked) {
      const count = document.querySelectorAll('input[name="chk_talents_hidden"]').length;
      if (count >= 3) { this.toast('Solo puedes elegir 3 talentos.','err'); chk.checked=false; return; }
      if (!hidden) {
        hidden = document.createElement('input'); hidden.type='hidden'; hidden.name='chk_talents_hidden';
        hidden.value=name; hidden.setAttribute('data-desc',chk.getAttribute('data-desc'));
        if (id) hidden.setAttribute('data-id',id);
        document.body.appendChild(hidden);
      }
      card?.classList.add('sel');
    } else { hidden?.remove(); card?.classList.remove('sel'); }
    this.updateTalentCount(); this.calc();
    // Re-render so requirement states that depend on other talents (prereqs) refresh
    if (document.getElementById('talent_panel')?.classList.contains('fs-open')) {
      this._renderTalentList();
    }
  },

  clearTalents() {
    const panel = document.getElementById('talent_panel');
    const container = panel?.classList.contains('fs-open') ? panel : document.body;
    this._confirmInContainer(container, '¿Limpiar talentos?', 'Se eliminarán todos los talentos seleccionados.', '✓ Limpiar', () => this._doCleanTalents());
  },

  _confirmInContainer(container, title, body, confirmLabel, onConfirm) {
    this._confirm(title, body, confirmLabel, onConfirm, container);
  },

  _doCleanTalents() {
    document.querySelectorAll('input[name="chk_talents_hidden"]').forEach(el=>el.remove());
    document.querySelectorAll('#tm_list input[type="checkbox"]').forEach(c=>{c.checked=false;c.closest('.tc')?.classList.remove('sel')});
    this.updateTalentCount(); this.calc();
  },

  updateTalentCount() {
    const n = document.querySelectorAll('input[name="chk_talents_hidden"]').length;
    const el1 = document.getElementById('talent_count_main');
    if (el1) el1.textContent = n;
    const el2 = document.getElementById('talent_count_modal');
    if (el2) {
      el2.textContent = n;
      el2.classList.toggle('full', n >= 3);
      // Pulse
      el2.classList.remove('pulse');
      void el2.offsetWidth;
      el2.classList.add('pulse');
    }
    // Update category dots
    if (this.DB.talents) {
      Object.keys(this.DB.talents).forEach(k => {
        const catBtn = document.querySelector(`#tm_categories .catbtn[data-cat="${k}"]`);
        if (!catBtn) return;
        const hasSel = (this.DB.talents[k]||[]).some(t=>!!document.querySelector(`input[name="chk_talents_hidden"][value="${t.name}"]`));
        let dot = catBtn.querySelector('.cat-dot');
        if (hasSel && !dot) { dot=document.createElement('span'); dot.className='cat-dot'; catBtn.appendChild(dot); }
        else if (!hasSel && dot) dot.remove();
      });
    }
  },

  showTalentSummary() {
    const items = Array.from(document.querySelectorAll('input[name="chk_talents_hidden"]'));
    const list = document.getElementById('talents_summary_list'); list.innerHTML='';
    const view = document.getElementById('talents_summary_view');
    if (items.length) {
      view.style.display='block';
      items.forEach(h => {
        const d = document.createElement('div');
        d.style.cssText='background:var(--raised);border:1px solid var(--rim);border-radius:var(--r);padding:6px 10px';
        const title = document.createElement('div');
        title.className = 'js-talent-title';
        title.textContent = String(h.value || '');
        const desc = document.createElement('div');
        desc.className = 'js-talent-desc';
        desc.textContent = String(h.getAttribute('data-desc') || '');
        d.appendChild(title); d.appendChild(desc);
        list.appendChild(d);
      });
    } else view.style.display='none';
  },

  buildDetailPage() {
    const descKey = document.getElementById('sel_desc').value;
    const arqKey = document.getElementById('sel_arq').value;
    const filoVal = document.getElementById('sel_filo').value;
    const desc = this.DB.descriptors?.[descKey];
    const arq = this.DB.archetypes?.[arqKey];

    // Descriptor
    const dt = document.getElementById('detail_desc_title');
    const db = document.getElementById('detail_desc_body');
    if (desc) {
      dt.textContent = 'Linaje: '+this._sanitize(desc.name);
      db.innerHTML = '';
      // txt paragraph (DB content — sanitized)
      const dtxt = document.createElement('p');
      dtxt.className = 'js-detail-txt';
      dtxt.textContent = this._sanitize(desc.txt||'');
      db.appendChild(dtxt);
      if (desc.bonus) {
        const bw = document.createElement('div'); bw.style.marginBottom='8px';
        const bs = document.createElement('span');
        bs.className = 'js-badge-gold';
        bs.textContent = '📈 '+this._sanitize(desc.bonus); bw.appendChild(bs); db.appendChild(bw);
      }
      if (desc.grant?.length) {
        const gl = document.createElement('div');
        gl.className = 'js-section-lbl';
        gl.textContent='Rasgos'; db.appendChild(gl);
        const gw = document.createElement('div'); gw.style.cssText='display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px';
        desc.grant.forEach(g => { const s=document.createElement('span'); s.className='tbadge'; s.textContent='✦ '+this._sanitize(String(g)); gw.appendChild(s); });
        db.appendChild(gw);
      }
      if (desc.mods && Object.keys(desc.mods).length) {
        const ml = document.createElement('div');
        ml.className = 'js-section-lbl';
        ml.textContent='Modificadores'; db.appendChild(ml);
        const mw = document.createElement('div'); mw.style.cssText='display:flex;flex-wrap:wrap;gap:4px';
        Object.entries(desc.mods).forEach(([k,v]) => {
          const s=document.createElement('span');
          s.style.cssText=`font-family:var(--fm);font-size:.8rem;color:${Number(v)>0?'var(--sage)':'var(--blood)'};background:var(--raised);border:1px solid var(--rim);border-radius:var(--r);padding:3px 8px`;
          s.textContent=String(k)+' '+(Number(v)>0?'+':'')+Number(v); mw.appendChild(s);
        });
        db.appendChild(mw);
      }
    } else { dt.textContent='Linaje: —'; db.innerHTML='<p style="color:var(--muted);font-size:.8rem;font-style:italic">Selecciona un Linaje.</p>'; }

    // Archetype
    const at = document.getElementById('detail_arq_title');
    const ab = document.getElementById('detail_arq_body');
    if (arq) {
      at.textContent = 'Arquetipo: '+this._sanitize(arq.name);
      ab.innerHTML = '';
      const atxt = document.createElement('p');
      atxt.className = 'js-detail-txt';
      atxt.textContent = this._sanitize(arq.txt||''); ab.appendChild(atxt);
      // Resource formulas grid
      const rg = document.createElement('div'); rg.className='g3'; rg.style.marginBottom='8px';
      const pvFormula = `${Number(arq.pv)||0} + CON`;
      const adrFormula = `FUE/DES + Niv + ${Number(arq.adr_bonus)||0}`;
      const ingFormula = `INT/SAB/CAR + Niv + ${Number(arq.ing_bonus)||0}`;
      const mkResBox = (bg,bc,lc,lbl,val) => {
        const d=document.createElement('div');
        d.className = 'js-res-formula';
        d.style.cssText=`background:${bg};border:1px solid ${bc}`;
        const l=document.createElement('div'); l.className='js-res-formula-lbl'; l.style.color=lc; l.textContent=lbl;
        const v=document.createElement('div'); v.className='js-res-formula-val'; v.textContent=val;
        d.appendChild(l); d.appendChild(v); return d;
      };
      rg.appendChild(mkResBox('rgba(176,48,64,.12)','rgba(176,48,64,.3)','var(--blood)','PV Base',pvFormula));
      rg.appendChild(mkResBox('rgba(76,175,125,.1)','rgba(76,175,125,.3)','var(--sage)','Adrenalina',adrFormula));
      rg.appendChild(mkResBox('rgba(74,158,202,.1)','rgba(74,158,202,.3)','var(--ice)','Ingenio',ingFormula));
      ab.appendChild(rg);
      if (filoVal) {
        const fl=document.createElement('div'); fl.className='js-section-lbl'; fl.textContent='Filo Seleccionado'; ab.appendChild(fl);
        const fw=document.createElement('div'); fw.style.marginBottom='8px'; const fb=document.createElement('span'); fb.className='tbadge'; fb.textContent='⚔ '+this._sanitize(filoVal); fw.appendChild(fb); ab.appendChild(fw);
      }
      const selSkills = [...new Set([...Array.from(document.querySelectorAll('input[name="chk_arq"]:checked')).map(e=>e.value),...Array.from(document.querySelectorAll('input[name="chk_bg"]:checked')).map(e=>e.value)])];
      if (selSkills.length) {
        const sl=document.createElement('div'); sl.className='js-section-lbl'; sl.textContent='Habilidades Seleccionadas'; ab.appendChild(sl);
        const sw=document.createElement('div'); sw.style.cssText='display:flex;flex-wrap:wrap;gap:4px';
        selSkills.forEach(s => { const sp=document.createElement('span'); sp.className='js-tag-neutral'; sp.textContent=this._sanitize(String(s)); sw.appendChild(sp); });
        ab.appendChild(sw);
      }
    } else { at.textContent='Arquetipo: —'; ab.innerHTML='<p style="color:var(--muted);font-size:.8rem;font-style:italic">Selecciona un Arquetipo.</p>'; }

    // Talents
    const tl = document.getElementById('detail_talents_list');
    const talents = Array.from(document.querySelectorAll('input[name="chk_talents_hidden"]'));
    if (!talents.length) { tl.innerHTML='<p class="txt-it-c">Sin talentos.</p>'; return; }
    tl.innerHTML = '';
    talents.forEach(h => {
      let grades = [];
      if (this.DB.talents) Object.values(this.DB.talents).forEach(arr=>{const f=arr.find(t=>t.name===h.value);if(f?.grades)grades=f.grades});
      const card = document.createElement('div'); card.className='dc';
      // Header
      const dch = document.createElement('div'); dch.className='dch';
      dch.addEventListener('click', () => card.classList.toggle('open'));
      const dct = document.createElement('span'); dct.className='dct'; dct.textContent='✦ '+this._sanitize(String(h.value||''));
      const dca = document.createElement('span'); dca.className='dca'; dca.textContent='▾';
      dch.appendChild(dct); dch.appendChild(dca);
      // Body
      const dcb = document.createElement('div'); dcb.className='dcb';
      dcb.textContent = this._sanitize(h.getAttribute('data-desc')||'Sin descripción.');
      // Grades (from DB — sanitized)
      grades.forEach(g => {
        const gd=document.createElement('div');
        gd.className = 'js-grade-block';
        gd.textContent='G'+Number(g.g)+': '+this._sanitize(String(g.d||''));
        dcb.appendChild(gd);
      });
      card.appendChild(dch); card.appendChild(dcb);
      tl.appendChild(card);
    });
  },

  // selectedApt stores { tricks: Set of keys, spells: Set of keys }
  _aptSel: { tricks: new Set(), spells: new Set() },
  _aptMode: 'tricks',

  /** Returns true if the spell entry is classified as a trick (not a full spell). */
  _isTrickEntry(s) {
    // Match type flag OR cost that starts with "adr" as a standalone token
    // (e.g. "Adr 1", "ADR", "adr") — avoids false positives like "Reduce ADR del enemigo".
    return s.type === 'trick' || (s.cost && /^adr\b/i.test(s.cost.trim()));
  },

  /** Returns all DB spell keys that belong to the given section ('tricks' | 'spells'). */
  _aptKeysForSection(sec) {
    return Object.keys(this.DB.spells || {}).filter(k => {
      const isTrick = this._isTrickEntry(this.DB.spells[k]);
      return sec === 'tricks' ? isTrick : !isTrick;
    });
  },

  buildAptitudesPage() {
    this._renderAptSummary('tricks');
    this._renderAptSummary('spells');
  },

  _renderAptSummary(sec) {
    const sumList = document.getElementById(`${sec}_summary_list`);
    const countEl = document.getElementById(`${sec}_count`);
    const sel = this._aptSel[sec];
    if (!sumList) return;

    const items = this._aptKeysForSection(sec).filter(k => sel.has(k));
    if (countEl) countEl.textContent = items.length;

    if (!items.length) {
      const label = sec === 'tricks' ? 'trucos' : 'conjuros';
      sumList.innerHTML = `<p class="txt-it-c">Sin ${label} seleccionados.</p>`;
      return;
    }
    sumList.innerHTML = '';
    items.forEach(k => {
      const s = this.DB.spells[k];
      const card = document.createElement('div'); card.className='pc';
      const pch=document.createElement('div'); pch.className='pch';
      const pcn=document.createElement('span'); pcn.className='pcn'; pcn.textContent=this._sanitize(String(s.name||k));
      const pcarr=document.createElement('span'); pcarr.style.cssText='font-size:.62rem;font-family:var(--fm);color:var(--muted)'; pcarr.textContent='▾';
      pch.appendChild(pcn); pch.appendChild(pcarr);
      const pcb=document.createElement('div'); pcb.className='pcb'; pcb.textContent=this._sanitize(String(s.txt||'Sin descripción.'));
      card.appendChild(pch); card.appendChild(pcb);
      card.addEventListener('click', () => card.classList.toggle('open'));
      sumList.appendChild(card);
    });
  },

  openAptManager(sec) {
    this._aptMode = sec;
    this._modalOpener = document.activeElement;
    const panel   = document.getElementById('apt_panel');
    const title   = document.getElementById('apt_manager_title');
    const sub     = document.getElementById('apt_manager_sub');
    const icon    = document.getElementById('apt_modal_icon');
    const typeLbl = document.getElementById('apt_type_label');
    if (sec === 'tricks') {
      title.textContent = 'Gestor de Trucos';
      if (sub)    sub.textContent    = 'Selecciona los trucos del personaje';
      if (icon)   { icon.textContent = '✦'; icon.style.color = 'var(--gold)'; }
      if (typeLbl) typeLbl.textContent = 'Trucos activos del personaje';
    } else {
      title.textContent = 'Gestor de Conjuros';
      if (sub)    sub.textContent    = 'Selecciona los conjuros del personaje';
      if (icon)   { icon.textContent = '✧'; icon.style.color = 'var(--ice)'; }
      if (typeLbl) typeLbl.textContent = 'Conjuros activos del personaje';
    }
    const srch = document.getElementById('apt_search');
    if (srch) srch.value = '';
    this._aptFilterQuery = '';
    this._renderAptManager();
    panel.classList.add('fs-open');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => document.getElementById('apt_search')?.focus());
    this._attachPanelSwipeBack(panel, () => this.closeAptManager());
  },

  _aptFilter(query) {
    this._aptFilterQuery = (query || '').toLowerCase().trim();
    const avail = document.getElementById('apt_available_list');
    if (!avail) return;
    avail.querySelectorAll('.apt-card').forEach(card => {
      const name = (card.querySelector('.apt-card__name')?.textContent || '').toLowerCase();
      const desc = (card.querySelector('.apt-card__desc')?.textContent  || '').toLowerCase();
      card.style.display = (!this._aptFilterQuery || name.includes(this._aptFilterQuery) || desc.includes(this._aptFilterQuery)) ? '' : 'none';
    });
  },

  _aptClearAll() {
    const sec = this._aptMode;
    if (!this._aptSel[sec]) return;
    this._aptSel[sec].clear();
    this._renderAptManager();
    // Clear search
    const srch = document.getElementById('apt_search');
    if (srch) srch.value = '';
    this._aptFilterQuery = '';
  },

  _renderAptManager() {
    const sec = this._aptMode;
    const sel = this._aptSel[sec];
    const allItems = this._aptKeysForSection(sec);

    const availList = document.getElementById('apt_available_list');
    const selList   = document.getElementById('apt_selected_list');
    const selEmpty  = document.getElementById('apt_selected_empty');
    const selCount  = document.getElementById('apt_sel_count');
    availList.innerHTML = ''; selList.innerHTML = '';

    /** Build a card. Click handler toggles classes in-place and moves the card
     *  between lists — no full re-render needed on every interaction. */
    const makeCard = (k, isSelected) => {
      const s    = this.DB.spells[k];
      const card = document.createElement('div');
      card.className = 'apt-card' + (isSelected ? ' apt-card--sel' : '');

      const topRow = document.createElement('div');
      topRow.className = 'apt-card__row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'apt-card__name';
      nameSpan.textContent = s.name || k;

      const badge = document.createElement('span');
      badge.className = 'apt-card__badge' + (isSelected ? '' : ' badge-add');
      badge.textContent = isSelected ? '✓ Quitar' : '+ Añadir';

      topRow.appendChild(nameSpan);
      topRow.appendChild(badge);
      card.appendChild(topRow);

      if (s.txt) {
        const desc = document.createElement('div');
        desc.className = 'apt-card__desc';
        desc.textContent = s.txt.length > 90 ? s.txt.slice(0, 90) + '…' : s.txt;
        card.appendChild(desc);
      }

      card.addEventListener('click', () => {
        const nowSelected = sel.has(k);
        if (nowSelected) {
          sel.delete(k);
          card.classList.remove('apt-card--sel');
          badge.className = 'apt-card__badge badge-add';
          badge.textContent = '+ Añadir';
          availList.insertBefore(card, availList.firstChild);
        } else {
          sel.add(k);
          card.classList.add('apt-card--sel');
          badge.className = 'apt-card__badge';
          badge.textContent = '✓ Quitar';
          selList.appendChild(card);
        }
        const count = selList.querySelectorAll('.apt-card').length;
        if (selCount) {
          selCount.textContent = count;
          // Pulse animation on change
          selCount.classList.remove('pulse');
          void selCount.offsetWidth; // reflow
          selCount.classList.add('pulse');
        }
        if (selEmpty) selEmpty.style.display = count ? 'none' : 'block';
        this._renderAptSummary(sec);
      });

      return card;
    };

    const notSel = allItems.filter(k => !sel.has(k));
    const isSel  = allItems.filter(k =>  sel.has(k));

    if (!allItems.length) {
      const label = sec === 'tricks' ? 'trucos' : 'conjuros';
      availList.innerHTML = `<div class="apt-empty"><p>No hay ${label} en la base de datos.<br>Añádelos en el Editor de Reglas.</p><button class="btn btn-g" style="font-size:.68rem" onclick="app.closeAptManager();setTimeout(()=>app.openDatabaseEditor(),260)">Editor de Reglas</button></div>`;
    } else {
      notSel.forEach(k => availList.appendChild(makeCard(k, false)));
      if (!notSel.length) {
        const d = document.createElement('p');
        d.className = 'txt-it-c';
        d.textContent = 'Todos añadidos.';
        availList.appendChild(d);
      }
    }

    isSel.forEach(k => selList.appendChild(makeCard(k, true)));
    if (selEmpty) selEmpty.style.display = isSel.length ? 'none' : 'block';
    if (selCount) selCount.textContent = isSel.length;
  },

  closeAptManager() {
    const panel = document.getElementById('apt_panel');
    panel.style.transform = '';
    panel.style.opacity   = '';
    panel.classList.remove('fs-open');
    document.body.style.overflow = '';
    this._renderAptSummary(this._aptMode);
    if (this._modalOpener?.focus) {
      setTimeout(() => { try { this._modalOpener?.focus(); } catch(e){} this._modalOpener = null; }, 0);
    }
  },

  openDatabaseEditor() {
    const sm = document.getElementById('settings_modal');
    if (sm.open) sm.close();
    const panel = document.getElementById('db_panel');
    panel.classList.add('fs-open');
    document.body.style.overflow = 'hidden';
    this.dbEditCategory('descriptors');
    this._attachPanelSwipeBack(panel, () => this.closeDatabaseEditor());
  },

  closeDatabaseEditor() {
    const panel = document.getElementById('db_panel');
    panel.style.transform = '';
    panel.style.opacity   = '';
    panel.classList.remove('fs-open');
    document.body.style.overflow = '';
  },

  /** Attaches swipe-back gesture to a fullscreen panel.
   *  Primary close = ← button in header (always works).
   *  Swipe-back = wider zone (40%), velocity-aware, cleans up all listeners. */
  _attachPanelSwipeBack(panel, closeFn) {
    // Tear down all previous listeners
    if (panel._swipeHandlers) {
      panel.removeEventListener('touchstart', panel._swipeHandlers.start, {passive:true});
      panel.removeEventListener('touchmove',  panel._swipeHandlers.move,  {passive:true});
      panel.removeEventListener('touchend',   panel._swipeHandlers.end);
      panel.removeEventListener('touchcancel',panel._swipeHandlers.cancel);
    }

    let startX = 0, startY = 0, lastX = 0, lastT = 0;
    let tracking = false, dragging = false;
    const W          = () => panel.offsetWidth || window.innerWidth;
    const EDGE_FRAC  = 0.40;   // 40% of screen — easy to reach
    const VEL_THRESH = 0.4;    // px/ms — flick velocity to trigger close
    const DIST_THRESH = 0.35;  // 35% of screen width to trigger close by distance

    const reset = () => {
      if (!dragging) return;
      dragging = false;
      tracking = false;
      panel.style.transition = 'transform .24s cubic-bezier(.25,.46,.45,.94)';
      panel.style.transform  = 'translateX(0)';
      // Clean transition after snap
      setTimeout(() => { panel.style.transition = ''; panel.style.transform = ''; }, 260);
    };

    const doClose = () => {
      dragging = false; tracking = false;
      panel.classList.add('swipe-used'); // hide hint strip after first use
      panel.style.transition = 'transform .24s cubic-bezier(.25,.46,.45,.94)';
      panel.style.transform  = `translateX(${W()}px)`;
      setTimeout(() => {
        panel.style.transition = '';
        panel.style.transform  = '';
        closeFn();
      }, 240);
    };

    const onStart = e => {
      if (e.touches.length > 1) return;
      const t = e.touches[0];
      if (t.clientX > W() * EDGE_FRAC) return;
      // Don't interfere with inputs or scrollable areas
      if (e.target.closest('input,textarea,select,.apt-col-body,.dbct,.tms,.dbs,.tmct')) return;
      startX = lastX = t.clientX;
      startY = t.clientY;
      lastT  = Date.now();
      tracking = true; dragging = false;
      panel.style.transition = 'none';
    };

    const onMove = e => {
      if (!tracking || e.touches.length > 1) return;
      const t  = e.touches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      // Cancel if predominantly vertical
      if (!dragging && dy > Math.abs(dx) * 1.5 && dy > 8) { reset(); return; }
      if (dx <= 0) return; // Only right-swipe
      dragging = true;
      // Track velocity
      const now = Date.now();
      lastX = t.clientX; lastT = now;
      const clamped = Math.min(dx, W());
      panel.style.transform = `translateX(${clamped}px)`;
      // Visual resistance — panel darkens as it moves
      panel.style.opacity = String(Math.max(0.85, 1 - (clamped / W()) * 0.15));
    };

    const onEnd = e => {
      if (!tracking) return;
      if (!dragging) { tracking = false; panel.style.transition = ''; return; }
      const t  = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dt = Date.now() - lastT;
      const vel = dt > 0 ? (t.clientX - lastX) / dt : 0; // px/ms
      panel.style.opacity = '';
      // Close if flick OR dragged past threshold
      if (vel >= VEL_THRESH || dx >= W() * DIST_THRESH) {
        doClose();
      } else {
        reset();
      }
    };

    const onCancel = () => { panel.style.opacity = ''; reset(); };

    panel.addEventListener('touchstart',  onStart, {passive:true});
    panel.addEventListener('touchmove',   onMove,  {passive:true});
    panel.addEventListener('touchend',    onEnd,   {passive:false});
    panel.addEventListener('touchcancel', onCancel,{passive:true});

    // Store all 4 handlers for future cleanup
    panel._swipeHandlers = { start:onStart, move:onMove, end:onEnd, cancel:onCancel };
  },

  dbEditCategory(cat) {
    this.currentEditorCat = cat;
    const lc = document.getElementById('db_list_container');
    const fc = document.getElementById('db_form_container');
    fc.style.display = 'none';
    fc.classList.remove('animate');
    const src = this.DB[cat] || {};
    const labels = {descriptors:'Linajes',archetypes:'Arquetipos',backgrounds:'Trasfondos',talents:'Talentos',weapons:'Armas',armors:'Armaduras',shields:'Escudos',spells:'Trucos / Conjuros'};
    const catLabel = labels[cat] || cat;
    // Count items
    let count = 0;
    if (cat === 'talents') {
      Object.values(src).forEach(arr => { count += (arr||[]).length; });
    } else {
      count = Object.keys(src).length;
    }
    // Update sidebar active state (support both .catbtn.db-cat and legacy .catbtn)
    document.querySelectorAll('#db_sidebar .catbtn').forEach(b => {
      const isActive = b.getAttribute('aria-label') === ('Editar ' + catLabel) ||
        b.textContent.trim().includes(catLabel);
      b.classList.toggle('active', isActive);
    });
    lc.innerHTML = '';
    // Header row — revamped
    const hdr = document.createElement('div');
    hdr.className = 'db-list-header';
    const htitle = document.createElement('div');
    htitle.style.cssText = 'display:flex;align-items:center;gap:8px';
    const hlbl = document.createElement('span');
    hlbl.className = 'db-list-title';
    hlbl.textContent = catLabel;
    const hcount = document.createElement('span');
    hcount.className = 'db-list-count';
    hcount.textContent = count + ' entrada' + (count !== 1 ? 's' : '');
    htitle.appendChild(hlbl); htitle.appendChild(hcount);
    const hnew = document.createElement('button');
    hnew.className = 'btn btn-p'; hnew.style.cssText = 'font-size:.66rem;padding:6px 11px;min-height:34px';
    hnew.textContent = '+ Nuevo'; hnew.onclick = () => app.dbEditEntry('new');
    hdr.appendChild(htitle); hdr.appendChild(hnew);
    lc.appendChild(hdr);
    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'db-empty';
      empty.innerHTML = `<div class="db-empty-icon">📂</div><p>Sin entradas en <strong>${catLabel}</strong>.<br>Crea la primera con "+ Nuevo".</p>`;
      lc.appendChild(empty);
      return;
    }
    if (cat === 'talents') {
      Object.keys(src).forEach(sub => {
        const h = document.createElement('div');
        h.style.cssText = 'font-family:var(--fm);font-size:.58rem;color:rgba(200,169,110,.7);letter-spacing:.15em;text-transform:uppercase;padding:6px 4px 4px;border-bottom:1px solid rgba(74,63,94,.3);margin:10px 0 5px;display:flex;justify-content:space-between;align-items:center';
        const hl = document.createElement('span'); hl.textContent = sub;
        const hc = document.createElement('span'); hc.style.cssText = 'color:var(--muted);font-size:.55rem'; hc.textContent = (src[sub]||[]).length + ' talentos';
        h.appendChild(hl); h.appendChild(hc);
        lc.appendChild(h);
        (src[sub]||[]).forEach((item,i) => this._dbListItem(lc, item.name, `${sub}|${i}`));
      });
    } else {
      Object.entries(src).forEach(([k,v]) => this._dbListItem(lc, v.name||k, k));
    }
  },

  _dbListItem(container, name, key) {
    const row = document.createElement('div');
    row.className = 'dbitem';
    row.setAttribute('data-key', key);
    row.title = 'Editar "' + String(name||'') + '"';
    // Clicking anywhere on the row opens edit
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // let buttons handle themselves
      container.querySelectorAll('.dbitem').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      this.dbEditEntry(key);
    });
    const nm = document.createElement('span');
    nm.className = 'dbitem-name';
    nm.textContent = String(name||'—');
    const acts = document.createElement('div'); acts.className = 'dbitem-actions';
    const editBtn = document.createElement('button'); editBtn.className='bmini bl'; editBtn.textContent='✎';
    editBtn.title = 'Editar ' + String(name||'');
    editBtn.setAttribute('aria-label', 'Editar '+String(name||''));
    editBtn.addEventListener('click', () => {
      container.querySelectorAll('.dbitem').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      this.dbEditEntry(key);
    });
    const delBtn = document.createElement('button'); delBtn.className='bmini br'; delBtn.textContent='✕';
    delBtn.title = 'Eliminar';
    delBtn.setAttribute('aria-label', 'Eliminar '+String(name||''));
    delBtn.addEventListener('click', () => this.dbDeleteEntry(key));
    acts.appendChild(editBtn); acts.appendChild(delBtn);
    row.appendChild(nm); row.appendChild(acts);
    container.appendChild(row);
  },

  dbEditEntry(key) {
    const cat = this.currentEditorCat;
    const fc = document.getElementById('db_form_container');
    fc.style.display = 'block';
    let existing = null;
    let isTalent = false; let talentSub='',talentIdx=-1;
    if (cat === 'talents' && key !== 'new') {
      const parts = key.split('|'); talentSub=parts[0]; talentIdx=parseInt(parts[1]);
      existing = this.DB.talents[talentSub]?.[talentIdx];
      isTalent = true;
    } else if (key !== 'new') {
      existing = this.DB[cat]?.[key];
    }

    // Shorthand: escapes DB values interpolated into HTML attribute strings
    const _e = v => this._esc(String(v ?? ''));

    let formHtml = `<h3 style="font-family:var(--fd);font-size:.78rem;color:var(--gold);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">${key==='new'?'Nuevo':'Editar'} Entrada</h3>`;

    if (cat === 'descriptors') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: elfo_oscuro" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Solo letras, números y guión bajo. Ej: <em>elfo_oscuro</em>, <em>humano_variante</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Descripción</span><textarea id="db_txt" style="min-height:56px">${_e(existing?.txt)}</textarea></div>
      <div style="margin-bottom:6px"><span class="dfl">Bono</span><input type="text" id="db_bonus" value="${_e(existing?.bonus)}" placeholder="ej: +1 DES"></div>
      <div style="margin-bottom:6px"><span class="dfl">Rasgos (separados por coma)</span><input type="text" id="db_grant" value="${_e((existing?.grant||[]).join(', '))}" placeholder="ej: Visión en la oscuridad, Resistencia"></div>
      <div style="margin-bottom:6px"><span class="dfl">Modificadores de Atributo</span>
        <div class="g6" style="gap:4px">
          ${['FUE','DES','CON','INT','SAB','CAR'].map(s=>`<div><span class="dfl">${s}</span><input type="number" id="db_mod_${s}" value="${existing?.mods?.[s]||0}" min="-5" max="5" style="font-family:var(--fm);font-size:.8rem;text-align:center;padding:3px"></div>`).join('')}
        </div>
      </div>`;
    } else if (cat === 'archetypes') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: paladin" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Ej: <em>paladin</em>, <em>brujo_pacto</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Descripción</span><textarea id="db_txt" style="min-height:56px">${_e(existing?.txt)}</textarea></div>
      <div class="g3" style="gap:6px;margin-bottom:6px">
        <div><span class="dfl">PV Base</span><input type="number" id="db_pv" value="${existing?.pv||8}"></div>
        <div><span class="dfl">Adrenalina</span><input type="number" id="db_adr" value="${existing?.adr_bonus??existing?.adr??2}"></div>
        <div><span class="dfl">Ingenio</span><input type="number" id="db_ing" value="${existing?.ing_bonus??existing?.ing??0}"></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Filos (separados por coma)</span><input type="text" id="db_edges" value="${_e((existing?.edges||[]).join(', '))}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Habilidades (separadas por coma)</span><input type="text" id="db_skills" value="${_e((existing?.skills||[]).join(', '))}"></div>`;
    } else if (cat === 'backgrounds') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: marinero" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Ej: <em>marinero</em>, <em>ex_soldado</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Descripción</span><textarea id="db_txt" style="min-height:56px">${_e(existing?.txt)}</textarea></div>
      <div style="margin-bottom:6px"><span class="dfl">Rasgos (coma)</span><input type="text" id="db_grant" value="${_e((existing?.grant||[]).join(', '))}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Habilidades (coma)</span><input type="text" id="db_skills" value="${_e((existing?.skills||[]).join(', '))}"></div>`;
    } else if (cat === 'weapons') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: espada_larga" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Ej: <em>espada_larga</em>, <em>ballesta_mano</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div class="g2" style="gap:6px;margin-bottom:6px">
        <div><span class="dfl">Daño (ej: 1d8)</span><input type="text" id="db_dmg" value="${_e(existing?.dmg||'1d6')}"></div>
        <div><span class="dfl">Tipo</span><select id="db_wtype"><option value="light"${existing?.type==='light'?' selected':''}>Ligera</option><option value="medium"${existing?.type==='medium'?' selected':''}>Media</option><option value="heavy"${existing?.type==='heavy'?' selected':''}>Pesada</option><option value="ranged"${existing?.type==='ranged'?' selected':''}>Distancia</option><option value="reach"${existing?.type==='reach'?' selected':''}>Alcance</option></select></div>
      </div>
      <div class="g3" style="gap:6px;margin-bottom:6px">
        <div><span class="dfl">Slots</span><input type="number" id="db_slots" value="${existing?.slots||1}"></div>
        <div><span class="dfl">Req. FUE</span><input type="number" id="db_req_fue" value="${existing?.req_FUE||0}"></div>
        <div><span class="dfl">Req. DES</span><input type="number" id="db_req_des" value="${existing?.req_DES||0}"></div>
      </div>`;
    } else if (cat === 'armors') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: cota_malla" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Ej: <em>cota_malla</em>, <em>cuero_tachonado</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div class="g3" style="gap:6px;margin-bottom:6px">
        <div><span class="dfl">CA Base</span><input type="number" id="db_ca" value="${existing?.ca||10}"></div>
        <div><span class="dfl">Tipo</span><select id="db_atype"><option value="none"${existing?.type==='none'?' selected':''}>Sin armadura</option><option value="light"${existing?.type==='light'?' selected':''}>Ligera</option><option value="medium"${existing?.type==='medium'?' selected':''}>Media</option><option value="heavy"${existing?.type==='heavy'?' selected':''}>Pesada</option></select></div>
        <div><span class="dfl">Slots</span><input type="number" id="db_slots" value="${existing?.slots||1}"></div>
      </div>`;
    } else if (cat === 'shields') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: escudo_torre" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Ej: <em>escudo_madera</em>, <em>escudo_torre</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div class="g2" style="gap:6px;margin-bottom:6px">
        <div><span class="dfl">Bono CA</span><input type="number" id="db_bonus_ca" value="${existing?.bonus||1}"></div>
        <div><span class="dfl">Slots</span><input type="number" id="db_slots" value="${existing?.slots||1}"></div>
      </div>`;
    } else if (cat === 'spells') {
      formHtml += `<div style="margin-bottom:10px">
        <span class="dfl">Clave <span class="is-field-note">— ID interno único</span></span>
        <input type="text" id="db_key" value="${key==='new'?'':_e(key)}" placeholder="ej: bola_fuego" autocomplete="off" spellcheck="false">
        <div style="font-family:var(--fb);font-size:.66rem;color:var(--muted);font-style:italic;margin-top:3px;line-height:1.4;padding-left:2px">Sin espacios ni acentos. Ej: <em>bola_fuego</em>, <em>truco_luz</em>, <em>rayo_helado</em></div>
      </div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Descripción</span><textarea id="db_txt" style="min-height:60px">${_e(existing?.txt)}</textarea></div>
      <div class="g2" style="gap:6px;margin-bottom:6px">
        <div><span class="dfl">Tipo</span><select id="db_stype"><option value="spell"${existing?.type==='spell'?' selected':''}>Conjuro</option><option value="trick"${(existing?.type==='trick'||existing?.type==='power')?'selected':''}>Truco</option></select></div>
        <div><span class="dfl">Coste</span><input type="text" id="db_cost" value="${_e(existing?.cost)}" placeholder="ej: 2 Ing"></div>
      </div>`;
    } else if (isTalent) {
      formHtml += `<div style="margin-bottom:6px"><span class="dfl">Categoría (existente)</span><input type="text" id="db_tcat" value="${_e(talentSub)}" placeholder="ej: acero"></div>
      <div style="margin-bottom:6px"><span class="dfl">Nombre</span><input type="text" id="db_name" value="${_e(existing?.name)}"></div>
      <div style="margin-bottom:6px"><span class="dfl">Descripción</span><textarea id="db_txt" style="min-height:56px">${_e(existing?.desc)}</textarea></div>`;
    }

    formHtml += `<div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-g" style="flex:1;min-height:44px" onclick="
        const fc=document.getElementById('db_form_container');
        fc.style.display='none';
        document.querySelector('#db_panel .dbct')?.scrollTo({top:0,behavior:'smooth'})
      ">✕ Cancelar</button>
      <button class="btn btn-p" style="flex:1;min-height:44px" id="db_save_btn">✓ Guardar</button>
    </div>`;
    fc.innerHTML = formHtml;
    // Trigger slide-up animation only on open (not on every re-render)
    fc.style.display = 'block';
    fc.classList.remove('animate');
    void fc.offsetWidth; // force reflow
    fc.classList.add('animate');
    // Scroll the form into view within the dbct scroll container
    requestAnimationFrame(() => fc.scrollIntoView({behavior:'smooth', block:'nearest'}));
    const saveBtn = fc.querySelector('#db_save_btn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.dbSaveEntry(key));
    // Live key normalization preview
    const keyInput = fc.querySelector('#db_key');
    if (keyInput) {
      keyInput.addEventListener('input', () => {
        const normalized = keyInput.value.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_áéíóúüñ]/g,'');
        if (keyInput.value !== normalized && keyInput.value.trim()) {
          keyInput.style.color = 'var(--ember)';
          keyInput.title = 'Se guardará como: ' + normalized;
        } else {
          keyInput.style.color = '';
          keyInput.title = '';
        }
      });
    }
    // Smooth scroll to form
    requestAnimationFrame(() => fc.scrollIntoView({behavior:'smooth',block:'nearest'}));
    // Auto-focus first text input
    requestAnimationFrame(() => {
      const firstInput = fc.querySelector('input[type="text"]');
      if (firstInput) firstInput.focus();
    });
  },

  dbSaveEntry(oldKey) {
    const cat = this.currentEditorCat;
    const isTalent = cat === 'talents' && oldKey !== 'new' && oldKey.includes('|');
    const isNewTalent = cat === 'talents' && oldKey === 'new';

    if (isTalent || isNewTalent) {
      const tcat = document.getElementById('db_tcat')?.value?.trim() || (isTalent?oldKey.split('|')[0]:'general');
      const name = document.getElementById('db_name')?.value?.trim();
      const desc = document.getElementById('db_txt')?.value?.trim();
      if (!name) { this.toast('Nombre requerido','err'); return; }
      if (!this.DB.talents[tcat]) this.DB.talents[tcat] = [];
      if (isTalent) {
        const idx = parseInt(oldKey.split('|')[1]);
        this.DB.talents[tcat][idx] = {...this.DB.talents[tcat][idx], name, desc};
      } else {
        this.DB.talents[tcat].push({name, desc});
      }
    } else {
      const key = (document.getElementById('db_key')?.value||'').trim().toLowerCase().replace(/\s+/g,'_');
      if (!key) { this.toast('Clave requerida','err'); return; }
      const name = document.getElementById('db_name')?.value?.trim() || key;
      let entry = {name};
      if (cat==='descriptors') {
        entry.txt = document.getElementById('db_txt')?.value;
        entry.bonus = document.getElementById('db_bonus')?.value;
        entry.grant = (document.getElementById('db_grant')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
        entry.mods = {};
        ['FUE','DES','CON','INT','SAB','CAR'].forEach(s=>{const v=parseInt(document.getElementById(`db_mod_${s}`)?.value)||0;if(v!==0)entry.mods[s]=v});
      } else if (cat==='archetypes') {
        entry.txt=document.getElementById('db_txt')?.value;
        entry.pv=parseInt(document.getElementById('db_pv')?.value)||8;
        entry.adr_bonus=parseInt(document.getElementById('db_adr')?.value)||2;
        entry.ing_bonus=parseInt(document.getElementById('db_ing')?.value)||0;
        entry.speed=30;
        entry.prof=2;
        entry.edges=(document.getElementById('db_edges')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
        entry.skills=(document.getElementById('db_skills')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
        entry.armorProf=[];
      } else if (cat==='backgrounds') {
        entry.txt=document.getElementById('db_txt')?.value;
        entry.grant=(document.getElementById('db_grant')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
        entry.skills=(document.getElementById('db_skills')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
      } else if (cat==='weapons') {
        entry.dmg=document.getElementById('db_dmg')?.value||'1d6';
        entry.type=document.getElementById('db_wtype')?.value||'medium';
        entry.slots=parseInt(document.getElementById('db_slots')?.value)||1;
        entry.req_FUE=parseInt(document.getElementById('db_req_fue')?.value)||0;
        entry.req_DES=parseInt(document.getElementById('db_req_des')?.value)||0;
        entry.atk_bonus=0;
      } else if (cat==='armors') {
        entry.ca=parseInt(document.getElementById('db_ca')?.value)||10;
        entry.type=document.getElementById('db_atype')?.value||'light';
        entry.slots=parseInt(document.getElementById('db_slots')?.value)||1;
      } else if (cat==='shields') {
        entry.bonus=parseInt(document.getElementById('db_bonus_ca')?.value)||1;
        entry.slots=parseInt(document.getElementById('db_slots')?.value)||1;
      } else if (cat==='spells') {
        entry.txt=document.getElementById('db_txt')?.value;
        entry.type=document.getElementById('db_stype')?.value||'spell';
        entry.cost=document.getElementById('db_cost')?.value;
      }
      if (oldKey !== 'new' && oldKey !== key && this.DB[cat]?.[oldKey]) delete this.DB[cat][oldKey];
      if (!this.DB[cat]) this.DB[cat] = {};
      this.DB[cat][key] = entry;
    }

    this.saveRulesToLocal();
    document.getElementById('db_form_container').style.display = 'none';
    this.dbEditCategory(cat);
    this.unlockApp();
    // Scroll list container to top after save
    requestAnimationFrame(() => {
      const lc = document.getElementById('db_list_container');
      if (lc) lc.scrollTop = 0;
    });
    this.toast('Entrada guardada','ok');
  },

  dbDeleteEntry(key) {
    const cat = this.currentEditorCat;
    const label = key.includes('|') ? key.split('|')[0]+' (talento)' : key;
    const panel = document.getElementById('db_panel');
    const container = panel?.classList.contains('fs-open') ? panel : document.body;
    this._confirmInContainer(container, `¿Eliminar "${label}"?`, 'Esta entrada se eliminará de la base de datos.', '✓ Eliminar', () => {
      if (cat === 'talents' && key.includes('|')) {
        const [sub,idx] = key.split('|');
        this.DB.talents[sub]?.splice(parseInt(idx),1);
      } else if (this.DB[cat]?.[key]) {
        delete this.DB[cat][key];
      }
      this.saveRulesToLocal();
      this.dbEditCategory(cat);
      this.unlockApp();
      this.toast('Eliminado','ok');
    });
  },

  saveRulesToLocal() {
    const ok = STORAGE.saveRules(this.DB);
    if (!ok) this.toast('No se pudieron guardar las reglas: almacenamiento lleno.','err');
    return ok;
  },

  exportRulesDB() {
    const a = document.createElement('a');
    a.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.DB, null, 2));
    a.download = 'sands_rules.json';
    a.click();
  },

  /* ══ CROPPER ══
     Coordinate model:
       cs.x / cs.y = pixels the image center is offset from the workspace center.
       x=0, y=0 → image perfectly centered.
       Clamp limit: |x| ≤ max(0, scaledW/2 − FW/2)
                    |y| ≤ max(0, scaledH/2 − FH/2)
     UX behaviour:
       • Drag: rubber-band resistance beyond limits (not hard stop)
       • Release: spring-animated snap back into bounds
       • Zoom: always keeps minZoom = fill-frame (no empty corners)
       • Pinch: zooms towards the midpoint between two fingers
  */

  _cropFrameSize() {
    const ws = document.getElementById('crop_ws');
    if (!ws) return {w:171, h:228};
    const maxW = ws.clientWidth * 0.88, maxH = ws.clientHeight * 0.88;
    const CROP_W = 308, CROP_H = 441;
    let fw = maxW, fh = fw * (CROP_H / CROP_W);
    if (fh > maxH) { fh = maxH; fw = fh * (CROP_W / CROP_H); }
    return {w: Math.round(fw), h: Math.round(fh)};
  },

  _cropPositionFrame() {
    const {w, h} = this._cropFrameSize();
    const frame = document.getElementById('crop_frame');
    if (frame) {
      frame.style.width  = w + 'px';
      frame.style.height = h + 'px';
      frame.style.left   = '50%';
      frame.style.top    = '50%';
      frame.style.transform = 'translate(-50%,-50%)';
    }
    // Apply current portrait shape to frame so editor previews correctly
    const shapeData = {
      rect:    {r:'2px',  clip:'none', cls:''},
      rounded: {r:'14px', clip:'none', cls:''},
      arch:    {r:'0',    clip:'none', cls:'arch'},
      circle:  {r:'50%',  clip:'none', cls:''},

    };
    const s = shapeData[this._portShape || 'rect'] || shapeData['rect'];
    if (frame) {
      frame.style.setProperty('--crfr-r',    s.r);
      frame.style.setProperty('--crfr-clip', s.clip);
      frame.className = 'crfr' + (s.cls ? ' ' + s.cls : '');
    }
    const grid = document.getElementById('cr_grid');
    const svg  = document.getElementById('cr_grid_svg');
    if (grid && svg) {
      grid.style.cssText = `position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .18s;z-index:11`;
      const t = n => `<line x1="${n}" y1="0" x2="${n}" y2="${h}" stroke="rgba(255,255,255,.22)" stroke-width="1"/>`;
      const l = n => `<line x1="0" y1="${n}" x2="${w}" y2="${n}" stroke="rgba(255,255,255,.22)" stroke-width="1"/>`;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.innerHTML = t(w/3)+t(w*2/3)+l(h/3)+l(h*2/3);
    }
  },

  /** Returns the max allowed |offset| for one axis so the image always covers the frame */
  _cropMaxOffset(axis) {
    const cs = this.cropState;
    const {w: FW, h: FH} = this._cropFrameSize();
    const isRot = cs.rot % 180 !== 0;
    const natW  = isRot ? cs.img.naturalHeight : cs.img.naturalWidth;
    const natH  = isRot ? cs.img.naturalWidth  : cs.img.naturalHeight;
    if (axis === 'x') return Math.max(0, (natW * cs.zoom - FW) / 2);
    else              return Math.max(0, (natH * cs.zoom - FH) / 2);
  },

  /** Hard clamp — used only at applyCrop() to guarantee canvas coverage */
  _cropClamp(axis) {
    const max = this._cropMaxOffset(axis);
    const v   = axis === 'x' ? this.cropState.x : this.cropState.y;
    return Math.min(max, Math.max(-max, v));
  },

  /** Rubber-band: beyond the limit, movement is dampened not stopped */
  _cropRubber(v, max) {
    if (Math.abs(v) <= max) return v;
    const over = Math.abs(v) - max;
    const sign = v > 0 ? 1 : -1;
    // Logarithmic resistance: each extra pixel costs more than the last
    return sign * (max + over * 0.28 / (1 + over * 0.012));
  },

  /** Apply transform to DOM — no clamping, reflects cs.x/y exactly */
  _cropApply(animated = false) {
    const cs  = this.cropState;
    if (!cs.img) return;
    const img = document.getElementById('crop_preview');
    if (animated) {
      img.style.transition = `transform .${TIMING.CROP_SPRING}ms cubic-bezier(.25,.46,.45,.94)`;
      setTimeout(() => { if (img) img.style.transition = ''; }, TIMING.CROP_SPRING + 8);
    } else {
      img.style.transition = '';
    }
    img.style.transform = `translate(${cs.x}px,${cs.y}px) rotate(${cs.rot}deg) scale(${cs.zoom})`;
  },

  /** Spring-snap cs.x/y into bounds with a CSS transition */
  _cropSpringSnap() {
    const cs = this.cropState;
    cs.x = this._cropClamp('x');
    cs.y = this._cropClamp('y');
    this._cropApply(true); // animated
  },

  _cropUpdateSlider() {
    const cs  = this.cropState;
    const sl  = document.getElementById('crop_zoom');
    if (sl)  { sl.min = cs.minZoom; sl.value = cs.zoom; }
    const lbl = document.getElementById('cr_zoom_lbl');
    if (lbl) lbl.textContent = Math.round(cs.zoom * 100) + '%';
  },

  /** Reset zoom to exactly fill the frame, centered */
  _cropResetZoom() {
    const cs = this.cropState;
    const {w: FW, h: FH} = this._cropFrameSize();
    const isRot = cs.rot % 180 !== 0;
    const natW  = isRot ? cs.img.naturalHeight : cs.img.naturalWidth;
    const natH  = isRot ? cs.img.naturalWidth  : cs.img.naturalHeight;
    // minZoom = fit inside frame (image fully visible, may leave empty space)
    cs.minZoom = Math.min(FW / natW, FH / natH);
    // Default zoom = fill frame (cover), user can zoom out further
    cs.zoom = Math.max(FW / natW, FH / natH);
    cs.x = 0; cs.y = 0;
  },

  startCrop(input) {
    if (!input.files?.[0]) return;
    const r = new FileReader();
    r.onload = e => {
      const img = new Image();
      img.onerror = () => this.toast('Imagen inválida','err');
      img.onload = () => {
        this.cropState.img = img;
        this.cropState.rot = 0;
        document.getElementById('crop_preview').src = img.src;
        document.getElementById('crop_modal').showModal();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          this._cropPositionFrame();
          this._cropResetZoom();
          this._cropApply();
          this._cropUpdateSlider();
        }));
      };
      img.src = e.target.result;
    };
    r.readAsDataURL(input.files[0]);
    input.value = '';
  },

  cropFit() {
    const cs = this.cropState;
    if (!cs.img) return;
    this._cropPositionFrame();
    this._cropResetZoom();
    this._cropApply(true);
    this._cropUpdateSlider();
  },

  cropZoomStep(delta) {
    const cs   = this.cropState;
    const prev = cs.zoom;
    cs.zoom    = Math.max(cs.minZoom, Math.min(8, cs.zoom + delta));
    // Scale offsets proportionally so the visual center stays put
    const ratio = cs.zoom / prev;
    cs.x *= ratio; cs.y *= ratio;
    this._cropSpringSnap();
    this._cropUpdateSlider();
  },

  cropZoomSlider(val) {
    const cs   = this.cropState;
    const prev = cs.zoom;
    cs.zoom    = Math.max(cs.minZoom, Math.min(8, parseFloat(val)));
    const ratio = cs.zoom / prev;
    cs.x *= ratio; cs.y *= ratio;
    this._cropSpringSnap();
    this._cropUpdateSlider();
  },

  cropRotate(deg) {
    const cs = this.cropState;
    cs.rot = (cs.rot + deg + 360) % 360;
    this._cropPositionFrame();
    // Re-calculate minZoom for new orientation and fit
    this._cropResetZoom();
    this._cropApply(true);
    this._cropUpdateSlider();
  },

  cancelCrop() {
    document.getElementById('crop_modal').close();
    this.cropState = {img:null, x:0, y:0, zoom:1, rot:0, minZoom:.05,
      isDragging:false, lastX:0, lastY:0, pinch:null, velX:0, velY:0};
  },

  // ── Drag / Pinch ──
  cropDragStart(e) {
    const cs = this.cropState;
    if (!cs.img) return;
    e.preventDefault();
    const ws = document.getElementById('crop_ws');
    ws.classList.add('dragging');

    const getTouches = ev => ev.touches ? Array.from(ev.touches) : null;
    const dist  = t => Math.hypot(t[1].clientX-t[0].clientX, t[1].clientY-t[0].clientY);
    const mid   = t => ({x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2});

    let mode = 'drag', lastX = 0, lastY = 0, pinchRef = null;
    cs.velX = 0; cs.velY = 0; cs._lastT = Date.now();

    const touches = getTouches(e);
    if (touches?.length >= 2) {
      mode = 'pinch';
      pinchRef = {dist:dist(touches), zoom:cs.zoom, mx:mid(touches).x, my:mid(touches).y, ix:cs.x, iy:cs.y};
    } else {
      const p = touches?.[0] || e;
      lastX = p.clientX; lastY = p.clientY;
    }

    let raf = false;
    const draw = () => {
      if (raf) return; raf = true;
      requestAnimationFrame(() => { raf = false; this._cropApply(); });
    };

    const onMove = ev => {
      ev.preventDefault();
      const ts = getTouches(ev);

      if (ts?.length >= 2 && mode === 'drag') {
        mode = 'pinch';
        pinchRef = {dist:dist(ts), zoom:cs.zoom, mx:mid(ts).x, my:mid(ts).y, ix:cs.x, iy:cs.y};
        cs.velX = cs.velY = 0;
        return;
      }
      if (ts?.length === 1 && mode === 'pinch') {
        mode = 'drag'; pinchRef = null;
        lastX = ts[0].clientX; lastY = ts[0].clientY;
        cs.velX = cs.velY = 0;
        return;
      }

      if (mode === 'pinch' && ts?.length >= 2) {
        const r   = dist(ts) / pinchRef.dist;
        const nz  = Math.max(cs.minZoom, Math.min(8, pinchRef.zoom * r));
        const m   = mid(ts);
        cs.zoom   = nz;
        // Keep the pinch midpoint anchored: offset = original_offset * ratio + finger_pan
        cs.x = pinchRef.ix * r + (m.x - pinchRef.mx);
        cs.y = pinchRef.iy * r + (m.y - pinchRef.my);
        // Apply rubber-band so fingers feel natural even when pushing limits
        cs.x = this._cropRubber(cs.x, this._cropMaxOffset('x'));
        cs.y = this._cropRubber(cs.y, this._cropMaxOffset('y'));
        draw();
        this._cropUpdateSlider();

      } else if (mode === 'drag') {
        const pt = ts?.[0] || ev;
        const now = Date.now(), dt = Math.max(now - cs._lastT, 1);
        const dx = pt.clientX - lastX, dy = pt.clientY - lastY;
        cs.velX = cs.velX * 0.5 + (dx / dt) * 0.5;
        cs.velY = cs.velY * 0.5 + (dy / dt) * 0.5;
        lastX = pt.clientX; lastY = pt.clientY; cs._lastT = now;
        cs.x += dx; cs.y += dy;
        // Rubber-band: drag is free inside bounds, resists outside
        cs.x = this._cropRubber(cs.x, this._cropMaxOffset('x'));
        cs.y = this._cropRubber(cs.y, this._cropMaxOffset('y'));
        draw();
      }
    };

    const onEnd = ev => {
      const ts = getTouches(ev);
      if (ts?.length === 1 && mode === 'pinch') {
        mode = 'drag'; pinchRef = null;
        lastX = ts[0].clientX; lastY = ts[0].clientY;
        cs.velX = cs.velY = 0;
        return;
      }
      if (!ts?.length) {
        mode = 'idle';
        ws.classList.remove('dragging');
        this._cropInertia();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('mouseup',   onEnd);
        window.removeEventListener('touchend',  onEnd);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, {passive:false});
    window.addEventListener('mouseup',   onEnd);
    window.addEventListener('touchend',  onEnd);
  },

  _cropInertia() {
    const cs = this.cropState;
    // Scale velocity to pixels — lower multiplier = less slide-past
    let vx = cs.velX * 55, vy = cs.velY * 55;
    const step = () => {
      if (!cs.img) return;
      if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) {
        // Inertia done — spring-snap back if outside bounds
        this._cropSpringSnap();
        return;
      }
      cs.x += vx; cs.y += vy;
      // Rubber-band during inertia too
      cs.x = this._cropRubber(cs.x, this._cropMaxOffset('x'));
      cs.y = this._cropRubber(cs.y, this._cropMaxOffset('y'));
      vx *= 0.86; vy *= 0.86;
      this._cropApply();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  _cropWheel(e) {
    e.preventDefault();
    this.cropZoomStep(e.deltaY > 0 ? -0.04 : 0.04);
  },

  applyCrop() {
    const cs = this.cropState;
    if (!cs.img) return;
    const {w: FW, h: FH} = this._cropFrameSize();
    // Cap portrait size — see MAX_PORTRAIT_W constant
    const MAX_W = MAX_PORTRAIT_W;
    const SC = Math.min(2, MAX_W / FW);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(FW * SC); canvas.height = Math.round(FH * SC);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width/2, canvas.height/2);
    ctx.rotate(cs.rot * Math.PI / 180);
    ctx.scale(cs.zoom * SC, cs.zoom * SC);
    ctx.translate(cs.x / cs.zoom, cs.y / cs.zoom);
    ctx.drawImage(cs.img, -cs.img.naturalWidth/2, -cs.img.naturalHeight/2);
    const src = canvas.toDataURL('image/jpeg', .92);
    this._syncPortrait(src);
    document.getElementById('crop_modal').close();
    // Reset crop state so next image starts clean
    this.cropState = {img:null, x:0, y:0, zoom:1, rot:0, minZoom:.05,
      isDragging:false, lastX:0, lastY:0, pinch:null, velX:0, velY:0};
    this.toast('Retrato actualizado','ok');
  },

  /** Convierte el export unificado v5.2.2 ({meta, reglas, talentos, axiomas, poderesApex})
   *  al esquema interno de la app, conservando linajes/arquetipos/trasfondos/equipo actuales. */
  _convertUnifiedRules(rules) {
    const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    const catmap = { 'FUENTE INDEPENDIENTE':'v\u00eda de axiomas', 'DIVINIDAD / JURAMENTO':'divinidad', 'DIVINIDAD o JURAMENTO':'divinidad' };
    const via = new Set(['iniciado_mistico','despertar_sobrenatural','poderio_arcano','despertar_apex']);
    const talents = {};
    (rules.talentos || []).forEach(t => {
      const id = slug(t.nombre);
      let cat = catmap[t.categoria] || String(t.categoria||'general').toLowerCase();
      if (via.has(id)) cat = 'v\u00eda de axiomas';
      (talents[cat] = talents[cat] || []).push({
        id, name: t.nombre,
        desc: ((t.subcategoria ? t.subcategoria + ' \u00b7 ' : '') + (t.leyenda || '')).trim(),
        req: t.req || '',
        grades: (t.grados || []).map(g => ({ g: g.grado, d: (g.nivelReq ? 'Nivel ' + g.nivelReq + '+: ' : '') + g.efecto }))
      });
    });
    const spells = {};
    (rules.axiomas || []).forEach(a => {
      let k = slug(a.nombre); if (spells[k]) k = slug(a.fuente + '_' + a.nombre);
      const parts = ['Nv ' + (a.nivel === 0 ? 'T' : a.nivel) + ' \u00b7 ' + (a.fuente === 'Trucos' ? 'Truco' : a.fuente)];
      if (a.dominio) parts.push('Dominio: ' + a.dominio);
      parts.push(a.ingenio + ' Ingenio \u00b7 ' + a.pa + ' PA');
      if (a.concentracion) parts.push('Concentraci\u00f3n');
      let txt = parts.join(' \u00b7 ') + ' \u2014 ' + a.efecto;
      if (a.salvacion && a.salvacion !== 'Ninguna') txt += ' \u00b7 Salv: ' + a.salvacion;
      spells[k] = { name: a.nombre, type: a.nivel === 0 ? 'trick' : 'spell', level: a.nivel, source: a.fuente, txt };
    });
    const base = this.DB || DEFAULT_DB;
    return { descriptors: base.descriptors, archetypes: base.archetypes, backgrounds: base.backgrounds,
             weapons: base.weapons, armors: base.armors, shields: base.shields,
             talents: Object.keys(talents).length ? talents : base.talents,
             spells: Object.keys(spells).length ? spells : base.spells,
             misc: base.misc || {} };
  },

  loadRulesFile(input) {
    if (!input.files?.[0]) return;
    this.toast('Cargando reglas…', 'info');
    const file = input.files[0];
    // Reject files larger than 2 MB
    if (file.size > MAX_JSON_BYTES) { this.toast('Archivo demasiado grande (máx 2 MB)','err'); input.value=''; return; }
    const r = new FileReader();
    r.onload = e => {
      try {
        const rules = JSON.parse(e.target.result);
        if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) throw new Error('Formato inválido: se esperaba un objeto JSON');
        // ── Formato unificado v5.2.2 (stars_sorcery_data_v5_2_2.json) ──
        if (Array.isArray(rules.talentos)) {
          app.DB = app._convertUnifiedRules(rules);
          app.saveRulesToLocal();
          app._aptSel = { tricks: new Set(), spells: new Set() };
          app.unlockApp();
          app.toast(`Reglas v${rules.meta?.version || '5.2.2'} cargadas (${rules.talentos.length} talentos, ${(rules.axiomas||[]).length} axiomas)`, 'ok');
          input.value = '';
          return;
        }
        if (!rules.descriptors && !rules.archetypes) throw new Error('JSON no reconocido: usa el esquema de la app (descriptors/archetypes…) o el export unificado v5.2.2 (talentos/axiomas)');
        // Deep sanitize string values (strip HTML tags)
        const sanitizeObj = (obj) => {
          if (typeof obj === 'string') return obj.replace(/<[^>]*>/g,'').replace(/javascript:/gi,'');
          if (Array.isArray(obj)) return obj.map(sanitizeObj);
          if (obj && typeof obj === 'object') { const r={}; for(const k in obj) r[k]=sanitizeObj(obj[k]); return r; }
          return obj;
        };
        app.DB = sanitizeObj(rules);
        app.saveRulesToLocal();
        // Reset aptitude selection so stale keys from a previous character
        // don't carry over into the newly loaded rule set.
        app._aptSel = { tricks: new Set(), spells: new Set() };
        app.unlockApp();
        app.toast('Reglas cargadas','ok');
      } catch(err) { app.toast(err.message || 'Formato JSON inválido','err'); }
    };
    r.readAsText(file); input.value='';
  },

  /* ─────────────────────────────────────────
   ── CHARACTER PERSISTENCE (Save / Load)
   ───────────────────────────────────────── */
  /** Serializes the current character form state into a JSON-safe object. */
  gatherCharData() {
    const data = {
      _schemaVersion: STORAGE.SCHEMA_VERSION,
      inputs:{}, selects:{}, checks:[], hidden_talents:[],
      portrait: (() => {
        const src = document.getElementById('char_img')?.src || '';
        // Don't persist the default SVG placeholder — waste of space
        return src.startsWith('data:image/svg') ? '' : src;
      })(),
      concept: document.getElementById('char_concept').value,
      notes: document.getElementById('char_notes').value,
      alignment: this.alignment,
      inventory: this.inventory,
      gold: this.gold,
      lethality: this.lethality||1,
      apt_tricks: [...(this._aptSel?.tricks||[])],
      apt_spells: [...(this._aptSel?.spells||[])],
      _prefs: {
        // Se serializa lo CONFIRMADO con "✓ Aplicar al Personaje"
        // (_charPrefs), nunca una vista previa sin aplicar.
        portSize:   this._charPrefs?.portSize   || this._portSize        || 'm',
        portShape:  this._charPrefs?.portShape  || this._portShape       || 'rect',
        portBorder: this._charPrefs?.portBorder || this._portBorderMode  || 'premium',
        fontSize:  localStorage.getItem(STORAGE.KEYS.font) || 'normal'
      }
    };
    document.querySelectorAll('input[type=text]:not(.inm),input[type=number]:not(.isl):not(#gold_coins_edit)').forEach(el=>{if(el.id)data.inputs[el.id]=el.value});
    document.querySelectorAll('select:not(#inv_db_category):not(#inv_db_item):not(.ityp)').forEach(el=>{if(el.id)data.selects[el.id]=el.value});
    document.querySelectorAll('input[type=checkbox]:not([type=hidden]):checked,input[type=radio]:checked').forEach(el=>data.checks.push({name:el.name,value:el.value,id:el.id}));
    document.querySelectorAll('input[name="chk_talents_hidden"]').forEach(el=>data.hidden_talents.push({value:el.value,id:el.getAttribute('data-id'),desc:el.getAttribute('data-desc')}));
    return data;
  },

  /** Hydrates the form from a deserialized character data object. */
  applyCharData(data) {
    // Normalize inventory: ensure uid is always a string, name always a string
    this.inventory = (data.inventory || []).map(item => ({
      ...item,
      uid:   String(item.uid   ?? this._nextUid()),
      name:  String(item.name  ?? ''),
      slots: Number(item.slots ?? 1),
      type:  String(item.type  ?? 'misc'),
    }));
    // Migración: personajes guardados por versiones con uid = Date.now()
    // pueden traer uids DUPLICADOS (items creados en el mismo ms). El
    // primero conserva el uid (igual que resolvía _getInventoryItem, así
    // que las selecciones guardadas no cambian); los demás se reasignan.
    const seenUids = new Set();
    this.inventory.forEach(it => {
      while (seenUids.has(it.uid)) it.uid = this._nextUid();
      seenUids.add(it.uid);
    });
    this.gold = data.gold||0;
    this.alignment = data.alignment||'';
    this._aptSel = { tricks: new Set(data.apt_tricks||[]), spells: new Set(data.apt_spells||[]) };
    if(data.lethality) this.setLethality(data.lethality);
    this.syncCombatOptions();
    for (const id in data.inputs) { const el=document.getElementById(id); if(el)el.value=data.inputs[id]; }
    // Portrait
    if (data.portrait) this._syncPortrait(data.portrait);
    // Per-character visual preferences.
    // _charPrefs es el estado CONFIRMADO del personaje: ausencias caen al
    // predeterminado global, sin que cargar este personaje lo modifique.
    const prefs = (data._prefs && typeof data._prefs === 'object') ? data._prefs : {};
    this._charPrefs = {
      portSize:   prefs.portSize   || localStorage.getItem(STORAGE.KEYS.portSize)  || 'm',
      portShape:  prefs.portShape  || localStorage.getItem(STORAGE.KEYS.portShape) || 'rect',
      portBorder: prefs.portBorder || localStorage.getItem('ss_port_border')        || 'premium',
    };
    if (this._perCharPrefs) {
      this.setPortraitSize(this._charPrefs.portSize);     // _charOpen() ⇒ no persiste global
      this.setPortraitShape(this._charPrefs.portShape);
      this._portBorderMode = this._charPrefs.portBorder;
      this._applyPortraitBorder();
      if (prefs.fontSize) this.setFontSize(prefs.fontSize, false); // no contaminar el global
    }
    if (data.concept) document.getElementById('char_concept').value = data.concept;
    if (data.notes) document.getElementById('char_notes').value = data.notes;
    // Alignment
    if (data.alignment) this._syncAlignmentUI();
    // Restaurar selección de skills antes de llamar updateOptions,
    // para que buildSkills pueda marcar los checkboxes correctamente.
    const skillChecks = (data.checks||[]).filter(c => c.name==='chk_arq'||c.name==='chk_bg');
    this._skillsSel = {
      arq: new Set(skillChecks.filter(c=>c.name==='chk_arq').map(c=>c.value)),
      bg:  new Set(skillChecks.filter(c=>c.name==='chk_bg').map(c=>c.value))
    };
    // Apply identity selects FIRST so updateOptions can read them and build sel_filo options
    ['sel_desc','sel_arq','sel_bg'].forEach(id=>{const el=document.getElementById(id);if(el&&data.selects[id])el.value=data.selects[id];});
    this.updateOptions(false);
    // Now apply ALL selects (including sel_filo which now has its options populated)
    for (const id in data.selects) { const el=document.getElementById(id); if(el)el.value=data.selects[id]; }
    document.querySelectorAll('input[type=checkbox],input[type=radio]').forEach(el=>el.checked=false);
    document.querySelectorAll('input[name="chk_talents_hidden"]').forEach(el=>el.remove());
    data.checks?.forEach(item=>{let el=document.getElementById(item.id)||document.querySelector(`input[name="${item.name}"][value="${item.value}"]`);if(el)el.checked=true});
    data.hidden_talents?.forEach(t=>{const h=document.createElement('input');h.type='hidden';h.name='chk_talents_hidden';h.value=t.value;h.setAttribute('data-desc',t.desc||'');if(t.id)h.setAttribute('data-id',t.id);document.body.appendChild(h)});
    this.showTalentSummary(); this.updateTalentCount();
    // Close all sections to summary mode
    this.confirmPersonal();
    ['identity','stats','saves','skills','combat','equipment'].forEach(s=>this.confirmSection(s));
    this.renderInventory();
    this.calc();
  },

  saveChar() {
    if (this._saving) return;
    this._saving = true;
    const releaseSaving = () => { this._saving = false; };
    const name = document.getElementById('char_name').value.trim();
    if (!name) { releaseSaving(); this.toast('¡Se requiere nombre!', 'err'); return; }
    const roster = STORAGE.loadRoster();
    if (roster[name]) {
      // Pass releaseSaving as the cancel callback so the lock releases immediately
      this._confirm(
        '¿Sobreescribir personaje?',
        `El personaje "${this._esc(name)}" ya existe y será reemplazado.`,
        '✓ Sobreescribir',
        () => { this._doSaveChar(name, roster); releaseSaving(); },
        document.body,
        releaseSaving  // onCancel — releases lock right away
      );
    } else {
      this._doSaveChar(name, roster);
      releaseSaving();
    }
  },

  /** Marks the header as having unsaved changes. Suppressed during load/clear. */
  _markUnsaved() {
    if (this._charLoading) return;
    const lbl = document.getElementById('last_saved_lbl');
    if (!lbl) return;
    if (!lbl.classList.contains('fresh') && !lbl.classList.contains('unsaved')) {
      lbl.classList.add('unsaved');
      lbl.textContent = 'sin guardar';
    }
  },

  /** @param {string} name  @param {Object} [roster]  Pre-loaded roster to avoid a second localStorage read */
  _doSaveChar(name, roster) {
    roster = roster || STORAGE.loadRoster();
    roster[String(name)] = this.gatherCharData();
    const ok = STORAGE.saveRoster(roster);
    if (ok) {
      const ts  = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
      const lbl = document.getElementById('last_saved_lbl');
      if (lbl) {
        lbl.classList.remove('unsaved');
        lbl.textContent = `guardado ${ts}`;
        lbl.classList.add('fresh');
        setTimeout(()=>lbl.classList.remove('fresh'), TIMING.SAVED_FRESH);
      }
      // Flash the save button
      const saveBtn = document.querySelector('.app-hdr-save');
      if (saveBtn) {
        saveBtn.classList.remove('saved');
        void saveBtn.offsetWidth; // force reflow to restart animation
        saveBtn.classList.add('saved');
        setTimeout(() => saveBtn.classList.remove('saved'), 750);
      }
      this.toast('Personaje guardado','ok');
    } else {
      this.toast('¡Almacenamiento lleno! Exporta tu personaje.','err');
      setTimeout(()=>this.exportJSON(), 800);
    }
  },

  exportJSON() {
    const name = (document.getElementById('char_name').value.trim() || 'aventurero').replace(/ /g, '_');
    const a = document.createElement('a');
    a.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.gatherCharData(), null, 2));
    a.download = name + '.json';
    a.click();
  },

  loadJSON(input) {
    if (!input.files?.[0]) return;
    this.toast('Cargando personaje…', 'info');
    const r = new FileReader();
    r.onload = e => {
      try {
        const raw = JSON.parse(e.target.result);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Formato inválido: se esperaba un objeto');
        if (!raw.inputs) throw new Error('JSON de personaje inválido: falta campo inputs');
        // Normalize and validate character data
        const data = {
          inputs:       (typeof raw.inputs  === 'object' && !Array.isArray(raw.inputs))  ? raw.inputs  : {},
          selects:      (typeof raw.selects === 'object' && !Array.isArray(raw.selects)) ? raw.selects : {},
          checks:       Array.isArray(raw.checks)         ? raw.checks         : [],
          hidden_talents: Array.isArray(raw.hidden_talents) ? raw.hidden_talents : [],
          portrait:     typeof raw.portrait === 'string'  ? raw.portrait       : '',
          concept:      typeof raw.concept  === 'string'  ? raw.concept        : '',
          notes:        typeof raw.notes    === 'string'  ? raw.notes          : '',
          alignment:    typeof raw.alignment=== 'string'  ? raw.alignment      : '',
          inventory:    Array.isArray(raw.inventory)      ? raw.inventory      : [],
          gold:         isFinite(raw.gold)                ? Number(raw.gold)   : 0,
          lethality:    [1,2,3].includes(Number(raw.lethality)) ? Number(raw.lethality) : 1,
          apt_tricks:   Array.isArray(raw.apt_tricks)     ? raw.apt_tricks     : [],
          apt_spells:   Array.isArray(raw.apt_spells)     ? raw.apt_spells     : []
        };
        this._charLoading = true;
        this.clearCharData();
        this.showScreen('app');
        this.unlockApp();
        this.applyCharData(data);
        this.goToPage(0);
        const lbl = document.getElementById('last_saved_lbl');
        if (lbl) { lbl.textContent = ''; lbl.className = 'last-saved'; }
        this._charLoading = false;
        this.toast('Personaje importado','ok');
      } catch(err) { this.toast(err.message || 'JSON inválido','err'); }
    };
    r.readAsText(input.files[0]); input.value='';
  },

  triggerLoadJSON() { document.getElementById('json_char_input').click(); },

  clearCharData() {
    STATS.forEach(s=>{const el=document.getElementById('base_'+s);if(el)el.value=8});
    ['char_name','char_concept','char_notes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const lvlEl=document.getElementById('char_lvl');if(lvlEl)lvlEl.value=1;
    ['char_xp','cur_pv','cur_adr','cur_ing','cur_carne'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=0});
    this.inventory=[]; this.gold=0; this.alignment=''; this._aptSel={tricks:new Set(),spells:new Set()};
    this._skillsSel = { arq: new Set(), bg: new Set() };
    this._syncAlignmentUI();
    document.querySelectorAll('input[type=checkbox],input[type=radio]').forEach(c=>c.checked=false);
    document.querySelectorAll('input[name="chk_talents_hidden"]').forEach(el=>el.remove());
    this._syncPortrait(DEFAULT_PORTRAIT);
    const mg = document.getElementById('sel_magic_bonus'); if(mg)mg.value='0';
    const co = document.getElementById('sel_ca_other'); if(co)co.value='0';
    const cm1 = document.getElementById('ca_mod1'); if(cm1)cm1.value='DES';
    const cm2 = document.getElementById('ca_mod2'); if(cm2)cm2.value='NONE';
    const cm3 = document.getElementById('ca_mod3'); if(cm3)cm3.value='NONE';
    const wd1 = document.getElementById('w1_dmg_attr'); if(wd1)wd1.value='FUE';
    const wd2 = document.getElementById('w2_dmg_attr'); if(wd2)wd2.value='FUE';
    this.showTalentSummary(); this.updateTalentCount();
    this.renderInventory();
    // Reset derived calc data
    this._weaponAtkData = [0, 0];
    this._weaponDmgData = [{formula:'1',name:'Desarmado'},{formula:'1',name:'Desarmado'}];
    // Reset lethality to default
    this.setLethality(1);
    // Reset active talent category so next open starts fresh
    this.activeTalentCat = null;
    // El nuevo personaje arranca con los predeterminados globales de retrato
    this._resetCharPrefsToDefaults();
  },

  /* ─────────────────────────────────────────
   ── UI SETTINGS
   ───────────────────────────────────────── */
  /* ── FONT SIZE ──
     Todos los tamaños del CSS usan rem, que escalan desde el font-size de <html>.
     Cambiando document.documentElement.style.fontSize toda la interfaz responde. */
  setFontSize(size, persist = true) {
    // Normal = 16px (1rem base estándar del navegador).
    // Las opciones desplazan ±2px desde esa base.
    const map = {small:'13px', normal:'16px', large:'18px', xlarge:'20px'};
    const px = map[size] || '16px';
    // Cambiar el font-size del <html> escala todos los rem de la UI de golpe
    document.documentElement.style.fontSize = px;
    // persist=false al restaurar la preferencia de UN personaje, para no
    // convertirla en el predeterminado global de todos.
    if (persist) localStorage.setItem(STORAGE.KEYS.font, size);
    ['small','normal','large','xlarge'].forEach(s=>{
      const el = document.getElementById('fs_'+s);
      if (el) el.classList.toggle('active', s===size);
    });
  },

  _restoreFontSize() {
    const saved = localStorage.getItem(STORAGE.KEYS.font)||'normal';
    this.setFontSize(saved);
  },

  _restoreScrollPreserve() {
    this.scrollPreserve = localStorage.getItem(STORAGE.KEYS.scrollPreserve) === '1';
    this._syncScrollPreserveBtn();
  },

  /* ── PORTRAIT SIZE ── */
  setPortraitSize(size) {
    // size: 'xs'|'s'|'m'|'l'|'xl'
    const map = {
      xs: {w:'218px', h:'310px'},
      s:  {w:'250px', h:'356px'},
      m:  {w:'288px', h:'410px'},
      l:  {w:'330px', h:'472px'},
      xl: {w:'380px', h:'542px'}
    };
    const d = map[size] || map['m'];
    const root = document.documentElement;
    root.style.setProperty('--port-w', d.w);
    root.style.setProperty('--port-h', d.h);
    this._portSize = size;
    // Sync UI buttons
    document.querySelectorAll('.ps-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.size === size)
    );
    // Con un personaje abierto esto es solo VISTA PREVIA: el valor se
    // confirma con "✓ Aplicar al Personaje" y viaja en _prefs del
    // personaje. Solo sin personaje abierto (ajustes desde Inicio) se
    // persiste como predeterminado global de la app.
    if (!this._charOpen()) localStorage.setItem(STORAGE.KEYS.portSize, size);
  },

  /* ── PORTRAIT SHAPE ── */
  setPortraitShape(shape) {
    const shapes = {
      rect:    {r:'var(--r)',    clip:'none',                                                         poly:false},
      rounded: {r:'14px',        clip:'none',                                                         poly:false},
      arch:    {r:'140px 140px 8px 8px / 160px 160px 8px 8px', clip:'none',                          poly:false},
      circle:  {r:'50%',         clip:'none',                                                         poly:false},

    };
    const d = shapes[shape] || shapes['rect'];
    const root = document.documentElement;
    root.style.setProperty('--port-r',    d.r);
    root.style.setProperty('--port-clip', d.clip);
    // For polygon shapes, port-card border is clipped away — hide it,
    // the ::after pseudo (which shares the clip-path) renders the gold border instead
    this._portShape  = shape;
    this._portIsPoly = d.poly;
    // Apply shape to crop frame so editor previews the shape
    this._syncCropFrameShape(d);
    // Force immediate repaint on port-card-edit (prevents lag after shape change)
    const pce = document.querySelector('.port-card-edit');
    if (pce) { void pce.getBoundingClientRect(); }
    // Sync UI buttons
    document.querySelectorAll('.psh-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.shape === shape)
    );
    // Vista previa con personaje abierto; global solo desde Inicio.
    if (!this._charOpen()) localStorage.setItem(STORAGE.KEYS.portShape, shape);
  },

  /** Syncs crop frame appearance to the current portrait shape */
  _syncCropFrameShape(d) {
    const frame   = document.getElementById('crop_frame');
    const overlay = document.getElementById('crop_overlay');
    if (!frame) return;
    const crClips = {
      rect:    {r:'2px',   clip:'none', cls:''},
      rounded: {r:'14px',  clip:'none', cls:''},
      arch:    {r:'0',     clip:'none', cls:'arch'},
      circle:  {r:'50%',   clip:'none', cls:''},

    };
    const shape = this._portShape || 'rect';
    const cr = crClips[shape] || crClips['rect'];
    frame.style.setProperty('--crfr-r',    cr.r);
    frame.style.setProperty('--crfr-clip', cr.clip);
    frame.className = 'crfr' + (cr.cls ? ' ' + cr.cls : '');
    // Punch a matching hole in the overlay for non-rect shapes
    if (overlay) {
      if (cr.clip !== 'none') {
        // SVG clip on overlay to cut matching shape hole
        overlay.style.clipPath = 'none'; // handled via CSS on frame
      }
    }
  },

  _restorePortraitSettings() {
    const size  = localStorage.getItem(STORAGE.KEYS.portSize)  || 'm';
    const shape = localStorage.getItem(STORAGE.KEYS.portShape) || 'rect';
    this._portBorderMode = localStorage.getItem('ss_port_border') || 'premium';
    this._applyPortraitBorder();
    // Activado por defecto: los ajustes de retrato son por personaje
    // salvo que el usuario lo desactive explícitamente.
    this._perCharPrefs = localStorage.getItem('ss_per_char_prefs') !== '0';
    this.setPortraitSize(size);
    this.setPortraitShape(shape);
    this._charPrefs = { portSize: size, portShape: shape, portBorder: this._portBorderMode };
    const btn = document.getElementById('per_char_prefs_btn');
    if (btn) btn.setAttribute('aria-pressed', String(this._perCharPrefs));
    this._syncPortraitScopeUI();
    // Al cerrar Ajustes sin pulsar "✓ Aplicar al Personaje", descartar la
    // vista previa y volver a los valores confirmados del personaje.
    document.getElementById('settings_modal')
      ?.addEventListener('close', () => this._revertPortraitPreview());
  },

  /** ¿Hay un personaje abierto (pantalla de hoja visible)? */
  _charOpen() {
    const s = document.getElementById('app-screen');
    return !!s && !s.classList.contains('hidden');
  },

  /** Restaura los predeterminados globales (al crear/limpiar personaje). */
  _resetCharPrefsToDefaults() {
    const size   = localStorage.getItem(STORAGE.KEYS.portSize)  || 'm';
    const shape  = localStorage.getItem(STORAGE.KEYS.portShape) || 'rect';
    const border = localStorage.getItem('ss_port_border')        || 'premium';
    this._charPrefs = { portSize: size, portShape: shape, portBorder: border };
    this.setPortraitSize(size);
    this.setPortraitShape(shape);
    this._portBorderMode = border;
    this._applyPortraitBorder();
  },

  /** Descarta una vista previa de retrato no confirmada. */
  _revertPortraitPreview() {
    if (!this._charOpen() || !this._charPrefs) return;
    const c = this._charPrefs;
    const dirty = this._portSize !== c.portSize ||
                  this._portShape !== c.portShape ||
                  this._portBorderMode !== c.portBorder;
    if (!dirty) return;
    this.setPortraitSize(c.portSize);
    this.setPortraitShape(c.portShape);
    this._portBorderMode = c.portBorder;
    this._applyPortraitBorder();
    this.toast('Vista previa descartada — el personaje conserva sus ajustes', 'info');
  },

  setTheme(id) {
    const tid = id || 'deco';
    document.documentElement.setAttribute('data-theme', tid);
    this._theme = tid;
    document.querySelectorAll('.theme-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.theme === tid)
    );
    localStorage.setItem('ss_theme', tid);
  },

  _restoreTheme() {
    this.setTheme(localStorage.getItem('ss_theme') || 'deco');
  },

  /** Set background image for home or app. src = base64 data URL or '' to clear */
  setBgImage(target, src) {
    const prop = target === 'home' ? '--bg-home' : '--bg-app';
    const key  = target === 'home' ? 'ss_bg_home' : 'ss_bg_app';
    if (src) {
      document.documentElement.style.setProperty(prop, 'url("' + src + '")');
      document.documentElement.style.setProperty('--bg-overlay-op', '1');
      localStorage.setItem(key, src);
    } else {
      document.documentElement.style.setProperty(prop, 'none');
      // Only remove overlay if both are clear
      const otherKey = target === 'home' ? 'ss_bg_app' : 'ss_bg_home';
      if (!localStorage.getItem(otherKey)) {
        document.documentElement.style.setProperty('--bg-overlay-op', '0');
      }
      localStorage.removeItem(key);
    }
    const btn = document.getElementById('bg_' + target + '_clear');
    if (btn) btn.style.display = src ? 'inline-flex' : 'none';
  },

  loadBgImage(target, input) {
    if (!input.files?.[0]) return;
    const file = input.files[0];
    // Accept any size — we compress client-side before storing
    this.toast('Procesando imagen…', 'info');
    const r = new FileReader();
    r.onload = e => {
      const img = new Image();
      img.onload = () => {
        // Resize to max 1400px on longest side, compress to JPEG 72%
        const MAX = 1400;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
          else        { w = Math.round(w * MAX / h); h = MAX; }
        }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressed = cv.toDataURL('image/jpeg', 0.72);
        this.setBgImage(target, compressed);
        this.toast('Fondo actualizado', 'ok');
      };
      img.onerror = () => this.toast('No se pudo cargar la imagen', 'err');
      img.src = e.target.result;
    };
    r.readAsDataURL(file);
    input.value = '';
  },

  _restoreBgImages() {
    const home = localStorage.getItem('ss_bg_home');
    const app  = localStorage.getItem('ss_bg_app');
    if (home) this.setBgImage('home', home);
    if (app)  this.setBgImage('app',  app);
  },

  /* ══════════════════════════════════════════
     AJUSTES & DATOS — apertura/cierre seguros
  ══════════════════════════════════════════ */

  /** Abre el modal de Ajustes sincronizando antes el estado de la UI. */
  openSettings() {
    // Ámbito por defecto contextual en cada apertura: con personaje abierto
    // (y prefs individuales activas) → "Este personaje"; si no → "Global".
    this._portScope = (this._charOpen() && this._perCharPrefs) ? 'char' : 'global';
    this._syncPortraitScopeUI();
    const dlg = document.getElementById('settings_modal');
    if (!dlg) return;
    if (!dlg.open) {
      if (typeof dlg.showModal === 'function') {
        try { dlg.showModal(); } catch (_) { dlg.setAttribute('open', ''); }
      } else dlg.setAttribute('open', '');       // fallback (entornos sin <dialog>)
    }
  },

  /** Cierra el <dialog> de Ajustes tolerando entornos sin close(). */
  _closeSettingsDlg() {
    const dlg = document.getElementById('settings_modal');
    if (!dlg) return;
    if (typeof dlg.close === 'function') { try { dlg.close(); return; } catch (_) {} }
    dlg.removeAttribute('open');
  },

  /** Cierra Ajustes con escudo: el toque de cierre no traspasa a la hoja. */
  closeSettings() {
    if (typeof UI !== 'undefined') this._settingsShieldRelease = UI.ghostShield();
    this._closeSettingsDlg();
  },

  /** "💾 Guardar" desde Ajustes: cierra el modal BAJO escudo y luego guarda.
      Sin el escudo, el click fantasma del toque (~300 ms después) aterriza
      sobre la hoja recién descubierta o sobre el diálogo de confirmación. */
  saveFromSettings() {
    if (typeof UI !== 'undefined') this._settingsShieldRelease = UI.ghostShield();
    this._closeSettingsDlg();
    // Siguiente tick: el confirm de sobreescritura ya no compite con el
    // top-layer del <dialog> y se renderiza por encima de la hoja.
    setTimeout(() => this.saveChar(), 0);
  },

  /* ══════════════════════════════════════════
     RETRATO — ámbito de aplicación
     'char'   → solo el personaje abierto (_prefs en su entrada del roster)
     'global' → predeterminado de la app (localStorage)
  ══════════════════════════════════════════ */

  setPortraitScope(scope) {
    this._portScope = (scope === 'global') ? 'global' : 'char';
    this._syncPortraitScopeUI();
  },

  /** Mantiene coherente el segmento de ámbito, el botón Aplicar y la ayuda. */
  _syncPortraitScopeUI() {
    const charOpen = this._charOpen();
    const canChar  = charOpen && this._perCharPrefs;
    if (!canChar) this._portScope = 'global';
    else if (!this._portScope) this._portScope = 'char';

    const segC = document.getElementById('port_scope_char');
    const segG = document.getElementById('port_scope_global');
    const btn  = document.getElementById('confirm_portrait_btn');
    const hint = document.getElementById('port_scope_hint');
    const isChar = this._portScope === 'char';

    if (segC) {
      segC.disabled = !canChar;
      segC.classList.toggle('active', isChar);
      segC.setAttribute('aria-pressed', String(isChar));
      segC.title = canChar ? 'Aplicar solo al personaje abierto'
        : (charOpen ? 'Activa "Ajustes individuales por personaje" para usar este ámbito'
                    : 'Abre un personaje para usar este ámbito');
    }
    if (segG) {
      segG.classList.toggle('active', !isChar);
      segG.setAttribute('aria-pressed', String(!isChar));
    }
    if (btn) btn.textContent = isChar ? '✓ Aplicar a este personaje' : '✓ Guardar como global';
    if (hint) hint.textContent = isChar
      ? 'Vista previa en vivo: se aplica solo al personaje abierto al pulsar el botón. Si cierras sin aplicar, se descarta.'
      : (charOpen
          ? 'Fija el predeterminado para nuevos personajes y para los que no tengan ajustes propios. El personaje abierto conserva los suyos al cerrar.'
          : 'Fija el predeterminado para nuevos personajes y para los que no tengan ajustes propios.');
  },

  /** Aplica la vista previa del retrato según el ámbito seleccionado. */
  applyPortraitSettings() {
    if (this._portScope !== 'global' && this._charOpen()) {
      this.confirmPortraitSettings();              // flujo por-personaje existente
      return;
    }
    // GLOBAL: persistir la vista previa actual como predeterminado de la app.
    const size   = this._portSize        || 'm';
    const shape  = this._portShape       || 'rect';
    const border = this._portBorderMode  || 'premium';
    localStorage.setItem(STORAGE.KEYS.portSize,  size);
    localStorage.setItem(STORAGE.KEYS.portShape, shape);
    localStorage.setItem('ss_port_border',       border);
    if (!this._charOpen()) {
      // Sin personaje abierto el global ES el estado visible: confirmarlo
      // evita que el cierre del modal lo revierta como "vista previa".
      this._charPrefs = { portSize: size, portShape: shape, portBorder: border };
    }
    const btn = document.getElementById('confirm_portrait_btn');
    if (btn) { btn.classList.add('success'); setTimeout(() => btn.classList.remove('success'), 560); }
    this.toast('Guardado como predeterminado global', 'ok');
  },

  /** Confirma la vista previa de retrato SOLO para el personaje abierto. */
  confirmPortraitSettings() {
    const flash = () => {
      const btn = document.getElementById('confirm_portrait_btn');
      if (btn) { btn.classList.add('success'); setTimeout(() => btn.classList.remove('success'), 560); }
    };
    if (!this._charOpen()) {
      // Sin personaje abierto los botones ya fijaron el predeterminado global.
      this.toast('Guardado como predeterminado para nuevos personajes', 'ok');
      flash();
      return;
    }
    // 1) Confirmar la vista previa como estado del personaje actual.
    this._charPrefs = {
      portSize:   this._portSize        || 'm',
      portShape:  this._portShape       || 'rect',
      portBorder: this._portBorderMode  || 'premium',
    };
    // 2) Persistir _prefs directamente en SU entrada del roster (solo la
    //    suya: ningún otro personaje ni el predeterminado global se tocan).
    //    Así "Aplicar" sobrevive aunque luego no pulsen "Guardar".
    const name = document.getElementById('char_name')?.value.trim();
    let persisted = false;
    if (name) {
      const roster = STORAGE.loadRoster();
      if (roster[name]) {
        roster[name]._prefs = { ...(roster[name]._prefs || {}), ...this._charPrefs };
        persisted = STORAGE.saveRoster(roster);
      }
    }
    if (!persisted) this._markUnsaved();  // personaje aún no guardado: viajará en _prefs al guardar
    this.toast(`Retrato aplicado solo a ${name ? `"${this._esc(name)}"` : 'este personaje'}`, 'ok');
    flash();
  },

  togglePortraitBorder() {
    // Cycles: premium → subtle (old look) → back
    // _portBorderMode: 'premium' | 'subtle'
    this._portBorderMode = (this._portBorderMode === 'premium') ? 'subtle' : 'premium';
    this._applyPortraitBorder();
    // Vista previa con personaje abierto; global solo desde Inicio.
    if (!this._charOpen()) localStorage.setItem('ss_port_border', this._portBorderMode);
  },

  _applyPortraitBorder() {
    const mode = this._portBorderMode || 'premium';
    document.body.classList.remove('port-border-subtle', 'port-border-none');
    if (mode === 'subtle') document.body.classList.add('port-border-subtle');
    // Fraseo positivo en la UI: pressed=true ⇒ "Borde Premium" ACTIVO.
    const btn = document.getElementById('port_border_btn');
    if (btn) btn.setAttribute('aria-pressed', mode === 'premium' ? 'true' : 'false');
  },

  togglePerCharPrefs() {
    this._perCharPrefs = !this._perCharPrefs;
    const btn = document.getElementById('per_char_prefs_btn');
    if (btn) btn.setAttribute('aria-pressed', String(this._perCharPrefs));
    localStorage.setItem('ss_per_char_prefs', this._perCharPrefs ? '1' : '0');
    // Desactivado ⇒ el ámbito "Este personaje" deja de tener sentido.
    this._syncPortraitScopeUI();
  },

  toggleScrollPreserve() {
    this.scrollPreserve = !this.scrollPreserve;
    this._pageScrolls = {}; // reset saved positions when toggling
    localStorage.setItem(STORAGE.KEYS.scrollPreserve, this.scrollPreserve ? '1' : '0');
    this._syncScrollPreserveBtn();
  },

  _syncScrollPreserveBtn() {
    const btn = document.getElementById('scroll_preserve_btn');
    const lbl = document.getElementById('scroll_preserve_lbl');
    if (btn) btn.setAttribute('aria-pressed', String(this.scrollPreserve));
    if (lbl) lbl.textContent = this.scrollPreserve
      ? 'Desactivar recordar posición al volver'
      : 'Activar recordar posición al volver';
  },

  lethality: 1,

  setLethality(n) {
    this.lethality = n;
    // Toggle active on cards
    [1,2,3].forEach(i => {
      const el = document.getElementById('leth_'+i);
      if (el) el.classList.toggle('active', i === n);
    });
    // Update summary badge
    const TIERS = {
      1: { label:'Letalidad 1 — +1 PV/nivel', tier:'1' },
      2: { label:'Letalidad 2 — +2 PV/nivel', tier:'2' },
      3: { label:'Letalidad 3 — +3 PV/nivel', tier:'3' },
    };
    const t = TIERS[n] || TIERS[1];
    const badge = document.getElementById('campana_leth_badge');
    const lbl   = document.getElementById('campana_leth_label');
    if (badge) badge.dataset.tier = t.tier;
    if (lbl)   lbl.textContent    = t.label;
    this.calc();
  },

  editCampana() {
    document.getElementById('campana_summary').style.display = 'none';
    document.getElementById('campana_edit').style.display = 'block';
    document.getElementById('campana_edit_btn').style.display = 'none';
  },

  confirmCampana() {
    document.getElementById('campana_edit').style.display = 'none';
    document.getElementById('campana_summary').style.display = 'block';
    document.getElementById('campana_edit_btn').style.display = '';
  },

  _setupEscapeKey() {
    document.addEventListener('keydown', e => {
      // ── Ctrl+S / Cmd+S → save current character ──
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const appScreen = document.getElementById('app-screen');
        if (appScreen && !appScreen.classList.contains('hidden')) this.saveChar();
        return;
      }

      if (e.key !== 'Escape') return;

      // ── Escape → close the top-most open layer ──
      // 1. Speed dial menu
      const menu = document.getElementById('sdial_menu');
      const btn  = document.querySelector('.sdial-btn');
      if (menu?.classList.contains('open')) {
        menu.classList.remove('open');
        btn?.classList.remove('open');
        btn?.setAttribute('aria-expanded', 'false');
        return;
      }
      // 2. Dice overlay
      const dice = document.getElementById('dice-overlay');
      if (dice?.classList.contains('active')) {
        this.closeDiceOverlay();
        return;
      }
    });
  },

  toggleDial() {
    const menu = document.getElementById('sdial_menu');
    const btn  = document.querySelector('.sdial-btn');
    const open = menu.classList.toggle('open');
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      const _closeDial = () => {
        menu.classList.remove('open');
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      };
      // Close on click OR touchstart outside the dial — covers both desktop and mobile
      const _guard = (e) => {
        const dialEl = document.getElementById('sdial');
        if (!dialEl?.contains(e.target)) { _closeDial(); }
      };
      setTimeout(() => {
        document.addEventListener('click',      _guard, {once:true});
        document.addEventListener('touchstart', _guard, {once:true, passive:true});
      }, 10);
    }
  },

  confirmClear() {
    this._confirm('¿Resetear hoja?', 'Se borrarán todos los datos del personaje actual.', '✓ Resetear', () => {
      this.clearCharData();
      if (this.DB.descriptors) this.unlockApp();
      // Anclar la vista en página 0 ANTES de abrir secciones en masa.
      // Sin esto el requestAnimationFrame de editSection('combat'/'equipment')
      // gana la carrera a goToPage y desplaza el pages-track a página 3.
      this.goToPage(0);
      this._pageScrolls = {}; // limpiar posiciones guardadas obsoletas
      this._bulkEditing = true;
      this.editSection('personal');
      ['identity','stats','saves','skills','combat','equipment'].forEach(s=>this.editSection(s));
      this._bulkEditing = false;
      this.toast('Hoja reseteada','ok');
    });
  },

  /** Delete the currently loaded character from the roster, then go home. */
  deleteCurrentChar() {
    const name = document.getElementById('char_name')?.value?.trim();
    if (!name) { this.toast('Guarda el personaje primero', 'err'); return; }
    const roster = STORAGE.loadRoster();
    if (!roster[name]) { this.toast('Este personaje no está guardado aún', 'err'); return; }
    this._confirm(
      '¿Eliminar personaje?',
      `"${this._esc(name)}" será eliminado permanentemente.`,
      '✓ Eliminar',
      () => {
        STORAGE.deleteChar(name);
        this.renderHome();
        this.showScreen('home');
        this.toast(`"${this._esc(name)}" eliminado`, 'ok');
      }
    );
  },

  randomize() {
    if (!this.DB.archetypes) { this.toast('Carga reglas primero','err'); return; }
    // Anclar vista en página 0 y suprimir _markUnsaved durante la generación
    this._charLoading = true;
    this.clearCharData();
    this.unlockApp();
    this.goToPage(0);
    this._pageScrolls = {}; // limpiar posiciones guardadas obsoletas

    // 1. Stats — Método A (v5.2): 4d6, descarta el menor
    STATS.forEach(s => {
      const dice = [0,0,0,0].map(() => Math.floor(Math.random()*6)+1).sort((a,b)=>a-b);
      const roll = dice[1] + dice[2] + dice[3]; // suma los 3 mayores
      const el = document.getElementById('base_'+s); if(el) el.value = roll;
    });

    // 2. Nombre aleatorio
    const NAMES = ['Aldric','Bryna','Castan','Delara','Elowen','Fendrel','Gwyn','Hadria','Iskar','Jalinda','Kestrel','Lyara','Morden','Nyla','Oswin','Petra','Quillon','Ressa','Solen','Tindra','Ulvar','Vessa','Wren','Xera','Ylan','Zora'];
    document.getElementById('char_name').value = NAMES[Math.floor(Math.random()*NAMES.length)];

    // 3. Nivel 1, XP 0
    document.getElementById('char_lvl').value = 1;
    document.getElementById('char_xp').value = 0;

    // 4. Selecciones aleatorias (después de unlockApp que llena los selects)
    const randSelect = (id, db) => {
      const el = document.getElementById(id); if (!el) return;
      const keys = Object.keys(db||{});
      if (keys.length) el.value = keys[Math.floor(Math.random()*keys.length)];
    };
    randSelect('sel_desc', this.DB.descriptors);
    randSelect('sel_arq', this.DB.archetypes);
    randSelect('sel_bg', this.DB.backgrounds);

    // 5. Alineamiento aleatorio
    const ali = ALIGNMENTS[Math.floor(Math.random()*ALIGNMENTS.length)];
    this.alignment = ali;
    this._syncAlignmentUI();

    // 6. updateOptions para construir filos y habilidades (ya tiene arq/desc/bg en los selects)
    this.updateOptions(true);

    // 7. Filo aleatorio (ahora los options ya existen)
    const filoSel = document.getElementById('sel_filo');
    if (filoSel.options.length > 1) filoSel.value = filoSel.options[Math.floor(Math.random()*(filoSel.options.length-1))+1].value;
    this.calc(); // sync res_filo_val immediately

    // 8. Salvaciones aleatorias
    const saveCommon = ['DES','CON','SAB']; const saveUncommon = ['FUE','INT','CAR'];
    const sc = saveCommon[Math.floor(Math.random()*saveCommon.length)];
    const su = saveUncommon[Math.floor(Math.random()*saveUncommon.length)];
    const rsc = document.querySelector(`input[name="save_common"][value="${sc}"]`); if(rsc)rsc.checked=true;
    const rsu = document.querySelector(`input[name="save_uncommon"][value="${su}"]`); if(rsu)rsu.checked=true;

    // 9. Habilidades aleatorias (del arquetipo y trasfondo)
    const randCheck = (name, lim) => {
      const boxes = Array.from(document.querySelectorAll(`input[name="${name}"]`));
      boxes.sort(()=>Math.random()-.5).slice(0,lim).forEach(b=>b.checked=true);
    };
    const arqLimitRand = this.DB.archetypes?.[document.getElementById('sel_arq').value]?.skills_count || 2;
    randCheck('chk_arq', arqLimitRand);
    randCheck('chk_bg', 2);

    // 10. Talentos aleatorios (3)
    const allTalents = [];
    Object.values(this.DB.talents||{}).forEach(arr=>arr.forEach(t=>allTalents.push(t)));
    allTalents.sort(()=>Math.random()-.5).slice(0,3).forEach(t=>{
      const h=document.createElement('input');h.type='hidden';h.name='chk_talents_hidden';
      h.value=t.name;h.setAttribute('data-desc',t.desc||'');if(t.id)h.setAttribute('data-id',t.id);
      document.body.appendChild(h);
    });
    this.updateTalentCount();
    this.showTalentSummary();

    // 11. Inventario básico
    const weapons = Object.entries(this.DB.weapons||{});
    const armors = Object.entries(this.DB.armors||{}).filter(([k])=>k!=='laminar');
    if (armors.length) { const [k,v]=armors[Math.floor(Math.random()*armors.length)]; this.inventory.push({uid:this._nextUid(),name:v.name,slots:v.slots||1,type:'armors',dbKey:k,dbData:v}); }
    if (weapons.length) { const [k,v]=weapons[Math.floor(Math.random()*weapons.length)]; this.inventory.push({uid:this._nextUid(),name:v.name,slots:v.slots||1,type:'weapons',dbKey:k,dbData:v}); }
    this.inventory.push({uid:this._nextUid(),name:'Raciones (×5) · Ud8',slots:1,type:'misc'});
    this.inventory.push({uid:this._nextUid(),name:'Antorchas (×5) · Ud6',slots:1,type:'misc'});
    this.inventory.push({uid:this._nextUid(),name:'Morral / Mochila (+5 slots)',slots:1,type:'misc'});
    // Monedas iniciales por Arquetipo (v5.2): Audaz 5d6, Sutil 4d6, Sagaz 3d6 — ×10 pp
    const arqKeyRand = document.getElementById('sel_arq')?.value || 'sutil';
    const coinDice = { audaz:5, sutil:4, sagaz:3 }[arqKeyRand] || 4;
    let coinRoll = 0; for (let c=0;c<coinDice;c++) coinRoll += Math.floor(Math.random()*6)+1;
    this.gold = coinRoll * 10;
    this.syncCombatOptions();

    // 12. Equipar
    if (this.inventory[0]?.type==='armors') { const s=document.getElementById('sel_armor'); if(s)s.value=this.inventory[0].uid; }
    if (this.inventory[1]?.type==='weapons') { const s=document.getElementById('sel_weapon'); if(s)s.value=this.inventory[1].uid; }
    this.onWeaponChange('w1'); this.onWeaponChange('w2');

    // 13. Calc
    this.calc();
    const pv=document.getElementById('max_pv'); const cpv=document.getElementById('cur_pv'); if(pv&&cpv)cpv.value=pv.textContent;
    const adr=document.getElementById('max_adr'); const cadr=document.getElementById('cur_adr'); if(adr&&cadr)cadr.value=adr.textContent;
    const ing=document.getElementById('max_ing'); const cing=document.getElementById('cur_ing'); if(ing&&cing)cing.value=ing.textContent;
    const carne=document.getElementById('res_carne'); const ccarne=document.getElementById('cur_carne'); if(carne&&ccarne)ccarne.value=carne.textContent;
    this.renderInventory();

    // 14. Cerrar TODAS las secciones en modo resumen
    this.confirmPersonal();
    ['identity','stats','saves','skills','combat','equipment'].forEach(s=>this.confirmSection(s));

    this.buildDetailPage();
    this._charLoading = false;
    this.toast('Personaje aleatorio listo','ok');
  },

  /* ── DEBOUNCE HELPER ──
   * Returns a debounced version of fn that delays invocation by ms.
   * Uses an arrow function so it inherits the enclosing `this` from
   * the app object — no .bind() needed at the call site.            */
  _debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

};
