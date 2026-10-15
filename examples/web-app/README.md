# Example web app

A chat app for [mcp-server-db2i](../../README.md) that runs in the browser. Users sign in with their own IBM i user profile and bring their own model API key, so they can ask questions about IBM i data without a Claude or ChatGPT subscription.

It is an example: a starting point to read, run and change. It is not published to npm and has no release of its own.

- **Chat** with Anthropic, OpenAI, Google Gemini or any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM). Answers are rendered as markdown.
- **Result tables** for every query: sort by a column, filter rows, resize columns, scroll through thousands of rows, copy for Excel and download as CSV. Long decimals keep every digit.
- **Exports**: `export_query` results show a download button with the row count, size and expiry.
- **History** of the queries the model ran, kept in the browser. Search it, copy the SQL, run a query again, or ask a follow-up about it.

Built with Next.js (App Router), [AI SDK](https://ai-sdk.dev) 7 and AI SDK UI, `@ai-sdk/mcp`, TanStack Table and Streamdown.

## How it works

```text
Browser ──── /api/chat ────▶ Next.js app ──── MCP over HTTP ────▶ mcp-server-db2i ──▶ IBM i
   │                            │  (Bearer token from the session)
   │  model key in a header     └──── model API (Anthropic, OpenAI, ...)
   └── sign-in ──▶ server's OAuth sign-in page
```

- **Sign-in** uses the server's built-in OAuth authorization server. The app registers itself as an OAuth client, sends the user to the server's sign-in page, and keeps the tokens in an encrypted, httpOnly session cookie. The browser never sees the IBM i password or the tokens. Every query runs with the signed-in user's own authority, and the server's checks (read-only validator, schema allowlist, row limits, audit log) apply as usual.
- **Model keys** stay in the browser's `localStorage`. Each chat request sends the key in a header to this app, which passes it to the model provider. The app does not store or log it, and removes it from error messages.
- **History** is kept in IndexedDB in the browser. It holds the SQL, the row count and the timing, not the result rows.

## Run it

You need Node 22 or newer and a running mcp-server-db2i in HTTP mode with OAuth turned on.

1. Start the server with OAuth. From the repository root, add these to your `.env` next to your IBM i connection settings:

   ```bash
   MCP_TRANSPORT=http
   MCP_AUTH_MODE=required
   MCP_OAUTH_ENABLED=true
   MCP_PUBLIC_URL=http://localhost:3000
   MCP_OAUTH_SECRET=<openssl rand -hex 32>
   # Optional: downloadable Excel and CSV files
   EXPORT_ENABLED=true
   EXPORT_DIR=/tmp/db2i-exports
   ```

   Then `npm run build && npm start`. See [HTTP transport](../../docs/http-transport.md#remote-clients-oauth) for the OAuth options.

2. Configure the app:

   ```bash
   cd examples/web-app
   cp .env.example .env.local
   ```

   Set `SESSION_SECRET` to a random string of at least 32 characters, for example `openssl rand -base64 32`.

3. Start the app:

   ```bash
   npm install
   npm run dev
   ```

4. Open http://localhost:3001, choose **Sign in to IBM i**, then **Choose a model** to pick a provider, paste a key and choose a model.

### Settings

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_SERVER_URL` | Yes | Origin of mcp-server-db2i, such as `http://localhost:3000`. Use the same origin as the server's `MCP_PUBLIC_URL` |
| `APP_URL` | Yes | Origin of this app as users open it, such as `http://localhost:3001`. The OAuth callback is `<APP_URL>/oauth/callback`, and requests from any other origin are refused |
| `SESSION_SECRET` | Yes | Key that encrypts the session cookie, at least 32 characters. Changing it signs everyone out |
| `CUSTOM_MODEL_BASE_URLS` | No | Comma-separated base URLs users may pick for an OpenAI-compatible provider. Default `http://localhost:11434/v1` (Ollama). The app only calls URLs on this list |

### Local models

With [Ollama](https://ollama.com) running on the same machine, choose **OpenAI-compatible**, leave the key empty and choose **Load models**. Pick a model that supports tool calling. Small models often call tools badly; results improve a lot with larger ones.

## Deploying it

Run the app on its own HTTPS origin, such as `https://app.example.com`, and the server on another, such as `https://mcp.example.com`.

- Set `APP_URL=https://app.example.com` and `MCP_SERVER_URL=https://mcp.example.com`.
- The server only accepts redirect URIs it knows. Loopback addresses (`http://localhost:<port>`) are always accepted, so local development needs nothing extra. For a deployed app, add its callback to the server's list. Setting `MCP_OAUTH_REDIRECT_URIS` replaces the defaults, so keep the clients you still use:

  ```bash
  MCP_OAUTH_REDIRECT_URIS=https://app.example.com/oauth/callback,https://claude.ai/api/mcp/auth_callback
  ```

- The session cookie is marked `Secure` when `APP_URL` is HTTPS.
- Chat requests stream for up to five minutes (`maxDuration` in `app/api/chat/route.ts`). Make sure the host and any proxy allow that.

## Development

```bash
npm run dev        # http://localhost:3001
npm run typecheck
npm run lint
npm test
npm run build
```

The layout:

- `app/api/chat/route.ts` streams the chat with `streamText` and the server's MCP tools.
- `lib/server/oauth.ts` is the OAuth client: registration, sign-in, token refresh and revoke.
- `lib/server/mcp.ts` opens an MCP client with the session's access token.
- `components/result-table.tsx` is the result table.
- `lib/client/store.ts` keeps the history in IndexedDB.

Tests mock the MCP server and the model, so they need neither an IBM i nor an API key.
