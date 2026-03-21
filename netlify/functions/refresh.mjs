/**
 * refresh.mjs — Función scheduled de Netlify (cada 6 horas)
 *
 * Busca titulares internacionales de crisis y conflicto vía RSS,
 * genera versos amereidianos con Groq/Llama (poemas independientes
 * de la noticia, que usan las letras del titular como materia prima),
 * y almacena los pares {titular, versos} en Netlify Blobs.
 *
 * Se ejecuta con cron cada 6h.
 * También se puede invocar manualmente via GET /.netlify/functions/trigger-refresh
 */

import { getStore } from "@netlify/blobs";

// ── RSS ──

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

const FEEDS = [
  "https://feeds.bbci.co.uk/mundo/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
  "https://rss.dw.com/xml/rss-sp-all",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/america/portada"
];

// Palabras para filtrar titulares de crisis, conflicto y geopolítica.
// El titular es solo materia prima tipográfica — las letras del poema.
const PALABRAS_FILTRO = [
  // conflicto y guerra
  "guerra", "ataque", "bombardeo", "misil", "nuclear", "militar",
  "combate", "ofensiva", "defensa", "armas", "tropas", "ejército",
  "conflicto", "tensión", "amenaza", "represalia", "escalada",
  // geopolítica EEUU-Irán y Medio Oriente
  "irán", "iran", "eeuu", "trump", "teherán", "tehran", "ormuz",
  "golfo", "pérsico", "sanciones", "embargo", "petróleo", "crudo",
  "estrecho", "hormuz", "oriente", "medio", "siria", "irak", "yemen",
  "hezbolá", "hezbollah", "hamás", "hamas", "gaza", "israel",
  // crisis y emergencia
  "crisis", "emergencia", "refugiados", "éxodo", "desplazados",
  "muerte", "muertos", "víctimas", "civil", "civiles", "humanitaria",
  // energía y recursos
  "energía", "gas", "oleoducto", "opep", "barril", "precio",
  "suministro", "bloqueo", "ruta", "marítima", "buque", "tanquero",
  // diplomacia y poder
  "negociación", "acuerdo", "tratado", "otan", "onu", "consejo",
  "seguridad", "alianza", "coalición", "veto", "diplomacia"
];

// ── OpenAI ──

const API_URL = "https://api.openai.com/v1/chat/completions";
const LLM_MODEL = "gpt-4o";

const SYSTEM_PROMPT = `Eres un poeta amereidiano. Amereida es el poema épico de América: no conquista sino regalo, no proeza sino hallazgo, no descubrimiento sino travesía y abertura.

TU TAREA:
Recibes un titular de noticias. NO escribas sobre la noticia. El titular es solo materia prima de letras.
Tu poema es independiente. Trata sobre el territorio americano, sus materiales, sus animales, el oficio de habitar, el cuerpo, la travesía. Nunca sobre política, guerra ni actualidad.

REGLA FUNDAMENTAL:
NO copies palabras del titular. Si el titular dice "Trump", "guerra", "Irán", "ataque", "misil", "OTAN", "crisis", "militar", "petróleo", "bloqueo", "sanciones" — NINGUNA puede aparecer en tu poema.

POÉTICA AMEREIDIANA:
- VERBOS preferidos: irrumpir, rasgar, desvelar, atravesar, palpar, hallar, regalar, heredar, fundar, habitar, nombrar, principiar, consentir, abrirse.
- SUSTANTIVOS del territorio: borde, orilla, suelo, cueva, cabo, mapa, piedra, cobre, greda, madera, cuero, lana, hueso, río, pampa, selva, glaciar, estero, caleta, cerro, isla, laja, totora, quilas, basalto.
- SUSTANTIVOS amereidianos: hallazgo, don, travesía, herencia, gratuidad, rigor, fiesta, levedad, abertura, equívoco, primicia, regalo, trance, irrupción.
- ANIMALES: huemul, cóndor, loica, flamenco, guanaco, congrio, albatros, toro, ballena, zorro, puma, coipo, cisne, garza.
- La naturaleza no es metáfora de nada. Un río es un río.
- El corte entre versos abre algo inesperado. Que el tercer verso lleve a donde nadie esperaba.
- Cada palabra justifica su peso. Preferir la carencia.
- Cada verso es una frase con sentido gramatical completo. NO palabras sueltas. NO frases truncadas.

VOCABULARIO PROHIBIDO (nunca usar):
arena, viento, sombra, ceniza, esperanza, horizonte, aurora, amanecer, ocaso, alba, crepúsculo, destello, suspiro, murmullo, eco, alma, latido, brote, silencio, oscuridad, camino, sendero, huella, eterno, infinito, sueño, paz, guerra, dolor, sangre.

FORMA:
- Exactamente 3 versos.
- Cada verso: entre 4 y 7 palabras.
- Cada verso es una frase gramatical completa que se sostiene sola (no queda truncada).
- Total: entre 14 y 20 palabras.
- Sin rima. Sin métrica fija.

FORMATO:
- SOLO 3 versos, uno por línea.
- Sin puntuación. Sin comillas. Sin título. Sin explicación.
- Todo en minúsculas.`;

/**
 * limpiarVerso — normaliza espacios y elimina puntuación residual
 */
function limpiarVerso(verso) {
  return verso.trim()
    .replace(/[.,;:!?¡¿"""''—–\-]/g, "")  // quitar puntuación
    .replace(/\s+/g, " ")                    // normalizar espacios
    .toLowerCase();
}

/**
 * filtroCalidad — post-filtro que descarta poemas de baja calidad.
 * Revisa: palabras prohibidas, repetición entre versos, frases truncadas,
 * y palabras copiadas del titular.
 */
const PROHIBIDAS = new Set([
  "arena", "viento", "sombra", "ceniza", "esperanza", "horizonte",
  "aurora", "amanecer", "ocaso", "alba", "crepúsculo", "destello",
  "suspiro", "murmullo", "eco", "alma", "latido", "brote",
  "silencio", "oscuridad", "camino", "sendero", "huella",
  "eterno", "infinito", "sueño", "paz", "guerra", "dolor", "sangre"
]);

// Palabras de noticias/política que no deben filtrarse al poema
const PALABRAS_NOTICIA = new Set([
  "trump", "irán", "iran", "eeuu", "otan", "israel", "gaza", "hamas",
  "hamás", "misil", "misiles", "bombardeo", "militar", "militares",
  "sanciones", "petróleo", "crisis", "ataque", "ataques", "bloqueo",
  "coalición", "diplomacia", "negociación", "ofensiva", "represalia",
  "ejército", "tropas", "armas", "nuclear", "tanquero", "buque"
]);

function filtroCalidad(versos, titular) {
  const todosLimpio = versos.map(v => v.toLowerCase().trim());

  // 1. Verificar palabras prohibidas
  for (const verso of todosLimpio) {
    for (const palabra of verso.split(/\s+/)) {
      if (PROHIBIDAS.has(palabra)) {
        console.log(`Filtro: palabra prohibida "${palabra}"`);
        return false;
      }
    }
  }

  // 2. Verificar que no copie palabras del titular (sustantivos de 5+ letras)
  const palabrasTitular = titular.toLowerCase().split(/\s+/)
    .filter(p => p.length >= 5)
    .map(p => p.replace(/[^a-záéíóúñü]/g, ""));
  const palabrasTitularSet = new Set(palabrasTitular);

  let copiadas = 0;
  for (const verso of todosLimpio) {
    for (const palabra of verso.split(/\s+/)) {
      if (palabra.length >= 5 && palabrasTitularSet.has(palabra)) {
        copiadas++;
      }
    }
  }
  if (copiadas > 1) {
    console.log(`Filtro: ${copiadas} palabras copiadas del titular`);
    return false;
  }

  // 3. Verificar que no hay demasiada repetición entre versos
  const palabrasUsadas = {};
  for (const verso of todosLimpio) {
    for (const palabra of verso.split(/\s+/)) {
      if (palabra.length >= 4) {  // ignorar artículos y preposiciones cortas
        palabrasUsadas[palabra] = (palabrasUsadas[palabra] || 0) + 1;
      }
    }
  }
  for (const [palabra, count] of Object.entries(palabrasUsadas)) {
    if (count >= 3) {
      console.log(`Filtro: "${palabra}" repetida ${count} veces`);
      return false;
    }
  }

  // 4. Verificar que cada verso tiene al menos un verbo o estructura sustantiva
  //    (heurística: al menos una palabra de 4+ letras que no sea artículo)
  for (const verso of todosLimpio) {
    const palabrasLargas = verso.split(/\s+/).filter(p => p.length >= 4);
    if (palabrasLargas.length < 2) {
      console.log(`Filtro: verso demasiado simple "${verso}"`);
      return false;
    }
  }

  return true;
}

// ── Cantidad de items a generar por refresco ──

// Generar 6 haikus por refresco (~6s, cabe en el timeout de 10s de Netlify)
// Se acumulan en un pool rotativo de 24, descartando los más antiguos
const ITEMS_POR_REFRESH = 6;
const MAX_POOL = 24;

// ── Funciones auxiliares ──

/**
 * puntuarTitular — puntaje de "interés poético" basado en palabras con sustancia
 */
function puntuarTitular(titular) {
  const t = titular.toLowerCase();
  let puntaje = 0;
  for (const palabra of PALABRAS_FILTRO) {
    if (t.includes(palabra)) puntaje++;
  }
  // Bonus por largo (titulares más largos suelen tener más contenido concreto)
  puntaje += Math.min(t.split(" ").length / 10, 1);
  return puntaje;
}

/**
 * obtenerTitulares — busca titulares de todos los feeds RSS
 */
async function obtenerTitulares() {
  let todos = [];

  const promesas = FEEDS.map(async (feed) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const url = RSS2JSON + encodeURIComponent(feed);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await resp.json();
      if (data.status === "ok" && data.items) {
        return data.items.map(item => item.title);
      }
    } catch (e) {
      console.log("Feed falló:", feed, e.message);
    }
    return [];
  });

  const resultados = await Promise.all(promesas);
  for (const titulares of resultados) {
    todos = todos.concat(titulares);
  }

  return todos;
}

/**
 * seleccionarMejores — puntúa y selecciona los N titulares con mayor interés poético
 */
function seleccionarMejores(titulares, n) {
  const puntuados = titulares.map(t => ({
    texto: t,
    puntaje: puntuarTitular(t)
  }));
  puntuados.sort((a, b) => b.puntaje - a.puntaje);

  // Tomar los mejores, evitando duplicados muy similares
  const seleccionados = [];
  const vistos = new Set();

  for (const item of puntuados) {
    if (seleccionados.length >= n) break;
    // Evitar titulares casi idénticos (primeras 40 chars)
    const clave = item.texto.toLowerCase().substring(0, 40);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    seleccionados.push(item.texto);
  }

  return seleccionados;
}

/**
 * validarVerso — validación estructural: 3 versos, 2-8 palabras c/u
 */
function validarVerso(versos) {
  if (versos.length !== 3) return false;
  for (const verso of versos) {
    const limpio = verso.trim();
    if (limpio.length < 4) return false;
    if (/[0-9@#$%^&*=+{}[\]|\\<>]/.test(limpio)) return false;
    if (/^(aquí|este|nota|verso|haiku|línea|sílaba|poema)/i.test(limpio)) return false;
    const palabras = limpio.split(/\s+/).length;
    if (palabras < 2 || palabras > 8) return false;
  }
  const totalPalabras = versos.reduce((s, v) => s + v.trim().split(/\s+/).length, 0);
  if (totalPalabras < 8 || totalPalabras > 22) return false;
  return true;
}

/**
 * contarComodines — cuenta cuántas letras del verso NO están disponibles
 * en el titular. Simula el matching letra-a-letra de sketch.js.
 */
function contarComodines(titular, versos) {
  const disponibles = titular.toLowerCase().replace(/\s/g, "").split("");
  const usadas = new Array(disponibles.length).fill(false);
  let comodines = 0;

  for (const verso of versos) {
    for (const ch of verso) {
      if (ch === " ") continue;
      let encontrada = false;
      for (let i = 0; i < disponibles.length; i++) {
        if (!usadas[i] && disponibles[i] === ch.toLowerCase()) {
          usadas[i] = true;
          encontrada = true;
          break;
        }
      }
      if (!encontrada) comodines++;
    }
  }
  return comodines;
}

/**
 * generarHaiku — llama a Groq para generar un haiku a partir de un titular
 * 
 * Recibe: titular de noticia (string)
 * Devuelve: array de 3 versos [verso1, verso2, verso3] o null si falla
 * 
 * Usado por: refresh.mjs en el handler principal (secuencialmente, con delay entre llamadas)
 */
async function generarHaiku(titular, apiKey) {
  try {
    // Enviar solicitud a Groq/Llama con el SYSTEM_PROMPT que define el estilo poético
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: titular }
        ],
        model: LLM_MODEL,
        stream: false,
        temperature: 1.3  // Temperatura alta para riesgo poético
      })
    });

    if (!resp.ok) {
      console.log("Groq respondió", resp.status, "para:", titular.substring(0, 50));
      return null;
    }

    const data = await resp.json();
    let texto = data.choices[0].message.content.trim();
    // Limpiar thinking tags (Qwen/reasoning models) y markdown
    texto = texto.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const textoLimpio = texto.replace(/\*\*/g, "").replace(/\*/g, "");
    const lineas = textoLimpio.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Extraer exactamente 3 versos (ignora explicaciones que Groq pueda agregar después)
    if (lineas.length >= 3) {
      const versos = lineas.slice(0, 3);
      if (validarVerso(versos)) {
        const versosLimpios = versos.map(limpiarVerso);
        if (!filtroCalidad(versosLimpios, titular)) {
          return null;
        }
        return versosLimpios;
      }
    }

    console.log("Formato inesperado para:", titular.substring(0, 50));
    return null;

  } catch (e) {
    console.log("Error generando haiku:", e.message);
    return null;
  }
}

// ── Handler principal ──

/**
 * Handler de refresh.mjs
 * 
 * Propósito: Tarea scheduled que se ejecuta cada 3 horas automáticamente
 * (también puede invocarse manualmente vía POST a /.netlify/functions/refresh)
 * 
 * Flujo general:
 *   1. Obtener titulares de todos los feeds RSS
 *   2. Seleccionar los N titulares más apocalípticos (basado en palabras clave)
 *   3. Para cada titular: generar un haiku llamando a Groq (secuencial, con pausa)
 *   4. Almacenar todos los pares {titular, versos} en Netlify Blobs
 */
export default async (req) => {
  const apiKey = Netlify.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    console.log("OPENAI_API_KEY no configurada");
    return new Response(JSON.stringify({ error: "API key no configurada" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  console.log("Iniciando refresco de caché...");

  // PASO 1: Obtener titulares de todos los feeds RSS
  // Realiza 3 solicitudes en paralelo (una por feed), con timeout de 10 segundos cada una
  // Devuelve un array con todos los titulares encontrados
  const titulares = await obtenerTitulares();
  if (titulares.length === 0) {
    console.log("No se obtuvieron titulares de ningún feed");
    return new Response(JSON.stringify({ error: "Sin titulares" }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });
  }

  console.log(`Obtenidos ${titulares.length} titulares de RSS`);

  // PASO 2: Seleccionar los titulares con mayor interés poético
  // Puntúa cada titular según la presencia de palabras con sustancia (PALABRAS_POETICAS)
  // Toma los N=ITEMS_POR_REFRESH más altos, evitando duplicados muy similares
  const mejores = seleccionarMejores(titulares, ITEMS_POR_REFRESH);
  console.log(`Seleccionados ${mejores.length} titulares para generar haikus`);

  // PASO 3: Generar verso para cada titular (SECUENCIAL, no paralelo)
  // Filtro inter-poemas: rechaza versos que repitan sustantivos del batch
  const items = [];
  const sustantivosUsados = new Set();  // sustantivos (5+ letras) ya usados en el batch

  for (const titular of mejores) {
    const versos = await generarHaiku(titular, apiKey);
    if (versos) {
      // Filtro inter-poemas: verificar que no repita sustantivos del batch
      const sustantivosNuevos = [];
      let repetidos = 0;
      for (const verso of versos) {
        for (const palabra of verso.split(/\s+/)) {
          if (palabra.length >= 5) {
            if (sustantivosUsados.has(palabra)) {
              repetidos++;
            } else {
              sustantivosNuevos.push(palabra);
            }
          }
        }
      }
      if (repetidos > 1) {
        console.log(`Inter-filtro: ${repetidos} palabras repetidas del batch — descartado`);
        continue;
      }
      // Aceptado: registrar sustantivos
      for (const s of sustantivosNuevos) sustantivosUsados.add(s);
      items.push({ titular, versos });
      console.log(`OK: "${titular.substring(0, 40)}..." → ${versos.join(" / ")}`);
    } else {
      console.log(`SKIP: "${titular.substring(0, 40)}..."`);
    }

    // PAUSA DE 800ms ENTRE LLAMADAS A GROQ
    // Respeta el rate limiting: 800ms * 12 items ≈ 10 segundos de generación
    // Deja margen para que refresh.mjs no exceda cuota gratuita
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`Generados ${items.length} haikus nuevos`);

  // PASO 4: Leer caché existente y acumular (pool rotativo de MAX_POOL)
  const store = getStore("haiku-cache");
  let poolAnterior = [];
  try {
    const raw = await store.get("current");
    if (raw) {
      const anterior = JSON.parse(raw);
      poolAnterior = anterior.items || [];
    }
  } catch (e) {
    console.log("Sin caché previo, iniciando pool nuevo");
  }

  // Agregar los nuevos al inicio, mantener máximo MAX_POOL
  const pool = [...items, ...poolAnterior].slice(0, MAX_POOL);

  const cacheData = {
    items: pool,
    refreshedAt: Date.now(),
    refreshedAtISO: new Date().toISOString(),
    totalTitulares: titulares.length,
    totalGenerados: items.length,
    totalEnPool: pool.length
  };

  await store.set("current", JSON.stringify(cacheData));
  console.log(`Pool: ${items.length} nuevos + ${poolAnterior.length} previos = ${pool.length} total`);

  return new Response(JSON.stringify({
    ok: true,
    nuevos: items.length,
    enPool: pool.length,
    refreshedAt: cacheData.refreshedAtISO
  }), {
    headers: { "Content-Type": "application/json" }
  });
};

// Cada 6 horas: 00:00, 06:00, 12:00, 18:00 UTC
export const config = {
  schedule: "0 */6 * * *"
};
