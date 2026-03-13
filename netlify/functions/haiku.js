/**
 * netlify/functions/haiku.js — Serverless proxy para la API de Groq
 *
 * Netlify Function que recibe el POST del browser, agrega la API key
 * (guardada como variable de entorno en Netlify), y reenvía a Groq.
 *
 * La API key se configura en Netlify:
 *   Site settings → Environment variables → Add → GROQ_API_KEY
 *
 * Key gratuita en: https://console.groq.com/keys
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

export default async (request) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Solo POST" }), { status: 405, headers });
  }

  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GROQ_API_KEY no configurada" }),
      { status: 500, headers }
    );
  }

  try {
    const body = await request.text();

    const resp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: body
    });

    const respBody = await resp.text();
    return new Response(respBody, { status: resp.status, headers });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 502, headers }
    );
  }
};
