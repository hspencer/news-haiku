# News Haiku

Obtiene titulares apocalípticos de noticias en español y los transforma en un haiku, animado con física tipográfica.

Las letras del titular que no pertenecen al haiku pivotan y caen (Matter.js). Las que sí, se tiñen de rojo y viajan a su posición en el poema.

El haiku es generado por Grok (xAI) con fallback algorítmico basado en conteo silábico español.

## Correr en local

Se necesitan dos cosas corriendo en paralelo: un servidor estático para el sketch y el proxy para la API de xAI.

### 1. Proxy de API

El browser no puede llamar directamente a la API de xAI por restricciones CORS. El archivo `proxy-server.js` (excluido del repo) resuelve esto.

Crear el archivo `proxy-server.js` en la raíz del proyecto:

```javascript
const http = require("http");
const https = require("https");

const PORT = 3001;
const XAI_API_URL = "https://api.x.ai/v1/chat/completions";
const XAI_API_KEY = "tu-api-key-aqui";

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST" || req.url !== "/haiku") {
    res.writeHead(404); res.end("Not found"); return;
  }

  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const postData = Buffer.from(body, "utf-8");
    const proxyReq = https.request(XAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + XAI_API_KEY,
        "Content-Length": postData.length
      }
    }, (proxyRes) => {
      let respBody = "";
      proxyRes.on("data", chunk => { respBody += chunk; });
      proxyRes.on("end", () => {
        res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
        res.end(respBody);
      });
    });
    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    proxyReq.write(postData);
    proxyReq.end();
  });
});

server.listen(PORT, () => console.log("Proxy en http://localhost:" + PORT + "/haiku"));
```

Ejecutar:

```
node proxy-server.js
```

### 2. Servidor estático

Con Live Server (VS Code) o cualquier servidor estático:

```
npx serve .
```

Abrir `http://localhost:3000` (o el puerto que asigne Live Server).

Sin el proxy corriendo, el sketch funciona igual pero usa el motor algorítmico en vez de Grok.

## Deploy en Netlify

El repo incluye una Netlify Function en `netlify/functions/haiku.js` que actúa como proxy en producción.

1. Conectar el repo en Netlify
2. En Site settings, Environment variables, agregar `XAI_API_KEY` con la key de xAI
3. Push a main triggerea el deploy

## Estructura

```
index.html          Entrada, carga fuentes y scripts
sketch.js           Animacion p5.js + Matter.js (estado, dibujo, fisica)
haiku.js            Generador de haiku (Grok + fallback algoritmico)
silabas.js          Conteo silabico español (diptongos, hiatos)
noticias.js         Fetch de titulares via RSS
js/p5.min.js        p5.js
js/matter.js        Matter.js 0.12.0
netlify/functions/  Serverless proxy para xAI
netlify.toml        Configuracion de Netlify
```
