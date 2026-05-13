import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname.slice(1);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const TRAKT_CLIENT_ID_PATTERN = /^[a-f0-9]{64}$/i;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map();
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/api/trakt/login-url" && request.method === "POST") {
      await handleLoginUrl(response);
      return;
    }
    if (url.pathname === "/api/trakt/callback" && request.method === "GET") {
      await handleCallback(url, response);
      return;
    }
    if (url.pathname === "/api/trakt/refresh" && request.method === "POST") {
      await handleRefresh(request, response);
      return;
    }
    if (url.pathname === "/config.js" && process.env.TRAKT_CLIENT_ID) {
      serveRuntimeConfig(response);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    json(response, error.status || 500, { error: error.publicMessage || error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Nuvio Trakt Bridge running at http://${host}:${port}/`);
});

async function handleLoginUrl(response) {
  const { clientId, redirectUri } = traktConfig();
  const state = crypto.randomUUID();
  rememberOauthState(state);
  const url = new URL("https://trakt.tv/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  json(response, 200, { url: url.toString(), state, client_id: clientId });
}

async function handleCallback(url, response) {
  const { clientId, clientSecret, redirectUri } = traktConfig();
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") || "";
  if (!consumeOauthState(state)) {
    html(response, callbackHtml({
      source: "trakt-oauth",
      status: "error",
      state,
      client_id: clientId,
      error: "invalid_state",
      error_description: "The Trakt authorization state was missing or expired. Please close this popup and connect again.",
    }));
    return;
  }
  if (error || !code) {
    html(response, callbackHtml({
      source: "trakt-oauth",
      status: "error",
      state,
      client_id: clientId,
      error: error || "missing_code",
      error_description: url.searchParams.get("error_description") || "",
    }));
    return;
  }

  const traktResponse = await fetch("https://api.trakt.tv/oauth/token", {
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
  const { payload, text } = await readJsonResponse(traktResponse);
  const tokenError = traktResponse.ok ? null : tokenExchangeError(traktResponse, payload, text);
  if (tokenError) {
    console.warn(`Trakt token exchange failed: ${tokenError.error_description}`);
  }
  html(response, callbackHtml({
    source: "trakt-oauth",
    status: traktResponse.ok ? "success" : "error",
    state,
    client_id: clientId,
    tokens: traktResponse.ok ? payload : undefined,
    error: tokenError?.error,
    error_description: tokenError?.error_description,
  }));
}

async function handleRefresh(request, response) {
  const { clientId, clientSecret, redirectUri } = traktConfig();
  const body = await readJsonBody(request);
  if (!body.refresh_token) {
    json(response, 400, { error: "Missing refresh token" });
    return;
  }
  const traktResponse = await fetch("https://api.trakt.tv/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Nuvio-Trakt-Bridge/1.0",
    },
    body: JSON.stringify({
      refresh_token: body.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "refresh_token",
    }),
  });
  const text = await traktResponse.text();
  response.writeHead(traktResponse.status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(text || "{}");
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);
  const content = await readFile(filePath);
  response.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream" });
  response.end(content);
}

function callbackHtml(payload) {
  const targetOrigin = process.env.TRAKT_CALLBACK_ORIGIN || `http://${host}:${port}`;
  const jsonPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Trakt connected</title></head>
<body>
<script>
const payload = ${jsonPayload};
try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(targetOrigin)}); } catch (error) {}
try { new BroadcastChannel("nuvio-trakt-bridge.trakt-oauth").postMessage(payload); } catch (error) {}
window.close();
</script>
You can close this window.
</body></html>`;
}

function serveRuntimeConfig(response) {
  const origin = process.env.TRAKT_CALLBACK_ORIGIN || `http://${host}:${port}`;
  const script = `window.NUVIO_TRAKT_BRIDGE_CONFIG = ${JSON.stringify({
    traktLoginUrlEndpoint: "/api/trakt/login-url",
    traktRefreshEndpoint: "/api/trakt/refresh",
    traktCallbackOrigin: origin,
  }, null, 2)};`;
  response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
  response.end(script);
}

function requireEnv(names) {
  const missing = names.filter((name) => !String(process.env[name] || "").trim());
  if (missing.length) {
    throw serverSetupError();
  }
}

function traktConfig() {
  requireEnv(["TRAKT_CLIENT_ID", "TRAKT_CLIENT_SECRET", "TRAKT_REDIRECT_URI"]);
  const redirectUri = String(process.env.TRAKT_REDIRECT_URI || "").trim();
  validateRedirectUri(redirectUri);
  return {
    clientId: validatedTraktClientId(),
    clientSecret: String(process.env.TRAKT_CLIENT_SECRET || "").trim(),
    redirectUri,
  };
}

function validatedTraktClientId() {
  const clientId = String(process.env.TRAKT_CLIENT_ID || "").trim();
  if (!TRAKT_CLIENT_ID_PATTERN.test(clientId)) {
    throw serverSetupError();
  }
  return clientId;
}

function validateRedirectUri(redirectUri) {
  try {
    const url = new URL(redirectUri);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error();
    }
  } catch {
    throw serverSetupError();
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return { payload: {}, text: "" };
  }
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
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function serverSetupError() {
  const error = new Error("Trakt sign-in is not configured on this server.");
  error.status = 503;
  error.publicMessage = "Trakt sign-in is not configured on this server yet. The site owner needs to configure the bridge OAuth app server-side; users should only have to press Connect Trakt.";
  return error;
}

function rememberOauthState(state) {
  cleanupOauthStates();
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
}

function consumeOauthState(state) {
  cleanupOauthStates();
  if (!state || !oauthStates.has(state)) {
    return false;
  }
  oauthStates.delete(state);
  return true;
}

function cleanupOauthStates() {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStates.entries()) {
    if (expiresAt <= now) {
      oauthStates.delete(state);
    }
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function html(response, content) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(content);
}
