/**
 * sketch.js — News Haiku: de la catástrofe a la poesía
 *
 * Ciclo:
 * 1. CARGANDO:  Se obtiene un titular apocalíptico vía RSS + se genera el haiku
 * 2. TITULAR:   Texto grande, multi-línea, left-aligned. Se lee.
 * 3. CAYENDO:   Las letras NO-haiku pivotan en un vértice inferior y caen
 *               (escalonadas). Las letras del haiku se quedan y se tiñen rojas.
 * 4. VIAJANDO:  Las letras rojas viajan con easing a su posición en el haiku.
 * 5. HAIKU:     El haiku queda visible, estático.
 * 6. Pausa → nuevo ciclo.
 *
 * Usa Matter.js (0.12.0) para la caída física.
 * Las letras del haiku NO usan física: se mueven con interpolación ease-in-out.
 */

// ── Alias Matter.js ──
// Acortamos los nombres de las clases de Matter.js para escribir menos.
// En lugar de Matter.Engine.create() escribimos Engine.create().
// Esto hace el código más legible y rápido de escribir.
const Engine = Matter.Engine,
  World = Matter.World,
  Bodies = Matter.Bodies,
  Body = Matter.Body,
  Constraint = Matter.Constraint;

// ── Configuración ──
// Estos valores controlan la apariencia visual del canvas y del texto.
// El usuario los ve inmediatamente al reproducirse la animación.
const CANVAS_H = 480;                // altura fija del canvas (ancho es responsive)
const FONT_SIZE = 48;                // tamaño base del titular y del haiku
const FECHA_SIZE = 18;               // tamaño de la fecha debajo del titular
const MARGEN = 10;                   // espacio desde los bordes izquierdo y derecho
const SANGRIA_HAIKU = 10;           // indentación izquierda del haiku (centrado visual)
const GRAVITY = 0.8;                 // aceleración de gravedad Matter.js para las letras que caen

// Tiempos de cada estado en ms. Estos valores controlan cuánto ve el espectador
// cada fase de la animación. Ajustarlos cambia el ritmo narrativo completo.
const TIEMPOS = {
  FADEIN: 4000,        // el titular aparece gradualmente (fade-in suave)
  TITULAR: 6300,       // el titular es visible y legible (tiempo para leer)
  CAYENDO: 5500,       // las letras pivotan y caen (ventana de física)
  VIAJANDO: 6000,      // las letras rojas viajan suavemente a su posición en el haiku
  HAIKU: 12000,        // el haiku completo es visible (tiempo para contemplar)
  FADEOUT: 5500        // el haiku se desvanece (transición a ciclo siguiente)
};

// Paleta de colores. Define la transformación visual: el texto comienza negro
// y las letras del haiku transicionan a rojo (símbolo poético).
const COLORS = {
  bg: "#FFFFFF",           // fondo blanco
  texto: "#000000",        // texto del titular (negro)
  fecha: "#7e7d7d",        // fecha debajo (gris)
  haikuLetra: "#a83217",   // rojo para las letras que quedan en el haiku
  haiku: "#a83217"         // rojo del haiku (mismo que haikuLetra)
};

// ── Estados ──
// Máquina de estados que define el flujo narrativo de la animación.
// La variable estadoActual cambia secuencialmente: cada estado dibuja diferente
// y tiene su propia duración en TIEMPOS. Es como un guión ejecutable.
const ESTADO = { CARGANDO: 0, FADEIN: 1, TITULAR: 2, CAYENDO: 3, VIAJANDO: 4, HAIKU: 5, FADEOUT: 6 };

// ── Variables globales ──
let engine, world;
let suelo, paredIzq, paredDer;
let estadoActual = ESTADO.CARGANDO;
let tiempoEstado = 0;
let titularActual = "";
let haikuActual = null;
let fechaHoy = "";

/**
 * cacheItems — array de {titular, versos} precargados desde el backend.
 * Se obtiene una vez al inicio desde /.netlify/functions/cache
 * y el sketch rota entre ellos sin llamar a la API en cada ciclo.
 * Si el caché está vacío (dev local, primera vez), se usa el flujo
 * original: Noticias + Haiku en tiempo real.
 */
let cacheItems = [];
let cacheIndex = 0;
let cacheDisponible = false;

/**
 * letras[] — array principal. Cada elemento describe una letra del titular.
 *   .letra        char
 *   .x, .y        posición original (layout del titular)
 *   .w, .h        ancho y alto del glyph
 *   .tamano       font size actual
 *   .esHaiku      boolean: si participa en el haiku
 *   .body         Matter.js body (solo para las que caen)
 *   .pivotConstraint  constraint de pivot (solo durante pivoteo)
 *   .pivotDelay   ms antes de empezar a pivotear
 *   .unpinDelay   ms después del pivot para soltar
 *   .pivotIniciado, .soltada  flags de estado
 *   .objetivo     {x, y} posición final en el haiku
 *   .viajeT       progreso del viaje [0..1]
 *   .origenViaje  {x, y} posición al iniciar el viaje
 *   .opacidad     para desvanecer las que caen
 */
let letras = [];

// ── Setup ──
// setup() se ejecuta UNA SOLA VEZ al cargar la página.
// Aquí inicializamos el canvas, el motor de física y cargamos el caché.
// Después, draw() se ejecuta 60 veces por segundo (60 FPS).

function setup() {
  let cnv = createCanvas(windowWidth, CANVAS_H);
  cnv.parent("p5");
  textFont("Newsreader");

  let hoy = new Date();
  fechaHoy = hoy.toLocaleDateString("es-CL", {
    year: "numeric", month: "long", day: "numeric"
  });

  engine = Engine.create();
  world = engine.world;
  world.gravity.y = GRAVITY;

  crearLimites();
  cargarCache().then(() => iniciarCiclo());
}

/**
 * cargarCache — intenta obtener el caché de haikus con fallback encadenado.
 * Prueba 3 URLs en orden (cadena de fallback):
 *   1. /.netlify/functions/cache    (Netlify Function, producción, refrescado cada 6h)
 *   2. /cache.json                  (archivo estático en el repositorio)
 *   3. http://localhost:3001/cache  (servidor proxy local, desarrollo)
 * 
 * Si alguna funciona, cacheItems se llena y los ciclos rotan entre esos items
 * precompilados. Si todas fallan, el sketch usa el flujo en tiempo real
 * (busca titular vía RSS + genera haiku con Groq/fallback).
 * 
 * Al final, baraja (Fisher-Yates) los items para que cada sesión tenga orden distinto.
 */
async function cargarCache() {
  const CACHE_URLS = [
    "/.netlify/functions/cache",    // producción: Netlify Blobs (se refresca cada 12h)
    "/cache.json",                  // fallback: archivo estático commiteado en el repo
    "http://localhost:3001/cache"   // desarrollo local: proxy-server.js
  ];

  for (let i = 0; i < CACHE_URLS.length; i++) {
    try {
      const resp = await fetch(CACHE_URLS[i], {
        signal: AbortSignal.timeout(3000)
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();

      if (data.items && data.items.length > 0) {
        // Barajar (Fisher-Yates) para variedad en cada visita
        cacheItems = data.items;
        for (let j = cacheItems.length - 1; j > 0; j--) {
          let k = Math.floor(Math.random() * (j + 1));
          [cacheItems[j], cacheItems[k]] = [cacheItems[k], cacheItems[j]];
        }
        cacheIndex = 0;
        cacheDisponible = true;
        console.log("Caché cargado desde", CACHE_URLS[i] + ":",
          cacheItems.length, "items",
          "(refrescado:", data.refreshedAtISO || "?", ")");
        return; // éxito, no probar la siguiente URL
      }
    } catch (e) {
      // silencio, probar la siguiente
    }
  }

  console.log("Sin caché disponible — usando flujo en tiempo real");
}

// ── Límites físicos ──

/**
 * crearLimites — suelo y paredes invisibles para que las letras
 * que caen no se pierdan fuera del canvas.
 */
function crearLimites() {
  let opts = { isStatic: true, restitution: 0.3, friction: 0.5 };
  suelo = Bodies.rectangle(windowWidth / 2, CANVAS_H - 20, windowWidth + 200, 60, opts);
  paredIzq = Bodies.rectangle(-30, CANVAS_H / 2, 60, CANVAS_H * 2, opts);
  paredDer = Bodies.rectangle(windowWidth + 30, CANVAS_H / 2, 60, CANVAS_H * 2, opts);
  World.add(world, [suelo, paredIzq, paredDer]);
}

// ── Tipografía ──

/**
 * smartQuotes — reemplaza comillas rectas por comillas tipográficas.
 * Heurística: comilla después de espacio o inicio de cadena es de apertura.
 * También convierte apóstrofos rectos en curvos.
 */
function smartQuotes(texto) {
  // Dobles: " → " o "
  texto = texto.replace(/"([^"]*?)"/g, "\u201C$1\u201D");         // pares explícitos
  texto = texto.replace(/(^|[\s(])"/g, "$1\u201C");                // apertura suelta
  texto = texto.replace(/"/g, "\u201D");                           // cierre restante
  // Simples: ' → ' o '
  texto = texto.replace(/'([^']*?)'/g, "\u2018$1\u2019");         // pares explícitos
  texto = texto.replace(/(^|[\s(])'/g, "$1\u2018");                // apertura suelta
  texto = texto.replace(/'/g, "\u2019");                           // cierre / apóstrofo
  return texto;
}

// ── Ciclo principal ──

/**
 * iniciarCiclo — obtiene titular y haiku, crea letras, marca cuáles
 * son del haiku, y arranca la secuencia visual.
 *
 * Flujo con caché (producción): toma el siguiente item del caché (round-robin).
 * Flujo sin caché (desarrollo): busca titular vía RSS y genera haiku con Groq/fallback.
 */
async function iniciarCiclo() {
  world.gravity.y = GRAVITY;
  estadoActual = ESTADO.CARGANDO;
  tiempoEstado = millis();
  limpiarLetras();
  haikuActual = null;

  if (cacheDisponible && cacheItems.length > 0) {
    // ── Flujo con caché: rotar entre items pre-generados ──
    let item = cacheItems[cacheIndex];
    cacheIndex = (cacheIndex + 1) % cacheItems.length;

    titularActual = smartQuotes(item.titular);
    haikuActual = {
      versos: item.versos.map(smartQuotes),
      metrica: item.versos.map(v => Silabas.contarSilabasFrase(v)),
      titular: item.titular,
      motor: "cache"
    };

    console.log("Desde caché [" + (cacheIndex) + "/" + cacheItems.length + "]:",
      titularActual.substring(0, 50) + "...");

  } else {
    // ── Flujo en tiempo real (dev local o caché vacío) ──
    try {
      titularActual = await Noticias.obtenerPeorTitular();
    } catch (e) {
      titularActual = Noticias.obtenerTitularAleatorio();
    }
    if (!titularActual || titularActual.trim().length === 0) {
      titularActual = Noticias.obtenerTitularAleatorio();
    }

    titularActual = smartQuotes(titularActual);

    haikuActual = await Haiku.componerHaiku(titularActual);
    if (haikuActual) {
      haikuActual.versos = haikuActual.versos.map(smartQuotes);
    }
  }

  // Crear letras y marcar las del haiku
  crearLetras(titularActual);
  marcarLetrasHaiku();

  estadoActual = ESTADO.FADEIN;
  tiempoEstado = millis();
}

/**
 * limpiarLetras — elimina cuerpos y constraints del mundo
 */
function limpiarLetras() {
  for (let l of letras) {
    if (l.pivotConstraint) World.remove(world, l.pivotConstraint);
    if (l.body) World.remove(world, l.body);
  }
  letras = [];
}

// ── Creación de letras (layout multi-línea, left-aligned) ──

/**
 * crearLetras — posiciona cada carácter del titular como texto multi-línea
 * con word-wrap automático (izquierda alineado). No crea cuerpos de física;
 * eso ocurre cuando entramos en el estado CAYENDO.
 * 
 * Algoritmo:
 * 1. Dividir el texto en palabras (split por espacios)
 * 2. Para cada palabra, intentar agregarla a la línea actual
 * 3. Si la línea supera el ancho disponible, guardar línea actual e iniciar una nueva
 * 4. Medir posición de cada letra usando textWidth() (respeta kerning tipográfico)
 * 5. Guardar x, y, w, h de cada letra para poder referenciarlo después
 */
function crearLetras(texto) {
  let tam = FONT_SIZE;
  textSize(tam);
  let anchoDisponible = windowWidth - MARGEN * 2;

  // PASO 1: Word wrap manual — construir líneas respetando el ancho disponible
  let palabras = texto.split(/\s+/);
  let lineas = [];
  let lineaActual = "";

  // PASO 2 y 3: Para cada palabra, intentar agregarla; si no cabe, guardar línea e iniciar nueva
  for (let p of palabras) {
    let prueba = lineaActual.length === 0 ? p : lineaActual + " " + p;
    if (textWidth(prueba) > anchoDisponible && lineaActual.length > 0) {
      lineas.push(lineaActual);
      lineaActual = p;
    } else {
      lineaActual = prueba;
    }
  }
  if (lineaActual.length > 0) lineas.push(lineaActual);

  // PASO 4 y 5: Posicionar cada letra individualmente en el array
  // Calculamos baseline de cada línea y el ancho real de cada glyph
  let lineHeight = tam * 1.1;
  let startY = MARGEN + tam; // baseline de la primera línea

  for (let li = 0; li < lineas.length; li++) {
    let linea = lineas[li];
    let x = MARGEN;
    let y = startY + li * lineHeight;

    // Recorrer carácter por carácter en la línea actual
    for (let ci = 0; ci < linea.length; ci++) {
      let ch = linea[ci];
      let w = textWidth(ch);  // ancho real del glyph (respeta kerning)

      letras.push({
        letra: ch,
        x: x,
        y: y,
        w: w,
        h: tam,
        tamano: tam,
        esHaiku: false,
        // Física (se inicializan en CAYENDO, solo para no-haiku)
        body: null,
        pivotConstraint: null,
        pivotDelay: 0,
        unpinDelay: 0,
        pivotIniciado: false,
        soltada: false,
        // Viaje (solo haiku)
        objetivo: null,
        viajeT: 0,
        origenViaje: null,
        opacidad: 255
      });

      x += w;
    }
  }

  // Calcular posición de la fecha: debajo de la última línea
  // (se usa en dibujarFecha)
  letras._fechaY = startY + lineas.length * lineHeight + 10;
}

// ── Marcar letras del haiku ──

/**
 * marcarLetrasHaiku — determina qué letras del titular serán usadas
 * en el haiku. Empareja letra por letra (case-insensitive).
 * Las marcadas como esHaiku=true no caerán y se teñirán de rojo.
 *
 * Para las letras del haiku que NO existen en el titular, se crean
 * letras "fantasma" (esFantasma=true) que aparecerán con fade-in
 * durante el estado VIAJANDO, directamente en su posición destino.
 */
function marcarLetrasHaiku() {
  if (!haikuActual) return;

  // Construir lista de letras necesarias para el haiku (sin espacios)
  let necesarias = [];
  for (let v = 0; v < haikuActual.versos.length; v++) {
    let verso = haikuActual.versos[v];
    for (let c = 0; c < verso.length; c++) {
      if (verso[c] !== " ") {
        necesarias.push({ letra: verso[c], verso: v, posEnVerso: c, asignada: false });
      }
    }
  }

  // Recorrer las letras del titular e intentar emparejar
  for (let n of necesarias) {
    for (let l of letras) {
      if (l.esHaiku) continue;
      if (l.letra === " ") continue;
      if (l.letra.toLowerCase() === n.letra.toLowerCase() && !n.asignada) {
        l.esHaiku = true;
        l.haikuVerse = n.verso;
        l.haikuPos = n.posEnVerso;
        n.asignada = true;
        break;
      }
    }
  }

  // Crear letras fantasma para las que no encontraron par en el titular
  for (let n of necesarias) {
    if (n.asignada) continue;

    textSize(FONT_SIZE);
    let w = textWidth(n.letra);

    letras.push({
      letra: n.letra,
      x: 0,  // posición temporal, se asigna en calcularDestinosHaiku
      y: 0,
      w: w,
      h: FONT_SIZE,
      tamano: FONT_SIZE,
      esHaiku: true,
      esFantasma: true,  // flag: esta letra no viene del titular
      haikuVerse: n.verso,
      haikuPos: n.posEnVerso,
      body: null,
      pivotConstraint: null,
      pivotDelay: 0,
      unpinDelay: 0,
      pivotIniciado: false,
      soltada: false,
      objetivo: null,
      viajeT: 0,
      origenViaje: null,
      opacidad: 0,  // empieza invisible
      colorT: 1     // ya roja desde el inicio (no necesita transición negro→rojo)
    });
  }

  let fantasmas = letras.filter(l => l.esFantasma);
  if (fantasmas.length > 0) {
    console.log("Letras fantasma creadas:", fantasmas.length,
      "(" + fantasmas.map(l => l.letra).join("") + ")");
  }
}

// ── Iniciar caída: crear cuerpos con pivot para las NO-haiku ──

/**
 * iniciarCaida — crea un cuerpo Matter.js para cada letra no-haiku.
 * Cada cuerpo empieza estático. Tras pivotDelay se le pone un constraint
 * en el vértice inferior (pivot). Tras unpinDelay se suelta del todo.
 */
function iniciarCaida() {
  let idx = 0;
  for (let l of letras) {
    if (l.esHaiku || l.letra === " ") continue;

    // Crear cuerpo en la posición actual de la letra
    let cx = l.x + l.w / 2;
    let cy = l.y - l.h * 0.3; // centrar aprox en el glyph
    let cuerpo = Bodies.rectangle(cx, cy, Math.max(l.w, 4), l.h * 0.7, {
      restitution: 0.3,
      friction: 0.4,
      density: 0.003,
      isStatic: true // empieza estático
    });
    World.add(world, cuerpo);
    l.body = cuerpo;

    // Tiempos escalonados: las letras se van soltando gradualmente
    l.pivotDelay = random(200, TIEMPOS.CAYENDO * 0.6);
    l.unpinDelay = l.pivotDelay + random(400, 1200);
    l.pivotIniciado = false;
    l.soltada = false;

    idx++;
  }
}

/**
 * actualizarCaida — llamada cada frame durante CAYENDO.
 * Gestiona el ciclo: estático → pivot → caída libre.
 */
function actualizarCaida(t) {
  for (let l of letras) {
    if (l.esHaiku || l.letra === " " || !l.body) continue;

    // Fase 1: iniciar pivot (clavar vértice inferior)
    if (!l.pivotIniciado && t > l.pivotDelay) {
      l.pivotIniciado = true;
      // Hacer dinámico
      Body.setStatic(l.body, false);

      // Punto de pivot: vértice inferior (derecho o izquierdo, aleatorio)
      let lado = random() > 0.5 ? 1 : -1;
      let pivotX = l.body.position.x + (l.w / 2) * lado * 0.8;
      let pivotY = l.body.position.y + l.h * 0.3;

      let constraint = Constraint.create({
        pointA: { x: pivotX, y: pivotY },
        bodyB: l.body,
        pointB: { x: (l.w / 2) * lado * 0.8, y: l.h * 0.3 },
        stiffness: 0.9,
        length: 0
      });
      World.add(world, constraint);
      l.pivotConstraint = constraint;
    }

    // Fase 2: soltar el pivot (caída libre)
    if (l.pivotIniciado && !l.soltada && t > l.unpinDelay) {
      l.soltada = true;
      if (l.pivotConstraint) {
        World.remove(world, l.pivotConstraint);
        l.pivotConstraint = null;
      }
      // Pequeño empujón
      Body.applyForce(l.body, l.body.position, {
        x: random(-0.003, 0.003),
        y: random(0.001, 0.005)
      });
    }
  }
}

// ── Calcular destinos del haiku ──

/**
 * calcularDestinosHaiku — para cada letra marcada como esHaiku,
 * calcula su posición final en el layout del haiku.
 * Mismo tamaño que el titular, left-aligned con sangría SANGRIA_HAIKU.
 *
 * Estrategia: recorre cada verso carácter a carácter. Para los espacios
 * avanza usando el ancho de un espacio. Para las letras, busca la letra
 * del titular asignada a esa posición y usa SU ancho real (que puede ser
 * mayúscula) para calcular el avance en X. Así el kerning queda coherente
 * con lo que realmente se renderiza.
 */
function calcularDestinosHaiku() {
  if (!haikuActual) return;

  let tam = FONT_SIZE;
  textSize(tam);
  let lineHeight = tam * 1.1;
  let startY = MARGEN + tam;

  // Por cada verso, recopilar las letras del titular asignadas, en orden
  for (let v = 0; v < haikuActual.versos.length; v++) {
    let verso = haikuActual.versos[v];

    // Letras titulares asignadas a este verso, ordenadas por posición
    let letrasDelVerso = letras
      .filter(l => l.esHaiku && l.haikuVerse === v)
      .sort((a, b) => a.haikuPos - b.haikuPos);

    let x = SANGRIA_HAIKU;
    let y = startY + v * lineHeight;
    let idx = 0; // índice dentro de letrasDelVerso

    for (let c = 0; c < verso.length; c++) {
      if (verso[c] === " ") {
        // Espacio: avanzar por el ancho de un espacio
        x += textWidth(" ");
      } else {
        // Letra: asignar destino usando el ancho real del glyph
        if (idx < letrasDelVerso.length) {
          let l = letrasDelVerso[idx];
          l.objetivo = { x: x, y: y };
          if (l.esFantasma) {
            // Fantasma: aparece directo en destino (sin viaje)
            l.x = x;
            l.y = y;
            l.origenViaje = { x: x, y: y };
          } else {
            l.origenViaje = { x: l.x, y: l.y };
          }
          x += textWidth(l.letra);
          idx++;
        }
      }
    }
  }
}

// ── Easing ──

/**
 * easeInOutCubic — función de easing cúbica
 * Suave al inicio y al final, rápida en el medio.
 * Se usa para el viaje de las letras rojas.
 */
function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ── Draw loop ──

// draw() se ejecuta 60 veces por segundo. El espectador ve todo lo que aquí dibujamos.
// La máquina de estados controla qué se dibuja en cada momento.
function draw() {
  background(COLORS.bg);
  Engine.update(engine, 1000 / 60);

  let t = millis() - tiempoEstado;  // tiempo transcurrido en el estado actual

  switch (estadoActual) {
    case ESTADO.CARGANDO:
      // El espectador ve: texto gris "buscando titulares..." mientras cargamos
      dibujarCargando();
      break;

    case ESTADO.FADEIN:
      // El espectador ve: el titular aparece de forma gradual (fade-in suave)
      {
        let alfa = constrain(t / TIEMPOS.FADEIN, 0, 1) * 255;
        dibujarLetrasEstaticas(COLORS.texto, alfa);
        dibujarFecha(null, alfa);
      }
      if (t > TIEMPOS.FADEIN) {
        estadoActual = ESTADO.TITULAR;
        tiempoEstado = millis();
      }
      break;

    case ESTADO.TITULAR:
      // El espectador ve: el titular completo, legible, estático (tiempo para leer)
      dibujarLetrasEstaticas(COLORS.texto);
      dibujarFecha();
      if (t > TIEMPOS.TITULAR) {
        iniciarCaida();
        estadoActual = ESTADO.CAYENDO;
        tiempoEstado = millis();
      }
      break;

    case ESTADO.CAYENDO:
      // El espectador ve: las letras no-haiku pivotan y caen dramáticamente
      // Las letras del haiku se tiñen de rojo y se quedan quietas
      actualizarCaida(t);
      dibujarLetrasCayendo();
      dibujarFecha();
      if (t > TIEMPOS.CAYENDO) {
        calcularDestinosHaiku();
        estadoActual = ESTADO.VIAJANDO;
        tiempoEstado = millis();
      }
      break;

    case ESTADO.VIAJANDO:
      // El espectador ve: las letras rojas viajan suavemente a su posición final en el haiku
      // Las letras que caen continúan cayendo hasta el suelo (física)
      dibujarLetrasCayendo();
      animarViaje(t);
      dibujarFecha(t);  // la fecha se desvanece en paralelo
      if (t > TIEMPOS.VIAJANDO) {
        estadoActual = ESTADO.HAIKU;
        tiempoEstado = millis();
      }
      break;

    case ESTADO.HAIKU:
      // El espectador ve: el haiku completo en rojo, estático, legible (momento poético)
      dibujarLetrasCayendo();
      if (t > TIEMPOS.HAIKU) {
        estadoActual = ESTADO.FADEOUT;
        tiempoEstado = millis();
      }
      break;

    case ESTADO.FADEOUT:
      // El espectador ve: el haiku se desvanece gradualmente (transición visual suave)
      {
        let alfa = (1 - constrain(t / TIEMPOS.FADEOUT, 0, 1)) * 255;
        dibujarLetrasCayendo(alfa);
      }
      if (t > TIEMPOS.FADEOUT) {
        iniciarCiclo();
      }
      break;
  }
}

// ── Dibujo ──

/**
 * dibujarCargando — texto sutil mientras se cargan noticias
 */
function dibujarCargando() {
  fill(COLORS.fecha);
  noStroke();
  textSize(FECHA_SIZE);
  textAlign(LEFT, BASELINE);
  text("buscando titulares en las noticias...", MARGEN, CANVAS_H / 2);
}

/**
 * dibujarLetrasEstaticas — dibuja todas las letras en su posición original
 * (estado TITULAR y FADEIN). Color uniforme.
 * El parámetro alfa (0-255) controla la opacidad para el fade-in.
 */
function dibujarLetrasEstaticas(col, alfa) {
  let c = color(col);
  if (alfa !== undefined) c.setAlpha(alfa);
  fill(c);
  noStroke();
  textAlign(LEFT, BASELINE);
  for (let l of letras) {
    if (l.esFantasma) continue;  // las fantasma no aparecen en el titular
    textSize(l.tamano);
    text(l.letra, l.x, l.y);
  }
}

/**
 * dibujarLetrasCayendo — dibuja durante CAYENDO, VIAJANDO, HAIKU y FADEOUT.
 * Hay DOS RAMAS completamente diferentes según el tipo de letra:
 * 
 * RAMA 1 - Letras del haiku (esHaiku=true):
 *   - Se dibujan en ROJO (transición de color negro → rojo en 100 frames)
 *   - Posición fija (no física) o en viaje hacia el haiku
 *   - Las "fantasma" hacen fade-in durante VIAJANDO
 * 
 * RAMA 2 - Letras que caen (esHaiku=false):
 *   - Se dibujan DESDE SU CUERPO Matter.js (posición + rotación física)
 *   - Caen por gravedad, rebotan, se desvanecen con fade-out global
 *   - Se rotan según su ángulo de rotación en el mundo físico
 * 
 * El parámetro alfaGlobal (0-255) solo afecta a las letras que caen (para FADEOUT).
 */
function dibujarLetrasCayendo(alfaGlobal) {
  noStroke();
  for (let l of letras) {
    if (l.letra === " ") continue;

    if (l.esHaiku) {
      // Transición de color negro → rojo en 100 frames
      if (l.colorT === undefined) l.colorT = 0;
      l.colorT = min(l.colorT + 1 / 100, 1);
      let c = lerpColor(color(COLORS.texto), color(COLORS.haikuLetra), l.colorT);

      // Fantasma: fade-in progresivo durante VIAJANDO
      if (l.esFantasma) {
        let fantasmaAlfa = l.opacidad;
        if (alfaGlobal !== undefined) fantasmaAlfa = min(fantasmaAlfa, alfaGlobal);
        if (fantasmaAlfa <= 0) continue;
        c.setAlpha(fantasmaAlfa);
      } else if (alfaGlobal !== undefined) {
        c.setAlpha(alfaGlobal);
      }

      fill(c);
      textSize(l.tamano);
      textAlign(LEFT, BASELINE);
      text(l.letra, l.x, l.y);
    } else if (l.body) {
      // Letras físicas: posición del cuerpo Matter.js
      let pos = l.body.position;
      let ang = l.body.angle;

      // Detectar si la letra está "en reposo" cerca del suelo (velocidad baja)
      // y animar su opacidad gradualmente hacia 120 (semi-transparente)
      let vel = l.body.velocity;
      let speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed < 0.5) {
        // Inicializar opacidad propia si no existe
        if (l.alfaCaida === undefined) l.alfaCaida = 255;
        // Bajar gradualmente: ~2 unidades por frame → tarda ~67 frames en llegar a 120
        l.alfaCaida = max(120, l.alfaCaida - 2);
      }

      // Opacidad: usa alfaCaida si existe, luego aplica fade-out global (FADEOUT)
      let a = l.alfaCaida !== undefined ? l.alfaCaida : 255;
      if (alfaGlobal !== undefined) a = min(a, alfaGlobal);
      if (a <= 0) continue;

      fill(0, 0, 0, a);
      push();
      translate(pos.x, pos.y);
      rotate(ang);
      textSize(l.tamano);
      textAlign(CENTER, CENTER);
      text(l.letra, 0, 0);
      pop();
    }
  }
}

/**
 * animarViaje — mueve las letras del haiku desde su posición original
 * hasta su destino en el haiku, con easing cúbico.
 * Las letras fantasma hacen fade-in en su posición destino.
 */
function animarViaje(t) {
  let progreso = constrain(t / TIEMPOS.VIAJANDO, 0, 1);
  let eased = easeInOutCubic(progreso);

  for (let l of letras) {
    if (!l.esHaiku || !l.objetivo || !l.origenViaje) continue;

    if (l.esFantasma) {
      // Fade-in: opacidad sube de 0 a 255 durante el viaje
      l.opacidad = eased * 255;
    } else {
      l.x = lerp(l.origenViaje.x, l.objetivo.x, eased);
      l.y = lerp(l.origenViaje.y, l.objetivo.y, eased);
    }
  }
}

/**
 * dibujarFecha — fecha en gris, alineada left, debajo del titular.
 * Primer parámetro t: durante VIAJANDO controla fade-out progresivo.
 * Segundo parámetro alfaExplicito: opacidad directa (para FADEIN).
 */
function dibujarFecha(t, alfaExplicito) {
  let alfa = alfaExplicito !== undefined ? alfaExplicito : 255;
  // Durante VIAJANDO, la fecha se desvanece proporcionalmente al progreso
  if (estadoActual === ESTADO.VIAJANDO && t !== undefined) {
    let progreso = constrain(t / TIEMPOS.VIAJANDO, 0, 1);
    alfa = 255 * (1 - progreso);
  }
  if (alfa <= 0) return;

  let c = color(COLORS.fecha);
  c.setAlpha(alfa);
  fill(c);
  noStroke();
  textSize(FECHA_SIZE);
  textAlign(LEFT, BASELINE);
  let fy = letras._fechaY || CANVAS_H - 30;
  text(fechaHoy, MARGEN, fy);
}

// ── Eventos ──

/**
 * windowResized — se ejecuta cada vez que el usuario redimensiona la ventana.
 * Reconstruimos el canvas y los límites físicos porque:
 *   - El ancho del canvas cambia (responsive)
 *   - Las letras necesitan reposicionarse según el nuevo ancho
 *   - Las paredes invisibles (suelo, paredIzq, paredDer) deben ajustarse
 *     para contener las letras que caen en el nuevo espacio
 */
function windowResized() {
  resizeCanvas(windowWidth, CANVAS_H);
  World.remove(world, [suelo, paredIzq, paredDer]);
  crearLimites();
}

/**
 * mousePressed — interacción del usuario: click para saltar al siguiente haiku.
 * Solo funciona durante ESTADO.HAIKU (cuando el haiku es visible y estable).
 * Llamar a iniciarCiclo() reinicia la máquina de estados desde CARGANDO.
 */
function mousePressed() {
  if (estadoActual === ESTADO.HAIKU) {
    iniciarCiclo();
  }
}
