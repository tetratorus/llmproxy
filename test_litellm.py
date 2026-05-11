#!/usr/bin/env python3
"""End-to-end test: route litellm-SDK calls through the running llmproxy and
verify each call is captured in the DB via the dashboard API.

Assumes the proxy is already running. Defaults to http://localhost:8181 — set
PROXY_URL to override. Reads .env for provider keys (same file test.js uses);
shell env wins. Each provider cohort skips itself if its key is unset.

Usage:
    python3 test_litellm.py                # all cohorts
    python3 test_litellm.py openai claude  # subset

What it proves: when a litellm SDK user sets api_base to one of the proxy's
per-provider routes, litellm still talks the upstream's native wire shape, so
the proxy captures the request unchanged and the dashboard finds it.
"""

import os
import sys
import time
import json
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path

# Load .env (shell env wins).
ENV_FILE = Path(__file__).parent / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        m = line.strip()
        if not m or m.startswith("#") or "=" not in m:
            continue
        k, _, v = m.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

PROXY = os.environ.get("PROXY_URL", "http://localhost:8181").rstrip("/")

import litellm  # noqa: E402

# Each cohort = (tag, provider, model, api_key_env, api_base, extra_kwargs).
# api_base maps to the proxy's per-provider route. The provider column in the
# captured row is what we assert against — it's set by the proxy from the URL
# prefix, not by litellm. extra_kwargs covers per-provider quirks (e.g. some
# providers want custom_llm_provider to disable litellm-side translation we
# don't want here).
COHORTS = [
    {
        "tag":      "openai",
        "provider": "openai",
        "model":    "gpt-4o-mini",
        "key_env":  "OPENAI_API_KEY",
        "api_base": f"{PROXY}/openai/v1",
    },
    {
        "tag":      "claude",
        "provider": "claude",
        "model":    "anthropic/claude-haiku-4-5-20251001",
        "key_env":  "ANTHROPIC_API_KEY",
        "api_base": f"{PROXY}/claude",
    },
    {
        "tag":      "deepseek",
        "provider": "deepseek",
        "model":    "deepseek/deepseek-chat",
        "key_env":  "DEEPSEEK_API_KEY",
        "api_base": f"{PROXY}/deepseek",
    },
    {
        "tag":      "kimi",
        "provider": "kimi",
        # litellm doesn't ship a moonshot adapter — route via openai shape
        # with custom_llm_provider="openai", since Moonshot is OpenAI-compat.
        "model":    "moonshot-v1-8k",
        "key_env":  "MOONSHOT_API_KEY",
        "api_base": f"{PROXY}/kimi/v1",
        "extra":    {"custom_llm_provider": "openai"},
    },
    {
        "tag":      "openrouter",
        "provider": "openrouter",
        "model":    "openrouter/google/gemini-2.5-flash",
        "key_env":  "OPENROUTER_API_KEY",
        "api_base": f"{PROXY}/openrouter/v1",
    },
    {
        "tag":      "xai",
        "provider": "xai",
        "model":    "xai/grok-3",
        "key_env":  "XAI_API_KEY",
        "api_base": f"{PROXY}/xai/v1",
    },
]


def http_get_json(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_for_proxy():
    try:
        h = http_get_json(f"{PROXY}/health", timeout=5)
        if h.get("status") != "healthy":
            sys.exit(f"proxy /health returned {h}")
    except urllib.error.URLError as e:
        sys.exit(f"proxy not reachable at {PROXY}/health — start `npm start` first ({e.reason})")
    print(f"✓ proxy healthy at {PROXY} (db={h.get('db')})")


def search_db(marker, attempts=3, delay=0.5):
    """Poll /api/requests?search=<marker>. FTS5 indexing of large DBs can take
    several seconds, so we use a long per-request timeout but few retries."""
    url = f"{PROXY}/api/requests?search={urllib.parse.quote(marker)}&limit=5"
    for _ in range(attempts):
        j = http_get_json(url, timeout=60)
        if j.get("total", 0) >= 1:
            return j
        time.sleep(delay)
    return j


def run_cohort(cohort):
    name    = cohort["tag"]
    key_env = cohort["key_env"]
    if not os.environ.get(key_env):
        return ("SKIP", f"{key_env} unset")

    # Marker goes in the prompt so we can find the captured DB row via FTS5
    # search later. Keep it lowercase + simple — some providers' safety filters
    # (notably xAI's) reject all-caps tokens as suspicious.
    marker = f"litellm-marker-{os.getpid()}-{int(time.time() * 1000)}-{name}"
    api_key = os.environ[key_env]
    extra = cohort.get("extra", {})

    try:
        resp = litellm.completion(
            model=cohort["model"],
            api_base=cohort["api_base"],
            api_key=api_key,
            messages=[{"role": "user", "content": f"reply with the word ok and also include this token: {marker}"}],
            max_tokens=64,
            **extra,
        )
    except Exception as e:
        return ("FAIL", f"litellm.completion raised: {type(e).__name__}: {e}")

    content = ""
    try:
        content = resp["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ("FAIL", f"unexpected response shape: {resp}")

    found = search_db(marker)
    total = found.get("total", 0)
    if total < 1:
        return ("FAIL", f"no captured row for marker {marker}")

    rows = found.get("requests", [])
    row = rows[0]
    if row.get("provider") != cohort["provider"]:
        return ("FAIL", f"row.provider={row.get('provider')} expected {cohort['provider']}")
    if row.get("status_code") != 200:
        return ("FAIL", f"row.status_code={row.get('status_code')}")

    return ("PASS", f"model={cohort['model']} → provider={row['provider']} "
                    f"status={row['status_code']} in={row.get('input_tokens')} out={row.get('output_tokens')}")


def main():
    wait_for_proxy()
    filters = set(sys.argv[1:])

    results = []
    for c in COHORTS:
        if filters and c["tag"] not in filters:
            continue
        status, detail = run_cohort(c)
        tag = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭ "}[status]
        print(f"{tag} litellm → /{c['tag']}: {detail}")
        results.append((status, c["tag"], detail))

    passed  = sum(1 for s, *_ in results if s == "PASS")
    failed  = sum(1 for s, *_ in results if s == "FAIL")
    skipped = sum(1 for s, *_ in results if s == "SKIP")
    print("\n──────────────────────────────────")
    print(f"Passed:  {passed}")
    print(f"Failed:  {failed}")
    print(f"Skipped: {skipped}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
