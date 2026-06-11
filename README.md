# S&S Companion — v32

Hoja de personaje digital (PWA) para **Stars & Sorcery RPG**. Esta versión reestructura el monolito original de 7.800 líneas en un proyecto modular, corrige el bug de *touch bleed-through* del diálogo de confirmación y completa las piezas PWA que faltaban. **Toda la funcionalidad original se conserva** (verificado con suite de pruebas automatizada).


## Novedades v32 — Ajustes & Datos rediseñado

**Menú reordenado** (frecuencia de uso → acciones de datos al final): *Retrato → Interfaz → Apariencia (Tema + Fondo) → Datos (Personaje + Reglas)*. Se eliminó el botón redundante de cierre superior duplicado en lógica; el botón inferior "✓ Listo" se conserva por ergonomía de pulgar en móvil.

**Retrato con ámbito explícito.** Un control segmentado *"Aplicar a: Este personaje | Global (todos)"* hace visible lo que antes era implícito:

- **Este personaje** (por defecto con una hoja abierta): tamaño, forma y borde son vista previa en vivo; *"✓ Aplicar a este personaje"* los persiste en `_prefs` de SU entrada del roster sin tocar el global ni a otros personajes.
- **Global (todos)**: *"✓ Guardar como global"* fija el predeterminado de la app (nuevos personajes y los que no tengan ajustes propios). Único ámbito disponible desde Inicio o con "Ajustes individuales por personaje" desactivado (el segmento se deshabilita solo).
- El toggle **"Ajustes individuales por personaje"** (antes "Guardar ajustes con personaje") sigue siendo el interruptor maestro; **"Borde Premium"** pasó a fraseo positivo (activado = borde dorado), eliminando el doble negativo "Desactivar Borde Premium".

**Blindaje anti ghost-click ampliado** (`js/ui-dialogs.js`):

- **Capa 4 — guardia de armado**: el click sintetizado (~300 ms tras el `touchend`) que aterrice *sobre los propios botones* del diálogo recién abierto ya no puede activarlos: cada botón exige un `pointerdown` propio posterior a la apertura (las activaciones de teclado, `detail === 0`, se aceptan siempre). Antes, tocar "Guardar" justo donde luego aparece "✓ Sobreescribir" podía auto-confirmar.
- **`UI.ghostShield(ms)`**: escudo independiente reutilizable. `app.saveFromSettings()` y `app.closeSettings()` lo usan al cerrar el modal de Ajustes, de modo que el toque sobre "💾 Guardar"/"✓ Listo"/"✕" no traspasa a la hoja que queda al descubierto ni al diálogo de confirmación que aparece después.

La suite de humo crece a **22 pruebas** (todas en verde), incluyendo: ámbito global vs por-personaje sin contaminación cruzada, cierre de Ajustes bajo escudo, liberación anticipada del escudo y la guardia de armado contra clicks fantasma sobre el botón OK.

## Estructura del proyecto

```
ss-companion/
├── index.html          Markup semántico (sin CSS ni JS embebidos masivos)
├── manifest.json       Manifest PWA  ← NUEVO (antes referenciado pero inexistente)
├── sw.js               Service Worker offline-first  ← NUEVO (ídem)
├── css/
│   └── main.css        Tokens de diseño + toda la hoja de estilos
├── js/
│   ├── data.js         Base de datos de reglas por defecto (v5.2.2)
│   ├── constants.js    Constantes del sistema y temporizadores de UI
│   ├── storage.js      Persistencia versionada con migraciones (localStorage)
│   ├── ui-dialogs.js   Diálogos modales con escudo anti ghost-click  ← NUEVO
│   ├── app.js          Lógica principal (hoja, cálculo, dados, editores…)
│   └── boot.js         Arranque + registro/actualización del Service Worker
└── smoke.test.cjs      Suite de humo (Node + jsdom): 15 pruebas, todas en verde
```

Los scripts se cargan con `defer` en orden de dependencia y comparten el ámbito global del documento (patrón deliberado: cero *build step*, compatible con los manejadores declarativos del markup y con despliegue por simple copia de archivos).

## El bug corregido: toque que "traspasa" el botón de confirmación

**Síntoma.** Al pulsar **Guardar** sobre un personaje existente aparece el diálogo *"¿Sobreescribir personaje?"*. Al tocar **✓ Sobreescribir**, el toque atravesaba el diálogo y activaba lo que estuviera detrás (inputs de la hoja, el engranaje del header…).

**Causa raíz.** En móvil, el navegador sintetiza un evento `click` ~300 ms después del `touchend`, **en las mismas coordenadas**. El código anterior retiraba su bloqueador de eventos apenas 2 frames (~32 ms) después de cerrar, así que el click fantasma aterrizaba en la página ya desprotegida. Además, `onConfirm` podía ejecutarse dos veces (`pointerup` + `click`).

**Solución** (`js/ui-dialogs.js`), defensa en tres capas:

1. `preventDefault()` en `pointerup` sobre los botones → suprime el click sintetizado en origen donde el motor lo respeta.
2. Bloqueador en fase de **captura a nivel de `document`** para todos los eventos de puntero/táctiles/click que no nazcan dentro de la tarjeta del diálogo.
3. Tras cerrar, el bloqueador pasa a modo *absorber todo* y permanece vivo **450 ms** (> ventana de ~300 ms de iOS) antes de liberarse y devolver el foco al elemento invocador.

Extras del nuevo diálogo: ejecución única garantizada de `onConfirm`/`onCancel`, `role="alertdialog"` con trampa de foco y Escape, variante visual de **peligro** automática para acciones destructivas, animación de entrada/salida (respetando `prefers-reduced-motion`), *tick* háptico y cierre al tocar el fondo. `app._confirm` ahora delega aquí, de modo que **los 6 flujos de confirmación de la app** (sobreescribir, resetear, eliminar personaje, salir sin guardar, borrar entrada de reglas, limpiar talentos) quedan protegidos.

## PWA completada

- `sw.js`: precache del *app shell* (funciona 100 % offline), caché *stale-while-revalidate* para Google Fonts, versionado de caché y soporte del mensaje `SKIP_WAITING` que `boot.js` ya enviaba al tocar el aviso "Nueva versión disponible".
- `manifest.json`: instalable en pantalla de inicio, `display: standalone`, orientación retrato, colores del tema.

> Para subir una nueva versión: incrementa `CACHE_VERSION` en `sw.js`.

## Pruebas

```bash
npm install jsdom
node smoke_test.cjs
```

Cubre: arranque, render del roster, creación de hoja, cálculo, generador aleatorio, guardado, **apertura del diálogo de confirmación, bloqueo de clicks externos, ejecución única al confirmar, absorción del click fantasma post-cierre y recuperación de la interactividad**, tirada de dados, inventario y exportación JSON.

## Despliegue

Copia la carpeta a cualquier hosting estático (GitHub Pages, Netlify, un servidor propio). Requiere **HTTPS** (o `localhost`) para que el Service Worker se registre.

Para desarrollo local:

```bash
npx serve .          # o: python3 -m http.server
```
