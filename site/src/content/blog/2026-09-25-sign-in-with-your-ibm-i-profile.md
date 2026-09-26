---
title: Sign in with your IBM i profile
description: A built-in OAuth 2.1 server lets claude.ai, Cursor and Claude Code connect with one URL. Everyone signs in as themselves and queries run with their own authority.
date: 2026-09-25T09:00:00Z
audience: ibmi
icon: key-round
tags: [release, oauth, http]
---

HTTP mode used to need a shared token, or a `POST /auth` call with credentials. A developer's script can do that. A claude.ai custom connector can't, so hosted clients were left out.

Version 2.9 fixes that. With `MCP_OAUTH_ENABLED=true`, the server runs its own OAuth 2.1 authorization server.

## What the user sees

1. They add `https://mcp.example.com/mcp` as a connector in claude.ai, or in Cursor or Claude Code. The client config holds no token and no password.
2. When they connect, a sign-in page opens. They log in with their own IBM i user profile, and pick the system if `DB2I_PROFILES` lists more than one.
3. That's it. The assistant can now use the tools.

## What happens underneath

The server checks the credentials with a test connection to the IBM i, then gives the client a token bound to that user profile and system. Queries run with that user's own authority. Object authority and exit programs apply as usual, on top of the library allowlist.

Nothing is written to disk. Client registrations are signed with `MCP_OAUTH_SECRET`, and tokens live in memory. Each token refresh repeats the test connection, so a disabled profile or a changed password ends the session at the next refresh. Restarting the server signs everyone out.

## Why this matters

It's another step toward "just use it". Someone on the IBM i team runs the server once. Everyone else adds a URL and signs in, with nothing to install on their own machine.

It also matters for anything with several users. A chatbot used by a team no longer has to query through one shared service profile. Each person queries as themselves, and sees what they could already see.

## What you need

```bash
MCP_TRANSPORT=http
MCP_OAUTH_ENABLED=true
MCP_PUBLIC_URL=https://mcp.example.com
MCP_OAUTH_SECRET=<openssl rand -hex 32>
```

Cursor and Claude Code work against localhost as is. claude.ai connects from Anthropic's side, so the server must be reachable over HTTPS, through a reverse proxy or a tunnel.

That also means the sign-in page faces the internet. Put an IP allowlist in front of it. The docs include a tunnel example that only lets in Anthropic's published outbound range and your own networks. Sign-in attempts are rate limited as well, and the limits are configurable from 2.10.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

OAuth is off unless you turn it on. Existing token and `/auth` setups keep working.

## What next?

If you set this up behind a proxy I haven't tried, tell me how it went. Setup notes from real deployments make the docs better than anything I can write alone.
