# Oura MCP Server

A Model Context Protocol (MCP) server for accessing Oura Ring data.

It runs in two modes from the same codebase:

| Mode | Entrypoint | Transport | Use it for |
| --- | --- | --- | --- |
| Local | `npm run start:stdio` | stdio | Claude Code and Claude Desktop on your own machine |
| Hosted | `npm start` | Streamable HTTP + OAuth | claude.ai in the browser and the Claude mobile apps |

## Prerequisites

- Node.js 20+
- An Oura account

## Installation

```bash
npm install
npm run build
```

## Oura credentials

1. Log in to the [Oura Cloud Console](https://cloud.ouraring.com/)
2. Create a [Personal Access Token](https://cloud.ouraring.com/personal-access-tokens)

Set it as `OURA_PERSONAL_ACCESS_TOKEN`. See `.env.example` for the full list of
variables.

> The OAuth2 client credentials in `.env.example` are read but not usable yet:
> `OuraAuth` stores them without ever running the authorization-code flow, so
> requests fail with `Not authenticated`. Use a personal access token.

---

## Local mode (stdio)

### Claude Code

```bash
claude mcp add oura -s user \
  -e OURA_PERSONAL_ACCESS_TOKEN=your_token \
  -- "$(command -v node)" /absolute/path/to/oura-mcp/build/index.js
```

### Claude Desktop

Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "oura": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/oura-mcp/build/index.js"],
      "env": { "OURA_PERSONAL_ACCESS_TOKEN": "your_token" }
    }
  }
}
```

Pass the token in `env` rather than relying on a `.env` file. `dotenv` resolves
`.env` against the *current working directory*, which for a client-launched
server is wherever the client happened to start — not this repo.

### Testing

```bash
node test.js get_daily_sleep 2026-08-01
```

---

## Hosted mode (HTTP + OAuth)

claude.ai and the mobile apps only talk to remote MCP servers over HTTPS, so
reaching your data from a phone means deploying this somewhere.

### What the auth actually does

The server is its own OAuth 2.1 authorization server. Your Oura token stays in
server-side env and is never handed to the client; the OAuth flow exists only to
prove that whoever is calling `/mcp` knows `MCP_AUTH_PASSWORD`.

Client ids, authorization codes, and tokens are all HMAC-signed payloads rather
than database rows, so a redeploy doesn't sign you out and no storage needs
provisioning. Clients are registered as public clients and authenticate with
PKCE. Authorization codes are single-use.

### Deploying to Railway

1. Create a new Railway project from this repo. `railway.json` pins the build
   and start commands and points the healthcheck at `/healthz`.
2. Generate a signing secret:
   ```bash
   openssl rand -hex 32
   ```
3. Set these variables in the Railway service:

   | Variable | Value |
   | --- | --- |
   | `OURA_PERSONAL_ACCESS_TOKEN` | your Oura token |
   | `OAUTH_SIGNING_SECRET` | the hex string from step 2 |
   | `MCP_AUTH_PASSWORD` | the password you'll type when connecting |
   | `PUBLIC_URL` | the service's public origin, no trailing slash |

   `PUBLIC_URL` is a chicken-and-egg step: generate the domain first, then set
   the variable to that origin and redeploy. It has to match the real origin
   exactly, because it's what the server advertises in its OAuth metadata.
4. Confirm the deploy: `curl https://your-app.up.railway.app/healthz`

`PORT` is injected by Railway; don't set it yourself.

### Connecting Claude

In claude.ai → Settings → Connectors → **Add custom connector**, use:

```
https://your-app.up.railway.app/mcp
```

Leave the OAuth client fields blank — the server supports dynamic client
registration, so Claude registers itself. You'll be redirected to a sign-in page
asking for `MCP_AUTH_PASSWORD`, and after that the connector is available in the
browser and on the mobile apps under the same account.

### Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | The MCP endpoint. Requires a bearer token and the `oura:read` scope. |
| `/authorize`, `/token`, `/register`, `/revoke` | OAuth, mounted by the MCP SDK |
| `POST /login` | Password form posted from the authorize page |
| `/.well-known/oauth-authorization-server` | AS metadata |
| `/.well-known/oauth-protected-resource/mcp` | Protected-resource metadata |
| `GET /healthz` | Healthcheck |

`GET` and `DELETE` on `/mcp` return 405: the server runs the transport in
stateless mode, so there's no long-lived SSE stream or session to tear down.
Every request gets a fresh server instance, which is what lets a redeploy or a
second replica pick up mid-conversation.

---

## Available resources

`personal_info`, `daily_activity`, `daily_readiness`, `daily_sleep`, `sleep`,
`sleep_time`, `workout`, `session`, `daily_spo2`, `rest_mode_period`,
`ring_configuration`, `daily_stress`, `daily_resilience`,
`daily_cardiovascular_age`, `vO2_max`

Date-based resources default to the last 7 days.

## Available tools

Every date-based resource above has a matching `get_<name>` tool taking
`startDate` and `endDate` in `YYYY-MM-DD` form — 13 in total.
