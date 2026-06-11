const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf-8');
const dom = new JSDOM(html, {
  url: 'https://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.navigator.vibrate = () => true;
// jsdom no expone structuredClone en el contexto window (los navegadores sí desde 2022)
window.structuredClone = (o) => JSON.parse(JSON.stringify(o));

// Load scripts in declared order (defer semantics). Se concatenan porque
// window.eval no comparte const/let entre llamadas (a diferencia del navegador,
// donde los scripts clásicos comparten el entorno léxico global).
const code = ['js/data.js','js/constants.js','js/storage.js','js/ui-dialogs.js','js/app.js','js/boot.js']
  .map(f => fs.readFileSync(f, 'utf-8')).join('\n;\n');
window.eval(code + '\n;window.__app = app; window.__STORAGE = STORAGE; window.__UI = UI;');
const { document } = window;
const app = window.__app;
const results = [];
const t = (name, fn) => { try { fn(); results.push('✓ ' + name); } catch (e) { results.push('✗ ' + name + ' — ' + e.message); } };

t('app.init() arranca sin errores', () => app.init());
t('Home screen renderiza roster', () => { if (!document.getElementById('home-roster')) throw new Error('no roster'); });
t('newChar() abre la hoja', () => { app.newChar(); if (document.getElementById('app-screen').classList.contains('hidden')) throw new Error('app-screen oculto'); });
t('calc() funciona', () => app.calc());
t('Selects de identidad poblados', () => { if (document.getElementById('sel_arq').options.length < 2) throw new Error('sel_arq vacío'); });
t('randomize() genera personaje completo', () => { app.randomize(); if (!document.getElementById('char_name').value) throw new Error('sin nombre'); });

// ── Test crítico: guardar → confirmar sobreescritura sin ghost-click ──
t('saveChar() guarda personaje nuevo', () => {
  app.saveChar();
  const roster = window.__STORAGE.loadRoster();
  if (!Object.keys(roster).length) throw new Error('roster vacío tras guardar');
});
t('saveChar() de nuevo abre diálogo de confirmación (UI.confirm)', () => {
  app.saveChar();
  if (!document.querySelector('.ui-confirm-overlay')) throw new Error('no apareció el diálogo');
  if (!document.querySelector('.ui-confirm-btn.ok')) throw new Error('sin botón OK');
});
t('Escudo activo: click externo durante el diálogo NO llega a la página', () => {
  let leaked = false;
  const back = document.querySelector('.app-hdr-save');
  back.addEventListener('click', () => { leaked = true; });
  back.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  if (leaked) throw new Error('el click traspasó al fondo');
});
t('Confirmar ejecuta onConfirm UNA sola vez y cierra', () => {
  const ok = document.querySelector('.ui-confirm-btn.ok');
  ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); // doble disparo simulado
  if (!document.querySelector('.ui-confirm-overlay').classList.contains('closing')) throw new Error('no cerró');
});
// avanzar timers reales un poco
setTimeout(() => {
  t('Escudo sigue absorbiendo el click fantasma post-cierre (ventana 450ms)', () => {
    let leaked = false;
    const back = document.querySelector('.app-hdr-save');
    const h = () => { leaked = true; };
    back.addEventListener('click', h);
    back.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    back.removeEventListener('click', h);
    if (leaked) throw new Error('el click fantasma traspasó');
  });
  setTimeout(() => {
    t('Tras la ventana, la página vuelve a ser interactiva', () => {
      let received = false;
      const back = document.querySelector('.app-hdr-save');
      const h = () => { received = true; };
      back.addEventListener('click', h);
      back.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      back.removeEventListener('click', h);
      if (!received) throw new Error('la página quedó bloqueada');
    });
    // ── Limpieza: el click del test anterior reactivó saveChar vía el
    //    dispatcher [data-action] y dejó un confirm abierto. Cancelarlo y
    //    esperar a que su escudo (450 ms) expire antes de los tests nuevos. ──
    const stray = document.querySelector('.ui-confirm-overlay:not(.closing) .ui-confirm-btn.cancel');
    if (stray) stray.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    setTimeout(() => {

    // ── Nuevos: Ajustes & Datos (v32) ──
    t('openSettings() abre el modal y sincroniza el ámbito del retrato', () => {
      app.openSettings();
      const dlg = document.getElementById('settings_modal');
      if (!dlg.open && !dlg.hasAttribute('open')) throw new Error('modal no abierto');
      const segC = document.getElementById('port_scope_char');
      if (!segC) throw new Error('falta selector de ámbito');
      // Con personaje abierto y prefs por personaje activas, el ámbito por defecto es "char"
      if (app._perCharPrefs && !segC.classList.contains('active')) throw new Error('ámbito char no activo');
    });
    t('Ámbito GLOBAL persiste tamaño/forma/borde como predeterminado', () => {
      app.setPortraitScope('global');
      app.setPortraitSize('l');
      app.setPortraitShape('circle');
      app.applyPortraitSettings();
      if (window.localStorage.getItem('ss_port_size') !== 'l') throw new Error('tamaño global no persistido');
      if (window.localStorage.getItem('ss_port_shape') !== 'circle') throw new Error('forma global no persistida');
    });
    t('Ámbito CHAR escribe _prefs en la entrada del roster', () => {
      app.setPortraitScope('char');
      app.setPortraitSize('s');
      app.applyPortraitSettings();
      const name = document.getElementById('char_name').value.trim();
      const prefs = window.__STORAGE.loadRoster()[name]?._prefs;
      if (!prefs || prefs.portSize !== 's') throw new Error('prefs por personaje no persistidas');
      // El global NO debe haberse tocado
      if (window.localStorage.getItem('ss_port_size') !== 'l') throw new Error('contaminó el global');
    });
    t('closeSettings() cierra bajo escudo (los clicks inmediatos se absorben)', () => {
      app.closeSettings();
      let leaked = false;
      const back = document.querySelector('.app-hdr-save');
      const h = () => { leaked = true; };
      back.addEventListener('click', h);
      back.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      back.removeEventListener('click', h);
      if (leaked) throw new Error('el toque de cierre traspasó a la hoja');
      app._settingsShieldRelease?.();   // liberar para no contaminar las siguientes pruebas
    });
    t('UI.ghostShield() expone liberación anticipada', () => {
      const release = window.__UI.ghostShield(10000);
      release(); release(); // idempotente
      let received = false;
      // Sonda NEUTRA (sin [data-action]): no debe reactivar saveChar vía dispatcher
      const probe = document.querySelector('.app-hdr-ttl');
      const h = () => { received = true; };
      probe.addEventListener('click', h);
      probe.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      probe.removeEventListener('click', h);
      if (!received) throw new Error('release() no liberó el escudo');
    });
    t('rollDice() funciona', () => app.rollDice('1d20+3', 'Prueba'));
    t('Inventario: addFromDB', () => { app.updateDbSelect(); app.addFromDB(); if (!app.inventory.length) throw new Error('inventario vacío'); });
    t('exportJSON genera datos válidos', () => { const d = app.gatherCharData(); JSON.parse(JSON.stringify(d)); if (!d.inputs) throw new Error('sin inputs'); });
    let armedFired = 0;
    t('Guardia de armado: un click fantasma SOBRE el botón OK no confirma', () => {
      app._confirm('Prueba', 'Guardia de armado', '✓ Sí', () => { armedFired++; });
      const overlays = document.querySelectorAll('.ui-confirm-overlay:not(.closing)');
      const ok = overlays[overlays.length - 1].querySelector('.ui-confirm-btn.ok');
      // Click sintetizado de móvil: detail >= 1 y SIN pointerdown previo → debe ignorarse
      ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      if (armedFired !== 0) throw new Error('el click fantasma confirmó la acción');
      // Activación por teclado (detail 0) → debe funcionar
      ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    setTimeout(() => {
      t('Guardia de armado: la activación de teclado sí ejecutó onConfirm (una vez)', () => {
        if (armedFired !== 1) throw new Error('onConfirm corrió ' + armedFired + ' veces');
      });
      console.log(results.join('\n'));
      const fails = results.filter(r => r.startsWith('✗'));
      process.exit(fails.length ? 1 : 0);
    }, 50);

    }, 500); // fin del bloque post-limpieza
  }, 500);
}, 200);
