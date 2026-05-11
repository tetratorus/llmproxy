# llmproxy

Namespaced multi-provider LLM observability proxy. Forked from `cproxy`, generalised across providers.

Each provider gets its own URL prefix so the wire shape is unambiguous:

- `POST /claude/v1/messages`             → `api.anthropic.com` (Anthropic shape)
- `POST /deepseek/v1/chat/completions`   → `api.deepseek.com`  (OpenAI shape)
- `POST /openai/v1/chat/completions`     → `api.openai.com`    (OpenAI shape)
- `POST /kimi/v1/chat/completions`       → `api.moonshot.ai`   (OpenAI shape, alias `/moonshot`)
- `POST /xai/v1/chat/completions`        → `api.x.ai`          (OpenAI shape, alias `/grok`)
- `POST /gemini/v1beta/models/...`       → `generativelanguage.googleapis.com` (Gemini shape, alias `/google`)
- `POST /openrouter/v1/chat/completions` → `openrouter.ai/api` (OpenAI shape)
- `GET  /models`                          → list of supported models + their interface
- `GET  /health`                          → health check
- `GET  /api/requests`                    → captured requests (dashboard, paginated, FTS5 search)
- `GET  /api/requests/:id`                → single captured request

Every request is persisted to SQLite (default: `requests.db`) with full body, full response, status, latency, model, token usage. Sensitive headers (`x-api-key`, `authorization`, etc.) are redacted in storage.

## Run

```sh
npm install
npm start                           # default: PORT=8181, DB=requests.db
PORT=8888 LLMPROXY_DB=foo.db npm start
```

## Point your tools at the proxy

Each provider's SDK or CLI accepts a base-URL override. Set it to `http://localhost:8181/<provider>` and keep using your normal API key — the proxy forwards the request unchanged, records it, and returns the upstream response.

The version prefix (`/v1`, `/v1beta`) is auto-applied when missing, so both `…/openai` and `…/openai/v1` work. Use whichever matches your SDK's convention.

### Anthropic (Claude) — Claude Code, Anthropic SDK

```sh
export ANTHROPIC_BASE_URL=http://localhost:8181/claude
```

### OpenAI SDK

```sh
export OPENAI_BASE_URL=http://localhost:8181/openai/v1
```

In Python: `OpenAI(base_url="http://localhost:8181/openai/v1")`.

### DeepSeek (OpenAI-shape)

```sh
export OPENAI_BASE_URL=http://localhost:8181/deepseek/v1
```

### Codex CLI (ChatGPT-authed, not API-key)

In `~/.codex/config.toml`:

```toml
[model_provider]
base_url = "http://localhost:8181/codex"
```

### Gemini (Google)

No standard env var — pass it via SDK options:

```js
new GoogleGenAI({ httpOptions: { baseUrl: "http://localhost:8181/gemini" } })
```

### xAI (Grok)

```sh
export OPENAI_BASE_URL=http://localhost:8181/xai/v1
```

### Kimi (Moonshot)

```sh
export OPENAI_BASE_URL=http://localhost:8181/kimi/v1
```

### OpenRouter

```sh
export OPENAI_BASE_URL=http://localhost:8181/openrouter/v1
```

### LiteLLM SDK

LiteLLM uses its own env-var names: `OPENAI_API_BASE`, `ANTHROPIC_API_BASE`, `DEEPSEEK_API_BASE`, `XAI_API_BASE` (not the SDK-standard `*_BASE_URL`). Set those and your existing litellm code routes through the proxy with no changes:

```sh
export OPENAI_API_BASE=http://localhost:8181/openai/v1
export ANTHROPIC_API_BASE=http://localhost:8181/claude
export DEEPSEEK_API_BASE=http://localhost:8181/deepseek
export XAI_API_BASE=http://localhost:8181/xai/v1
```

For providers without a native litellm adapter (Kimi, OpenRouter, anything OpenAI-compat), pass `api_base` per call:

```python
litellm.completion(
    model="moonshot-v1-8k",
    api_base="http://localhost:8181/kimi/v1",
    api_key=os.environ["MOONSHOT_API_KEY"],
    custom_llm_provider="openai",
    messages=[...],
)
```

End-to-end test for all six providers: `python3 test_litellm.py` (proxy must be running).

### Optional: namespace by agent

Prefix the path with an agent name and the proxy tags the request in the dashboard:

```sh
export ANTHROPIC_BASE_URL=http://localhost:8181/cline/claude
export OPENAI_BASE_URL=http://localhost:8181/cursor/openai/v1
```

`/<agent>/<provider>/<path>` routes the same way as `/<provider>/<path>` — the agent segment is metadata only.

Open `http://localhost:8181/` to see the captured traffic.

## Test

End-to-end against real provider APIs. No stubs.

Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `OPENROUTER_API_KEY`, then:

```sh
npm test                  # all (skips cohorts whose key is unset)
npm run test:claude       # claude only
npm run test:deepseek     # deepseek only
npm run test:openai       # openai only
npm run test:kimi         # kimi (Moonshot AI) only
npm run test:openrouter   # openrouter only
npm run test:models       # static-route tests only
```

Tests run against a fresh `test.db` each invocation so token-count assertions are deterministic.

## Adding a provider

One entry in the `PROVIDERS` map in `server.js`:

```js
foo: {
  interface: 'openai',           // or 'anthropic'
  upstream:  'https://api.foo.com/v1/chat/completions',
  path:      '/foo/v1/chat/completions',
  default_headers: {},
  models:    ['foo-pro', 'foo-flash'],
}
```

…then mount the route:

```js
app.post('/foo/v1/chat/completions', (req, res) => handleProxy('foo', req, res));
```

That's it — DB capture, token extraction, streaming, header passthrough are all handled by the generic handler.
