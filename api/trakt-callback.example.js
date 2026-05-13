// Example serverless endpoint: GET /api/trakt/callback
//
// Required environment variables:
// TRAKT_CLIENT_ID
// TRAKT_CLIENT_SECRET
// TRAKT_REDIRECT_URI
// TRAKT_CALLBACK_ORIGIN, for example https://your-site.example
//
// Trakt redirects the popup here. This endpoint exchanges the code server-side
// and returns a tiny HTML page that sends the tokens back to the opener.

export default async function handler(request, response) {
  const clientId = validatedTraktClientId();
  const clientSecret = String(process.env.TRAKT_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.TRAKT_REDIRECT_URI || "").trim();
  const url = new URL(request.url, `https://${request.headers.host}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") || "";

  if (error || !code) {
    response.status(200).send(callbackHtml({
      source: "trakt-oauth",
      status: "error",
      state,
      client_id: clientId,
      error: error || "missing_code",
      error_description: url.searchParams.get("error_description") || "",
    }));
    return;
  }

  const tokenResponse = await fetch("https://api.trakt.tv/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Nuvio-Trakt-Bridge/1.0",
    },
    body: JSON.stringify({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const { payload: tokens, text } = await readJsonResponse(tokenResponse);
  const tokenError = tokenResponse.ok ? null : tokenExchangeError(tokenResponse, tokens, text);

  response.status(200).send(callbackHtml({
    source: "trakt-oauth",
    status: tokenResponse.ok ? "success" : "error",
    state,
    client_id: clientId,
    tokens: tokenResponse.ok ? tokens : undefined,
    error: tokenError?.error,
    error_description: tokenError?.error_description,
  }));
}

function validatedTraktClientId() {
  const clientId = String(process.env.TRAKT_CLIENT_ID || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(clientId)) {
    throw new Error("Trakt sign-in is not configured on this server yet. The site owner needs to configure the bridge OAuth app server-side; users should only have to press Connect Trakt.");
  }
  return clientId;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return { payload: {}, text: "" };
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { payload: {}, text };
  }
}

function tokenExchangeError(response, payload, text) {
  const requestId = response.headers.get("x-request-id");
  const detail = payload.error_description
    || payload.message
    || payload.error
    || cleanResponseText(text)
    || response.statusText
    || "Trakt did not return a readable error body.";
  const suffix = requestId ? ` Trakt request id: ${requestId}.` : "";
  return {
    error: payload.error || "trakt_token_exchange_failed",
    error_description: `Trakt token exchange failed with HTTP ${response.status}: ${detail}.${suffix}`,
  };
}

function cleanResponseText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function callbackHtml(payload) {
  const targetOrigin = process.env.TRAKT_CALLBACK_ORIGIN || "*";
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Trakt connected</title></head>
<body>
<script>
const payload = ${json};
try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(targetOrigin)}); } catch (e) {}
try { new BroadcastChannel("nuvio-trakt-bridge.trakt-oauth").postMessage(payload); } catch (e) {}
window.close();
</script>
You can close this window.
</body></html>`;
}
