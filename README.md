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
npm start                           # default: PORT=8182, DB=requests.db
PORT=8888 LLMPROXY_DB=foo.db npm start
```

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
