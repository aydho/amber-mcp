# amber-mcp

Remote MCP server for the [Amber Electric API](https://api.amber.com.au/v1), TypeScript on Netlify Functions (stateless streamable HTTP at `/mcp`).

## Tools
`list_sites`, `get_current_prices`, `get_price_history`, `get_usage`, `get_renewables`, `find_cheapest_window`.

## Auth
Single-purpose OAuth (dynamic client registration + PKCE). On the approval page you enter your **Amber API key**; the server checks it against Amber and seals it (AES-256-GCM) inside a stateless access token that expires after **30 days**. No key or session is stored server-side, and each token only carries its owner's key. There are no refresh tokens: reconnect after 30 days.

Clients that cannot do OAuth can send the raw Amber key as `Authorization: Bearer <key>`.

## Deploy
1. Netlify site with no build command, publish dir `public`.
2. One environment variable: `KEY_ENCRYPTION_SECRET` (long random string, e.g. `openssl rand -hex 32`). Changing it invalidates all tokens.
3. `npx netlify-cli deploy --prod --build`

## Connect
claude.ai: Settings > Connectors > Add custom connector > `https://YOUR-SITE.netlify.app/mcp`, then paste your Amber API key on the approval page.
