# amber-mcp

Remote MCP server for the [Amber Electric API](https://api.amber.com.au/v1), TypeScript on Netlify Functions (stateless streamable HTTP at `/mcp`).

## Tools
`get_auth_status`, `list_sites`, `get_current_prices`, `get_price_history`, `get_usage`, `get_renewables`, `find_cheapest_window`.

- Times are returned in local time with the real DST offset (`timezone` param; default `Australia/Melbourne`, override with the `DEFAULT_TIMEZONE` env var). Amber's `:00:01` interval starts are trimmed.
- Prices: compact by default (adds `spikeStatus` when not `none`, plus forecast `low`/`high`); `detail=full` adds spot price, descriptor, predicted and tariff period.
- Prices/usage: `channel` filter, `aggregate` (hourly/daily), `fields` selection, rounded numbers. `get_usage` drops zero-kWh rows (`include_zero` to keep), returns per-channel kWh/cost totals (`totals_only` for just those) and a `dataQuality` block flagging all-zero channels and suspected meter gaps (`gap_threshold_intervals`, default 3 = 1.5h; marks gaps in the 16:00-21:00 peak and at the end of the data).
- `find_cheapest_window`: `load_kw` cost estimate, `finish_by` deadline, next-best non-overlapping `alternatives`, optional per-interval prices.

## Auth
Single-purpose OAuth (dynamic client registration + PKCE). On the approval page you enter your **Amber API key**; the server checks it against Amber and seals it (AES-256-GCM) inside a stateless access token that expires after **30 days**. No key or session is stored server-side, and each token only carries its owner's key. There are no refresh tokens: reconnect after 30 days.

Clients that cannot do OAuth can send the raw Amber key as `Authorization: Bearer <key>`.

## Deploy
1. Netlify site with no build command, publish dir `public`.
2. One environment variable: `KEY_ENCRYPTION_SECRET` (long random string, e.g. `openssl rand -hex 32`). Changing it invalidates all tokens.
3. `npx netlify-cli deploy --prod --build`

## Connect
claude.ai: Settings > Connectors > Add custom connector > `https://YOUR-SITE.netlify.app/mcp`, then paste your Amber API key on the approval page.
