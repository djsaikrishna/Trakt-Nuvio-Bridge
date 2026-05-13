// Example serverless endpoint: POST /api/trakt/refresh
//
// Required environment variables:
// TRAKT_CLIENT_ID
// TRAKT_CLIENT_SECRET
// TRAKT_REDIRECT_URI

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const clientId = validatedTraktClientId(response);
  if (!clientId) return;

  const refreshToken = request.body && request.body.refresh_token;
  if (!refreshToken) {
    response.status(400).json({ error: "Missing refresh token" });
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
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: String(process.env.TRAKT_CLIENT_SECRET || "").trim(),
      redirect_uri: String(process.env.TRAKT_REDIRECT_URI || "").trim(),
      grant_type: "refresh_token",
    }),
  });

  const text = await traktResponse.text();
  response.status(traktResponse.status);
  response.setHeader("Content-Type", "application/json");
  response.send(text || "{}");
}

function validatedTraktClientId(response) {
  const clientId = String(process.env.TRAKT_CLIENT_ID || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(clientId)) {
    response.status(500).json({
      error: "Trakt sign-in is not configured on this server yet. The site owner needs to configure the bridge OAuth app server-side; users should only have to press Connect Trakt.",
    });
    return "";
  }
  return clientId;
}
