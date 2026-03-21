/**
 * trigger-refresh.mjs — Regenerar caché de versos amereidianos via HTTP
 *
 * GET /.netlify/functions/trigger-refresh         → genera 6 versos nuevos (acumula en pool)
 * GET /.netlify/functions/trigger-refresh?full=1   → BORRA caché y genera 24 versos nuevos
 *
 * Usa la misma lógica de refresh.mjs pero como función HTTP invocable desde el navegador.
 * Configurada con timeout extendido (120s) para el modo full.
 */

import { getStore } from "@netlify/blobs";

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

const FEEDS = [
  "https://feeds.bbci.co.uk/mundo/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
  "https://rss.dw.com/xml/rss-sp-all",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/america/portada"
];

const PALABRAS_FILTRO = [
  "guerra", "ataque", "bombardeo", "misil", "nuclear", "militar",
  "combate", "ofensiva", "defensa", "armas", "tropas", "ejército",
  "conflicto", "tensión", "amenaza", "represalia", "escalada",
  "irán", "iran", "eeuu", "trump", "teherán", "tehran", "ormuz",
  "golfo", "pérsico", "sanciones", "embargo", "petróleo", "crudo",
  "estrecho", "hormuz", "oriente", "medio", "siria", "irak", "yemen",
  "hezbolá", "hezbollah", "hamás", "hamas", "gaza", "israel",
  "crisis", "emergencia", "refugiados", "éxodo", "desplazados",
  "muerte", "muertos", "víctimas", "civil", "civiles", "humanitaria",
  "energía", "gas", "oleoducto", "opep", "barril", "precio",
  "suministro", "bloqueo", "ruta", "marítima", "buque", "tanquero",
  "negociación", "acuerdo", "tratado", "otan", "onu", "consejo",
  "seguridad", "alianza", "coalición", "veto", "diplomacia"
];

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "qwen/qwen-3-32b";
const MAX_POOL = 24;

const SYSTEM_PROMPT = `Eres un poeta amereidiano. Amereida es el poema épico de América: no conquista sino regalo, no proeza sino hallazgo, no descubrimiento sino travesía y abertura.

TU TAREA:
Recibes un titular de noticias. NO escribas sobre la noticia. El titular es solo materia prima de letras.
Tu poema es independiente. Trata sobre el territorio americano, sus materiales, sus animales, el oficio de habitar, el cuerpo, la travesía. Nunca sobre política, guerra ni actualidad.

REGLA FUNDAMENTAL:
NO copies palabras del titular. Si el titular dice "Trump", "guerra", "Irán", "ataque", "misil", "OTAN", "crisis", "militar", "petróleo", "bloqueo", "sanciones" — NINGUNA puede aparecer en tu poema.

POÉTICA AMEREIDIANA:
- Nombra lo concreto: minerales, animales, plantas, herramientas, partes del cuerpo, accidentes geográficos. Cosas que se pueden tocar, ver, oler.
- Usa verbos amereidianos: irrumpir, rasgar, desvelar, atravesar, consentir, palpar, hallar, regalar, heredar, fundar, habitar, nombrar, principiar, abrirse.
- Entreteje lo concreto con lo amereidiano: el hallazgo, el don, la travesía, el borde, la herencia, la gratuidad, el rigor, la fiesta, la levedad, la abertura, el equívoco, la primicia.
- La naturaleza no es metáfora de nada. Un río es un río.
- El corte entre versos abre algo inesperado. Que el tercer verso lleve a donde nadie esperaba.
- Cada palabra justifica su peso. Preferir la carencia.
- Cada verso es una frase con sentido gramatical completo. NO palabras sueltas. NO frases truncadas. Cada verso se sostiene solo.

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

function puntuarTitular(titular) {
  const t = titular.toLowerCase();
  let puntaje = 0;
  for (const palabra of PALABRAS_FILTRO) {
    if (t.includes(palabra)) puntaje++;
  }
  puntaje += Math.min(t.split(" ").length / 10, 1);
  return puntaje;
}

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
  for (const titulares of resultados) todos = todos.concat(titulares);
  return todos;
}

function seleccionarMejores(titulares, n) {
  const puntuados = titulares.map(t => ({ texto: t, puntaje: puntuarTitular(t) }));
  puntuados.sort((a, b) => b.puntaje - a.puntaje);
  const seleccionados = [];
  const vistos = new Set();
  for (const item of puntuados) {
    if (seleccionados.length >= n) break;
    const clave = item.texto.toLowerCase().substring(0, 40);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    seleccionados.push(item.texto);
  }
  return seleccionados;
}

function limpiarVerso(verso) {
  return verso.trim()
    .replace(/[.,;:!?¡¿"""''—–\-]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const PROHIBIDAS = new Set([
  "arena", "viento", "sombra", "ceniza", "esperanza", "horizonte",
  "aurora", "amanecer", "ocaso", "alba", "crepúsculo", "destello",
  "suspiro", "murmullo", "eco", "alma", "latido", "brote",
  "silencio", "oscuridad", "camino", "sendero", "huella",
  "eterno", "infinito", "sueño", "paz", "guerra", "dolor", "sangre"
]);

const PALABRAS_NOTICIA = new Set([
  "trump", "irán", "iran", "eeuu", "otan", "israel", "gaza", "hamas",
  "hamás", "misil", "misiles", "bombardeo", "militar", "militares",
  "sanciones", "petróleo", "crisis", "ataque", "ataques", "bloqueo",
  "coalición", "diplomacia", "negociación", "ofensiva", "represalia",
  "ejército", "tropas", "armas", "nuclear", "tanquero", "buque"
]);

function filtroCalidad(versos, titular) {
  const todosLimpio = versos.map(v => v.toLowerCase().trim());

  for (const verso of todosLimpio) {
    for (const palabra of verso.split(/\s+/)) {
      if (PROHIBIDAS.has(palabra)) return false;
      if (PALABRAS_NOTICIA.has(palabra)) return false;
    }
  }

  const palabrasTitular = titular.toLowerCase().split(/\s+/)
    .filter(p => p.length >= 5)
    .map(p => p.replace(/[^a-záéíóúñü]/g, ""));
  const palabrasTitularSet = new Set(palabrasTitular);
  let copiadas = 0;
  for (const verso of todosLimpio) {
    for (const palabra of verso.split(/\s+/)) {
      if (palabra.length >= 5 && palabrasTitularSet.has(palabra)) copiadas++;
    }
  }
  if (copiadas > 1) return false;

  const palabrasUsadas = {};
  for (const verso of todosLimpio) {
    for (const palabra of verso.split(/\s+/)) {
      if (palabra.length >= 4) {
        palabrasUsadas[palabra] = (palabrasUsadas[palabra] || 0) + 1;
      }
    }
  }
  for (const [, count] of Object.entries(palabrasUsadas)) {
    if (count >= 3) return false;
  }

  for (const verso of todosLimpio) {
    const palabrasLargas = verso.split(/\s+/).filter(p => p.length >= 4);
    if (palabrasLargas.length < 2) return false;
  }

  return true;
}

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

async function generarVerso(titular, apiKey) {
  try {
    const resp = await fetch(GROQ_API_URL, {
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
        temperature: 1.2
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    let texto = data.choices[0].message.content.trim();
    texto = texto.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const textoLimpio = texto.replace(/\*\*/g, "").replace(/\*/g, "");
    const lineas = textoLimpio.split("\n").map(l => l.trim()).filter(l => l.length > 0);
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
    return null;
  } catch (e) {
    return null;
  }
}

export default async (req) => {
  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key no configurada" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const url = new URL(req.url);
  const full = url.searchParams.get("full") === "1";
  const cantidad = full ? 12 : 6;

  console.log(`Regenerando ${cantidad} versos (modo ${full ? "FULL" : "parcial"})...`);

  // Obtener titulares
  const titulares = await obtenerTitulares();
  if (titulares.length === 0) {
    return new Response(JSON.stringify({ error: "Sin titulares" }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }

  console.log(`${titulares.length} titulares obtenidos`);

  // Seleccionar los mejores (pedir más de los necesarios por si fallan validaciones)
  const mejores = seleccionarMejores(titulares, Math.min(cantidad + 10, titulares.length));
  const items = [];
  const sustantivosUsados = new Set();

  for (const titular of mejores) {
    if (items.length >= cantidad) break;
    const versos = await generarVerso(titular, apiKey);
    if (versos) {
      // Filtro inter-poemas
      const sustantivosNuevos = [];
      let repetidos = 0;
      for (const verso of versos) {
        for (const palabra of verso.split(/\s+/)) {
          if (palabra.length >= 5) {
            if (sustantivosUsados.has(palabra)) repetidos++;
            else sustantivosNuevos.push(palabra);
          }
        }
      }
      if (repetidos > 1) {
        console.log(`Inter-filtro: ${repetidos} repetidas — descartado`);
        continue;
      }
      for (const s of sustantivosNuevos) sustantivosUsados.add(s);
      items.push({ titular, versos });
      console.log(`[${items.length}/${cantidad}] OK: "${titular.substring(0, 40)}..."`);
    } else {
      console.log(`SKIP: "${titular.substring(0, 40)}..."`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Generados: ${items.length}/${cantidad}`);

  // Guardar en caché
  const store = getStore("haiku-cache");

  let pool;
  if (full) {
    // Modo full: reemplazar toda la caché
    pool = items;
  } else {
    // Modo parcial: acumular
    let poolAnterior = [];
    try {
      const raw = await store.get("current");
      if (raw) {
        const anterior = JSON.parse(raw);
        poolAnterior = anterior.items || [];
      }
    } catch (e) {}
    pool = [...items, ...poolAnterior].slice(0, MAX_POOL);
  }

  const cacheData = {
    items: pool,
    refreshedAt: Date.now(),
    refreshedAtISO: new Date().toISOString(),
    totalTitulares: titulares.length,
    totalGenerados: items.length,
    totalEnPool: pool.length
  };

  await store.set("current", JSON.stringify(cacheData));

  return new Response(JSON.stringify({
    ok: true,
    modo: full ? "full" : "parcial",
    nuevos: items.length,
    enPool: pool.length,
    refreshedAt: cacheData.refreshedAtISO
  }), {
    headers: { "Content-Type": "application/json" }
  });
};

// Timeout extendido: 120 segundos para poder generar los 24 versos en modo full
export const config = {
  path: "/.netlify/functions/trigger-refresh"
};
