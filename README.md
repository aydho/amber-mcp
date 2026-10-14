# amber-mcp

Remote MCP server for the [Amber Electric API](https://api.amber.com.au/v1), TypeScript on Netlify Functions (stateless streamable HTTP at `/mcp`).

## Tools
`set_api_key`, `clear_api_key`, `get_auth_status`, `list_sites`, `get_current_prices`, `get_price_history`, `get_usage`, `get_renewables`, `find_cheapest_window`.

The Amber key is AES-GCM encrypted and kept in Netlify Blobs with a hard 60-minute expiry (checked on every read, deleted when expired).

## Deploy
1. Push to GitHub, then in Netlify: Add new site > Import from Git (no build command, publish dir `public`).
2. Site settings > Environment variables:
   - `MCP_SHARED_SECRET`: long random string (`openssl rand -hex 32`); clients send it as a Bearer token.
   - `KEY_ENCRYPTION_SECRET`: a different long random string.
3. Deploy.

## claude.ai (custom connector)
Settings > Connectors > Add custom connector, URL `https://YOUR-SITE.netlify.app/mcp`. The server implements OAuth (dynamic client registration + PKCE); when the approval page opens, enter `MCP_SHARED_SECRET`. Access tokens last 1h, refresh tokens 30 days, all HMAC-signed and stateless.

## Claude Desktop (via mcp-remote)
Add to `claude_desktop_config.json` (needs Node):

```json
{
  "mcpServers": {
    "amber": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-SITE.netlify.app/mcp",
               "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer YOUR_MCP_SHARED_SECRET" }
    }
  }
}
```

Then ask Claude: "Set my Amber API key to ..." and use the other tools for the next hour.

## Local dev
Create `.env` with the two secrets, run `npx netlify-cli dev`, and POST JSON-RPC to `http://localhost:8888/mcp`.
