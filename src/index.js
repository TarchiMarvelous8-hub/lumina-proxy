// Cloudflare Worker — Lumina AI's Gemini proxy
//
// Same job as netlify/functions/chat.mjs: keeps the real Gemini API key on
// the server, never shipped to the browser. Moved here specifically because
// Cloudflare Workers only bill/limit *CPU time* (actual code execution) —
// not the time spent waiting on an external API. A slow, search-grounded
// Gemini request that mostly just sits there waiting doesn't get killed by
// a hard wall-clock timeout the way it could on Netlify's free tier.
//
// This runs on a different domain than lumina1ai.netlify.app, so unlike the
// old Netlify function, it needs to explicitly allow cross-origin requests
// from the site (see ALLOWED_ORIGIN below) — the browser would otherwise
// silently block the response.
//
// --- Setup, one time ---
//   1. Push this whole folder (src/index.js + wrangler.toml) as its own new
//      GitHub repo — keep it separate from the Lumina site's repo so the
//      two deploy pipelines (Cloudflare here, Netlify there) never confuse
//      each other.
//   2. In the Cloudflare dashboard: Workers & Pages -> Create application ->
//      Import an existing Git repository -> pick this repo -> Deploy.
//   3. After it deploys: open the Worker -> Settings -> Variables and
//      Secrets -> Add -> name it GEMINI_API_KEY, paste your key, set the
//      type to Secret (not plaintext) -> Save and deploy.
//   4. Copy the Worker's URL shown at the top of its dashboard page — looks
//      like https://lumina-proxy.<your-subdomain>.workers.dev
//   5. Come back and I'll wire that URL into index.html's API_URL constant,
//      replacing the old '/api/chat' Netlify path. index.html itself stays
//      on Netlify, completely unchanged otherwise.

const ALLOWED_ORIGIN = 'https://lumina1ai.netlify.app';

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    // Browsers send a preflight OPTIONS request before a cross-origin POST
    // with a JSON body — this has to be answered before Gemini even enters
    // the picture, or the real request never gets sent.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Vary': 'Origin'
        }
      });
    }

    if (request.method !== 'POST') {
      return withCors(new Response('Method Not Allowed', { status: 405 }));
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return withCors(Response.json(
        { error: { message: 'Worker is missing GEMINI_API_KEY. Set it in Cloudflare -> Workers & Pages -> this Worker -> Settings -> Variables and Secrets, then redeploy.' } },
        { status: 500 }
      ));
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return withCors(Response.json({ error: { message: 'Invalid request body.' } }, { status: 400 }));
    }

    const model = body.model || 'gemini-3.7-flash';

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            system_instruction: body.system_instruction,
            contents: body.contents,
            tools: body.tools
          })
        }
      );
    } catch (err) {
      return withCors(Response.json({ error: { message: 'Could not reach Gemini from the server.' } }, { status: 502 }));
    }

    const data = await upstream.text();
    return withCors(new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' }
    }));
  }
};
