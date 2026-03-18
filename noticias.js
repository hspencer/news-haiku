/**
 * noticias.js — Obtención de titulares desde feeds RSS
 *
 * Usa rss2json.com como proxy CORS para parsear feeds RSS
 * de fuentes de noticias en español (BBC Mundo, El País, DW + ciencia y cultura).
 * Selecciona titulares con mayor interés poético usando un puntaje
 * basado en palabras con sustancia (conflicto, naturaleza, descubrimiento, lo humano).
 *
 * Se usa desde:
 *  - sketch.js: iniciarCiclo() llamará a obtenerPeorTitular()
 *  - refresh.mjs (servidor): contiene la misma lógica para regenerar titulares
 */

const Noticias = (function () {

  // Proxy CORS necesario para evitar la política same-origin del navegador.
  // Los feeds RSS están en dominios diferentes, por lo que fetch() directo
  // fallaría. rss2json.com actúa como intermediario confiable.
  const CORS_PROXY = "https://api.allorigins.win/raw?url=";
  const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

  // Fuentes de noticias en español: internacionales, ciencia y cultura.
  // Se consultan todas en paralelo para maximizar variedad temática.
  const FEEDS = [
    "https://feeds.bbci.co.uk/mundo/rss.xml",
    "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada",
    "https://rss.dw.com/xml/rss-sp-all",
    "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/ciencia/portada",
    "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/cultura/portada",
    "https://feeds.bbci.co.uk/mundo/temas/ciencia/rss.xml"
  ];

  // Heurística de puntuación: palabras que indican sustancia poética.
  // Incluye conflicto, naturaleza, descubrimiento, lo humano concreto.
  // Cada coincidencia suma 1 punto. Se usa en puntuarTitular() para
  // identificar titulares con materia prima para un haiku.
  const PALABRAS_POETICAS = [
    // conflicto y drama humano
    "guerra", "muerte", "muertos", "crisis", "refugiados", "éxodo",
    "hambre", "sequía", "naufragio", "frontera", "exilio", "migración",
    // naturaleza y territorio
    "terremoto", "inundación", "incendio", "volcán", "erupción", "glaciar",
    "huracán", "tornado", "tsunami", "océano", "selva", "desierto",
    "río", "montaña", "isla", "bosque", "costa", "pampa",
    // ciencia y descubrimiento
    "descubren", "hallazgo", "fósil", "especie", "extinción", "genoma",
    "asteroide", "satélite", "telescopio", "órbita", "partícula", "átomo",
    "expedición", "excavación", "antigua", "milenario", "ancestral",
    // lo humano y cultural
    "lengua", "idioma", "pueblo", "comunidad", "ritual", "ceremonia",
    "ruinas", "templo", "tumba", "manuscrito", "pintura", "museo",
    // elementos concretos
    "agua", "fuego", "tierra", "piedra", "hierro", "sal", "hueso",
    "sangre", "semilla", "raíz", "fruto", "piel", "cuerpo"
  ];

  // Titulares de respaldo cuando todos los feeds RSS fallan o están fuera de servicio.
  // Mezcla de temas: conflicto, ciencia, naturaleza, cultura, territorio americano.
  const FALLBACK = [
    "Terremoto de magnitud 7.2 sacude las costas del Pacífico y deja cientos de muertos",
    "Descubren una especie de árbol milenario que se creía extinta en la selva amazónica",
    "Crisis climática: los glaciares patagónicos se derriten al doble de velocidad prevista",
    "Excavación revela un templo sumergido de tres mil años bajo las aguas del lago Titicaca",
    "Miles de refugiados cruzan la frontera a pie cargando solo lo que pueden llevar",
    "Un río subterráneo desconocido aparece bajo el desierto de Atacama",
    "La erupción del volcán obliga a evacuar pueblos enteros entre la ceniza y el fuego",
    "Hallan un manuscrito medieval con el primer mapa de las costas americanas",
    "Las ballenas jorobadas cambian sus rutas migratorias por el calentamiento del océano",
    "Comunidades indígenas recuperan una lengua que se creía perdida hace un siglo",
    "Expedición científica desciende al fondo de la fosa marina más profunda del Atlántico",
    "El último glaciar tropical de los Andes podría desaparecer antes de fin de década"
  ];

  /**
   * puntuarTitular — asigna un puntaje de "interés poético" a un titular.
   * Más alto = más materia prima para un haiku.
   */
  function puntuarTitular(titular) {
    let t = titular.toLowerCase();
    let puntaje = 0;
    for (let palabra of PALABRAS_POETICAS) {
      if (t.includes(palabra)) puntaje++;
    }
    // Bonus por largo (titulares más largos suelen tener más contenido concreto)
    puntaje += Math.min(t.split(" ").length / 10, 1);
    return puntaje;
  }

  /**
   * obtenerTitulares — busca titulares de todos los feeds en paralelo
   * Estrategia: Promise.all() con AbortController permite que todos los
   * feeds se ejecuten simultáneamente, pero un feed lento no bloquea a los otros.
   * Timeout de 8s por feed. Si uno falla, continúa con los demás.
   * Devuelve array de strings (títulos) o FALLBACK si todos fallan.
   */
  async function obtenerTitulares() {
    let todosLosTitulares = [];

    // Cada feed se consulta en paralelo. AbortController() detiene la solicitud
    // si pasa el timeout (8 segundos). Fallas parciales no bloquean las otras.
    let promesas = FEEDS.map(async (feed) => {
      try {
        let controller = new AbortController();
        let timeout = setTimeout(() => controller.abort(), 8000);
        let url = RSS2JSON + encodeURIComponent(feed);
        let resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        let data = await resp.json();
        if (data.status === "ok" && data.items) {
          return data.items.map(item => item.title);
        }
      } catch (e) {
        console.log("Feed falló:", feed, e.message);
      }
      return [];
    });

    let resultados = await Promise.all(promesas);
    for (let titulares of resultados) {
      todosLosTitulares = todosLosTitulares.concat(titulares);
    }

    // Si no obtuvimos nada de los feeds en vivo, usar titulares de respaldo
    if (todosLosTitulares.length === 0) {
      console.log("Usando titulares de respaldo");
      return FALLBACK;
    }

    return todosLosTitulares;
  }

  /**
   * obtenerPeorTitular — obtiene el titular con mayor interés poético
   * Se usa desde sketch.js en iniciarCiclo() para obtener el titular inicial.
   *
   * Estrategia "top 5 random pick": después de puntuar todos los titulares,
   * se selecciona ALEATORIAMENTE entre los 5 mejores (no siempre el #1).
   * Esto evita repetir el mismo titular todos los días y proporciona variedad.
   *
   * @returns {Promise<string>} un titular del top 5 con más sustancia poética
   */
  async function obtenerPeorTitular() {
    let titulares = await obtenerTitulares();

    // Puntuar y ordenar por dramático descendente
    let puntuados = titulares.map(t => ({
      texto: t,
      puntaje: puntuarTitular(t)
    }));
    puntuados.sort((a, b) => b.puntaje - a.puntaje);

    // En lugar de siempre elegir el primero (más repetitivo),
    // elegir aleatoriamente entre los 5 mejores para variedad
    let top = puntuados.slice(0, Math.min(5, puntuados.length));
    let elegido = top[Math.floor(Math.random() * top.length)];

    return elegido.texto;
  }

  /**
   * obtenerTitularAleatorio — obtiene un titular de fallback al azar
   * Para uso inmediato mientras se cargan los feeds reales.
   */
  function obtenerTitularAleatorio() {
    return FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  }

  return {
    obtenerPeorTitular,
    obtenerTitularAleatorio,
    obtenerTitulares,
    puntuarTitular
  };

})();
