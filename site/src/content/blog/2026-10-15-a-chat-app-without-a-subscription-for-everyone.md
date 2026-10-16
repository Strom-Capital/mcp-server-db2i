---
title: A chat app without a subscription for everyone
description: Version 3.7 adds an example web app that signs people in with their IBM i profile and lets them ask questions with one shared API key or a local model.
date: 2026-10-15T18:00:00Z
audience: ibmi
tags: [release, web-app, oauth]
---

So far, using this Model Context Protocol (MCP) server meant having an AI client: claude.ai, ChatGPT, Cursor or Claude Code. That works well for people who already have one. But most companies don't buy a Claude, Gemini or ChatGPT seat for everyone who might want to ask about orders or stock levels once a week. Version 3.7 adds an example web app in [`examples/web-app`](https://github.com/Strom-Capital/mcp-server-db2i/tree/main/examples/web-app). People open it in the browser, sign in with their own IBM i user profile and ask. The model behind it is your choice.

<figure class="shot wide" data-video="web-app">
  <video class="light" data-theme-version="light" controls playsinline preload="none" width="1920" height="1080" poster="/video/web-app-light.jpg" aria-label="A walkthrough of the example web app: signing in with an IBM i user profile, asking a question, sorting and filtering the result table, and charts drawn by the server's result view">
    <source src="/video/web-app-light.mp4" type="video/mp4" />
    <track kind="captions" srclang="en" label="English" src="/video/web-app.vtt" />
  </video>
  <video class="dark" data-theme-version="dark" controls playsinline preload="none" width="1920" height="1080" poster="/video/web-app-dark.jpg" aria-label="A walkthrough of the example web app: signing in with an IBM i user profile, asking a question, sorting and filtering the result table, and charts drawn by the server's result view">
    <source src="/video/web-app-dark.mp4" type="video/mp4" />
    <track kind="captions" srclang="en" label="English" src="/video/web-app.vtt" />
  </video>
  <figcaption>The web app in under two minutes, with sound and captions. Sample data.</figcaption>
</figure>

<figure class="shot">
  <img class="light" src="/images/blog/web-app-chat.png" width="1920" height="1080" alt="The web app chat: a sidebar with saved chats grouped by day, a question about the 20 most recent orders in MYLIB.ORDERS, a collapsed execute_query tool card with 20 rows and an Export button, and the answer with a table of orders per warehouse" />
  <img class="dark" src="/images/blog/web-app-chat-dark.png" width="1920" height="1080" alt="The web app chat: a sidebar with saved chats grouped by day, a question about the 20 most recent orders in MYLIB.ORDERS, a collapsed execute_query tool card with 20 rows and an Export button, and the answer with a table of orders per warehouse" />
  <figcaption>The chat, with saved chats in the sidebar. Sample data.</figcaption>
</figure>

## One key for the whole company

The app talks to Anthropic, OpenAI, Google Gemini or any OpenAI-compatible endpoint. There are two ways to give it a key.

- **One company key on the app's server.** Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` in the app's environment, and everyone who signs in uses it. The provider bills that one account per use, so a team that asks a few questions a day pays for those questions, not for a seat each.
- **Each user's own key**, entered in Settings and kept in their browser. If a user enters one, it's used instead of the company key.

The company key stays on the app's server. The browser only learns that a key exists, error messages have it removed, and the app refuses to use it for anyone who hasn't signed in to the IBM i. `DEFAULT_PROVIDER` and `DEFAULT_MODEL` set the model a new user starts with, so they can ask their first question without opening Settings:

```env
ANTHROPIC_API_KEY=sk-ant-...
DEFAULT_PROVIDER=anthropic
DEFAULT_MODEL=claude-sonnet-5-5
```

Set a spending limit on the provider account. That's where the cost is visible and where you can cap it.

## Or a local model

Choose **OpenAI-compatible** and point the app at Ollama, LM Studio or vLLM. Questions and query results then never leave your network, and there's no per-use bill at all. `CUSTOM_MODEL_BASE_URLS` lists the addresses the app may call, so it can't be turned into a way to reach arbitrary hosts.

The trade-off is plain: tool calling needs a capable model. Small local models often pick the wrong table or call tools badly. Larger ones do much better, and need the hardware to match.

## Everyone signs in as themselves

The app uses the server's built-in OAuth sign-in from [version 2.9](/blog/sign-in-with-your-ibm-i-profile). The password goes only to the server's sign-in page, and the tokens stay in an encrypted, httpOnly cookie on the app's server. Every query runs with the signed-in user's own IBM i authority, through the same read-only connection, SQL validator and library allowlist as any other client. A shared model key does not mean shared data access.

## What's in it

- **Chat** with saved chats in a sidebar, searchable by text or by the SQL they ran.
- **Result tables** you can sort, filter and copy to Excel. **Export** in the tool card has the server write every row to Excel or CSV with `export_query`, past the row limit.
- **Tools**: every tool the server lists, with your [business SQL tools](/blog/teaching-the-model-your-schema-with-yaml) grouped by toolset. Each has a form, so you can run a tool without the model.
- **Context**: the table notes and joins the model reads.
- Light and dark themes.

<figure class="shot">
  <img class="light" src="/images/blog/web-app-tools.png" width="1920" height="1080" alt="The Tools page: business SQL tools grouped by toolset, and the list_sales_orders tool with its description and a form with customer, order type, from date and status fields" />
  <img class="dark" src="/images/blog/web-app-tools-dark.png" width="1920" height="1080" alt="The Tools page: business SQL tools grouped by toolset, and the list_sales_orders tool with its description and a form with customer, order type, from date and status fields" />
  <figcaption>The Tools page, with the sample tools from examples/erp-tools.</figcaption>
</figure>

On the server side, business tools now carry `_meta["db2i-mcp/tool"]` in `tools/list`, with `kind: "business"` and their toolset. That's how the Tools page groups them, and any other client can do the same.

## Use it, change it, or take the parts

It's an example, MIT licensed, built with Next.js, AI SDK and shadcn/ui. You can run it as it is on its own address, such as `https://ask.example.com`, and link to it from your intranet. You can change it to fit how your company works: your own logo and colors, fewer pages, a fixed model. Or you can take the parts you need, such as the chat route and the result table, into a React app you already run. It's a starting point, not a product: it has no admin screens and no usage reports.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

The server change is additive: one more field on business tools in `tools/list`. The app needs the server in HTTP mode with `MCP_OAUTH_ENABLED=true`. [The web app docs](https://docs.db2i-mcp.com/web-app) cover the setup, the settings and where data goes.

## What this means for business users

If your company doesn't hand out AI subscriptions, you can still ask your IBM i questions in plain language. Your IT team runs the app once, and you sign in with the same user you use for the ERP.
