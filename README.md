# Claude Code OpenAI-Compatible Proxy

This Node.js proxy translates Claude Code's Anthropic Messages API into the OpenAI-compatible `/chat/completions` API used by Bedrock Mantle, Z.ai, OpenRouter, OpenAI, Groq, DeepSeek, and other compatible providers.

It runs locally with Node.js and has no Vercel dependency. The same process can later run on a personal VPS or another Node.js hosting provider.

## Requirements

- Node.js 18 or newer
- An API key from an OpenAI-compatible provider
- Claude Code, if you want to use the proxy from Claude Code

## Local Setup

From the project directory:

```powershell
npm install
Copy-Item .env.example .env
```

Open `.env` and set at least:

```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=your-provider-key
DEFAULT_MODEL_ID=your-provider-model-id
PROXY_SECRET=choose-a-private-proxy-secret
```

`OPENAI_BASE_URL` must be the provider base URL without `/chat/completions`; the proxy adds that path automatically. `.env.example` is safe to commit. `.env` and `.env.local` are private and ignored by git.

Start the proxy:

```powershell
npm start
```

The server listens on `http://127.0.0.1:3000` by default. During development, use automatic restart:

```powershell
npm run dev
```

To use another port or make the server reachable from another machine:

```powershell
$env:PORT=8080
$env:HOST='0.0.0.0'
npm start
```

## Endpoints

### Messages

`POST /v1/messages` translates Anthropic requests and supports non-streaming responses, streaming SSE responses, tools, model aliases, validation, request IDs, and optional logging.

Test it with PowerShell:

```powershell
$body = @{
  model = 'your-model-id'
  max_tokens = 100
  messages = @(@{ role = 'user'; content = 'Say hello' })
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/v1/messages `
  -Method Post `
  -Headers @{ 'x-api-key' = 'choose-a-private-proxy-secret' } `
  -ContentType 'application/json' `
  -Body $body
```

The `x-api-key` header is required when `PROXY_SECRET` is set. Claude Code supplies it through `ANTHROPIC_AUTH_TOKEN`.

### Token estimate

`POST /v1/messages/count_tokens` returns a rough input-token estimate and does not call the upstream provider:

```powershell
$body = '{"messages":[{"role":"user","content":"hello"}]}'
Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/v1/messages/count_tokens `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

## Configure Claude Code

With the local proxy running, set these variables in the same terminal before starting Claude Code:

```powershell
$env:ANTHROPIC_BASE_URL='http://127.0.0.1:3000'
$env:ANTHROPIC_AUTH_TOKEN='choose-a-private-proxy-secret'
$env:ANTHROPIC_MODEL='your-model-id'
claude
```

On macOS/Linux:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=choose-a-private-proxy-secret
export ANTHROPIC_MODEL=your-model-id
claude
```

## Providers And Model Aliases

The proxy forwards any model name unless it matches `MODEL_MAP`. For example:

```env
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=your-zai-key
DEFAULT_MODEL_ID=zai.glm-4.7
MODEL_MAP={"glm":"zai.glm-5","fast":"zai.glm-4.7-flash"}
```

Then use `ANTHROPIC_MODEL=glm` in Claude Code. Any service exposing an OpenAI-compatible `/chat/completions` endpoint can be used. The legacy `AWS_REGION`, `AWS_BEDROCK_API_KEY`, and `BEDROCK_MODEL_ID` variables remain available as a fallback.

## Configuration Reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_BASE_URL` | Yes, unless using legacy fallback | Provider base URL without `/chat/completions` |
| `OPENAI_API_KEY` | Yes, unless using legacy fallback | Upstream bearer token |
| `DEFAULT_MODEL_ID` | Recommended | Model used when the client sends no model |
| `MODEL_MAP` | No | JSON object mapping aliases to provider model IDs |
| `PROXY_SECRET` | Recommended | Protects the proxy through the `x-api-key` header |
| `ENABLE_LOGGING` | No | Set to `true` for structured request logs |
| `PORT` | No | Local/server port, default `3000` |
| `HOST` | No | Bind address, default `127.0.0.1` |

## Deploy Later To A VPS Or Node Hosting Provider

There is no hosting lock-in. On a VPS, install Node.js 18+, copy the repository, create `.env` from `.env.example`, and run:

```bash
npm ci
npm start
```

For a real deployment, run the process under `systemd`, PM2, or Docker, put HTTPS in front of it with Nginx or Caddy, keep `HOST=127.0.0.1` behind the reverse proxy, and configure a firewall. Never expose the upstream API key in client-side code. Keep `PROXY_SECRET` enabled and rotate both secrets if they are ever exposed.

The application listens on one HTTP port and supports the two routes above, so any provider that can run a long-lived Node.js process can host it.

## Security Notes

- `.env.example` contains placeholders only and is intended for GitHub.
- `.env`, `.env.local`, and `.env.*.local` are ignored by git.
- Vercel project metadata and Vercel environment files are not part of this project.
- Treat any API key that was previously stored in a committed environment file as compromised and rotate it with the provider.
- The proxy has a 1 MB request-body limit and does not provide rate limiting. Add rate limiting at the reverse proxy or hosting layer for public deployments.

## Known Limitations

- Images are replaced with an explanatory text placeholder.
- Token counting is an estimate when the upstream does not provide exact usage.
- Prompt caching and extended-thinking options are not translated.
- Tool-call streaming follows the standard OpenAI SSE shape; providers with non-standard streaming formats may need adapter changes.
