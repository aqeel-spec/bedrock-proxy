# Claude Code → Any OpenAI-Compatible Model via Vercel Proxy

> **Production-ready Vercel Edge Function** that translates Claude Code's Anthropic Messages API into any OpenAI-compatible endpoint — GLM, Codex, Kimi, DeepSeek, or any model your provider hosts — **without redeploying**.

```
Claude Code  ──(Anthropic Messages API)──>  proxy  ──(OpenAI-compatible)──>  your provider
```

## Why This Matters

Claude Code only speaks the **Anthropic Messages** format. Most providers (AWS Bedrock, Z.ai, OpenRouter, OpenAI) speak the **OpenAI** format instead. This proxy:

✅ Translates both directions automatically  
✅ Handles **streaming** responses with no buffering  
✅ Supports **tool calling** (function definitions & results)  
✅ Switches models **without redeploying** — just change an env var  
✅ Works with **any** OpenAI-compatible provider  
✅ Production-hardened with logging, error handling, request validation  

## What's Included

| File | Purpose |
|------|------|
| `api/messages.js` | Main proxy for `POST /v1/messages` with streaming & tool support |
| `api/count_tokens.js` | Token estimation for `POST /v1/messages/count_tokens` |
| `vercel.json` | Route configuration for `/v1/messages*` endpoints |
| `package.json` | Project metadata and Node version requirement |

---

## Quick Start

### 1️⃣ Prerequisites

- **Vercel account** with [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
- **API key** from your model provider (see table below)
- **Node 18+** for local development

### 2️⃣ Deploy to Vercel

```bash
cd claude-bedrock-proxy
vercel login
vercel link   # Links this folder to a Vercel project
```

Set environment variables via **Vercel Dashboard** → **Settings** → **Environment Variables**:

```
OPENAI_BASE_URL          # e.g., https://openrouter.ai/api/v1
OPENAI_API_KEY           # Your upstream provider's API key
DEFAULT_MODEL_ID         # Fallback model if client sends none
MODEL_MAP                # Optional JSON mapping (see below)
PROXY_SECRET             # (Recommended) Guard your proxy with a secret key
ENABLE_LOGGING           # Set to 'true' to enable detailed request logging
```

Then deploy:

```bash
vercel --prod
```

**Save your deployment URL** — you'll need it in the next step (e.g., `https://my-proxy.vercel.app`).

### 3️⃣ Configure Claude Code

Export these environment variables **before** running `claude`:

```bash
export ANTHROPIC_BASE_URL="https://my-proxy.vercel.app"
export ANTHROPIC_AUTH_TOKEN="<YOUR_PROXY_SECRET>"          # If you set PROXY_SECRET
export ANTHROPIC_MODEL="zai.glm-5"  # Or any model your provider hosts
```

Then start Claude as normal:

```bash
claude
```

---

## Supported Providers

Pick the provider that matches your needs. All of these work out-of-the-box:

| Provider | OPENAI_BASE_URL | Notes |
|---|---|---|
| **AWS Bedrock (Mantle)** | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` | Use Bedrock API key; best for Anthropic models on AWS |
| **Z.ai (GLM direct)** | `https://open.bigmodel.cn/api/paas/v4` | Direct GLM access; fast & reliable for Chinese-region latency |
| **OpenRouter** | `https://openrouter.ai/api/v1` | One key, 100+ models; great for price/quality comparison |
| **OpenAI** | `https://api.openai.com/v1` | Works with GPT-4, Codex, o1, etc. |
| **Groq (fast inference)** | `https://api.groq.com/openai/v1` | Fastest open-source models (Mixtral, Llama) |
| **DeepSeek** | `https://api.deepseek.com/v1` | Advanced reasoning models |
| **Custom provider** | Your provider's OpenAI-compatible base URL | Any `/chat/completions`-compatible endpoint |

---

## Model Switching & Aliases

### Option A: Direct Model IDs

Send the exact upstream model ID directly. Whatever you put in `ANTHROPIC_MODEL` goes straight to your provider (unless mapped):

```bash
export ANTHROPIC_MODEL="zai.glm-5"
export ANTHROPIC_MODEL="gpt-4-turbo"
export ANTHROPIC_MODEL="mixtral-8x7b-32768"      # via Groq
export ANTHROPIC_MODEL="deepseek-coder"          # via DeepSeek
```

### Option B: Aliases via MODEL_MAP

Use short names if remembering exact model IDs is annoying. Set `MODEL_MAP` (as JSON) on the proxy:

**On Vercel dashboard**, set:
```json
{"glm": "zai.glm-5", "glm-flash": "zai.glm-4.7-flash", "gpt4": "gpt-4-turbo", "fast": "mixtral-8x7b-32768"}
```

**Then use aliases**:
```bash
export ANTHROPIC_MODEL="glm"      # proxy resolves to zai.glm-5
export ANTHROPIC_MODEL="fast"     # proxy resolves to mixtral-8x7b-32768
```

**Pro tip:** Switch models mid-project by exporting a new `ANTHROPIC_MODEL` and restarting Claude.

---

## 🛠️ Configuration & Security

### Environment Variables Reference

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPENAI_BASE_URL` | ✅ | — | Base URL of your OpenAI-compatible provider |
| `OPENAI_API_KEY` | ✅ | — | API key for upstream provider |
| `DEFAULT_MODEL_ID` | ❌ | — | Fallback model if client sends no model name |
| `MODEL_MAP` | ❌ | `{}` | JSON mapping of aliases to model IDs |
| `PROXY_SECRET` | ❌ | — | Secret key Claude Code must send as `x-api-key` header |
| `ENABLE_LOGGING` | ❌ | `false` | Set to `true` to log all requests |
| `AWS_REGION` | ❌ | `us-east-1` | AWS region (legacy Bedrock-only mode) |
| `AWS_BEDROCK_API_KEY` | ❌ | — | Legacy: Use `OPENAI_API_KEY` instead |

### Security Best Practices

1. **Always set `PROXY_SECRET`** in production:
   ```bash
   vercel env add PROXY_SECRET production "$(openssl rand -base64 32)"
   ```
   Claude Code must send it as the `x-api-key` header via `ANTHROPIC_AUTH_TOKEN`.

2. **Use environment-specific secrets**: Vercel lets you set different env vars per environment. Use this to rotate keys without downtime.

3. **Monitor costs**: Check your upstream provider's usage dashboard regularly. The proxy is stateless with no built-in rate limiting.

4. **Restrict Claude Code IP**: If your provider supports IP whitelisting, use it. Otherwise, rely on `PROXY_SECRET` auth alone.

5. **Rotate API keys periodically**: Set a reminder to refresh your `OPENAI_API_KEY` and `PROXY_SECRET` every 90 days.

---

## 📊 Monitoring & Observability

### Built-in Logging

Enable request logging by setting `ENABLE_LOGGING=true`:

```bash
vercel env add ENABLE_LOGGING production true
vercel deploy --prod
```

When enabled, the proxy logs:
- Unique request ID (for tracing)
- HTTP method, status code, duration
- Model name resolved
- Token counts
- Any errors or validation failures

**Log output appears in Vercel's function logs** (dashboard → Logs tab).

### Monitoring Metrics

Watch these in your Vercel dashboard:

| Metric | What to Watch |
|--------|---------------|
| **Function Invocations** | Should match your Claude Code activity |
| **Execution Time** | Streaming: 30s–2min; non-streaming: 5–30s |
| **Error Rate** | Should be <1% |
| **Bandwidth** | Proxy adds ~1-2% overhead |

### Debugging Failed Requests

When something goes wrong:

1. Check **Vercel dashboard → Logs**
2. Look for the request ID
3. Test with curl:
   ```bash
   curl -X POST https://your-proxy.vercel.app/v1/messages \
     -H "x-api-key: $PROXY_SECRET" \
     -H "content-type: application/json" \
     -d '{
       "model": "glm",
       "messages": [{"role": "user", "content": "hello"}],
       "max_tokens": 100
     }'
   ```

---

## 🐛 Troubleshooting

### ❌ "Invalid x-api-key" or "Authentication failed"

**Cause:** Claude Code's `ANTHROPIC_AUTH_TOKEN` doesn't match `PROXY_SECRET`.

**Fix:**
```bash
vercel env pull   # Check what's set on Vercel
echo $ANTHROPIC_AUTH_TOKEN  # Verify on client
```

---

### ❌ "No model resolved"

**Cause:** Neither `ANTHROPIC_MODEL` on client nor `DEFAULT_MODEL_ID` on proxy is set.

**Fix:**
```bash
export ANTHROPIC_MODEL="zai.glm-5"
# OR on proxy:
vercel env add DEFAULT_MODEL_ID production "zai.glm-5"
vercel deploy --prod
```

---

### ❌ "502 api_error: Failed to reach upstream"

**Cause:** Proxy can't connect to your provider's API.

**Fix:**
1. Verify `OPENAI_BASE_URL` is correct (check for typos, trailing slashes)
2. Test with curl:
   ```bash
   curl -X POST $OPENAI_BASE_URL/chat/completions \
     -H "authorization: Bearer $OPENAI_API_KEY" \
     -H "content-type: application/json" \
     -d '{"model":"glm","messages":[{"role":"user","content":"hi"}]}'
   ```
3. Check your provider's status page
4. Verify the API key is active and not rate-limited

---

### ❌ "502 api_error: Upstream returned 401"

**Cause:** Upstream provider rejected the API key.

**Fix:**
1. Verify `OPENAI_API_KEY` is correct
2. Log in to your provider's dashboard and confirm the key is active
3. Check if the key has been rotated or if you've hit a usage limit

---

### ❌ Streaming response cuts off or hangs

**Cause:** Upstream connection closed early or proxy timeout.

**Fix:**
1. Check Vercel function timeout (Pro plan has 60s, Hobby has 10s)
2. Verify your `max_tokens` isn't too high
3. Enable logging to see where the stream stopped

---

### ❌ "Request body exceeds 1MB limit"

**Cause:** Your messages, tools, or other request data is too large.

**Fix:**
- Reduce system prompt size
- Use fewer examples in few-shot prompts
- Break large tasks into multiple requests

---

## 🚀 Best Practices

### Start with a "cheap" model for testing

Don't jump straight to your favorite expensive model:

- **For testing:** Mixtral-8x7b (via Groq) or GLM Flash (via Z.ai)
- **For production:** GPT-4, Claude 3.5 Sonnet, or GLM-5

Switching is one env var change — no redeploy.

### Use MODEL_MAP for easy aliasing

Avoid memorizing long model IDs:

```json
{
  "test": "mixtral-8x7b-32768",
  "fast": "zai.glm-4.7-flash",
  "best": "gpt-4-turbo"
}
```

Then switch with `export ANTHROPIC_MODEL=test`.

### Monitor your upstream API costs

Set up budget alerts in your provider's dashboard. The proxy is stateless and transparent — whatever you'd spend using the provider directly, you'll spend here.

### Test model switching mid-session

Verify that changing `ANTHROPIC_MODEL` and restarting Claude works:

```bash
export ANTHROPIC_MODEL=test
claude            # run a small task
^C

export ANTHROPIC_MODEL=best
claude            # same task, compare quality
```

### Keep config in a shell script

Create a `setenv.sh`:

```bash
#!/bin/bash
export ANTHROPIC_BASE_URL="https://my-proxy.vercel.app"
export ANTHROPIC_AUTH_TOKEN="my-secret-key"
export ANTHROPIC_MODEL="glm"
exec "${@:-bash}"
```

Then:
```bash
source setenv.sh
claude
```

---

## Known Limitations & Edge Cases

- **Images are dropped.** Anthropic image content blocks are replaced with `[image omitted]` text, since not all OpenAI-compatible providers accept the same image formats.
- **Token counts are estimates** wherever the underlying model doesn't return exact usage.
- **Prompt caching and extended thinking** are Claude-specific features with no OpenAI equivalent — they're ignored.
- **Tool-call argument streaming** assumes the upstream streams `tool_calls[].function.arguments` as incremental JSON fragments (standard OpenAI format).
- Model quality and tool-use reliability vary by provider — test each new model on low-stakes tasks first.

---

## License

MIT
