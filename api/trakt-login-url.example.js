// Example serverless endpoint: POST /api/trakt/login-url
//
// Required environment variables:
// TRAKT_CLIENT_ID
// TRAKT_REDIRECT_URI
//
// The frontend opens the returned URL in a popup. Trakt reads the user's
// trakt.tv cookies there and asks them to approve access.

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const clientId = validatedTraktClientId(response);
  if (!clientId) return;

  const redirectUri = String(process.env.TRAKT_REDIRECT_URI || "").trim();
  if (!redirectUri) {
    response.status(500).json({ error: "Missing TRAKT_REDIRECT_URI." });
    return;
  }

  const state = crypto.randomUUID();
  const url = new URL("https://trakt.tv/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  response.status(200).json({ url: url.toString(), state, client_id: clientId });
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
