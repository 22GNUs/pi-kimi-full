# pi-kimi-full

Kimi For Coding (OAuth) provider extension for pi, matching the official kimi-cli 1:1.

## What it does

- Registers `kimi-for-coding-oauth` provider with pi
- Uses the official Kimi device flow OAuth against `https://auth.kimi.com` with `scope: kimi-code`
- Talks to `https://api.kimi.com/coding/v1` via OpenAI-compatible completions API
- Sends the same `User-Agent` / `X-Msh-*` fingerprint headers as `kimi-cli`
- **Dynamically fetches the latest kimi-cli version** from PyPI at startup — no hardcoded version
- Reuses `~/.kimi/device_id` for `X-Msh-Device-Id` (shared with kimi-cli)
- Adds `prompt_cache_key`, `thinking`, and `reasoning_effort` for kimi-for-coding requests
- Model discovery from `GET /coding/v1/models` to get the correct wire model id and context length
- Currently the only way to get Kimi K2.6 outside of using Kimi CLI + OAuth

> **Note:** This is the K2.6 / `kimi-for-coding` OAuth path. Moonshot routes static `sk-kimi-...` API keys to K2.5, and OAuth tokens with `scope: kimi-code` to K2.6.

## Install

### Install

```bash
pi install git:github.com/22GNUs/pi-kimi-full
```

To install for the current project only:

```bash
pi install -l git:github.com/22GNUs/pi-kimi-full
```

Or try without installing:

```bash
pi -e git:github.com/22GNUs/pi-kimi-full
```

## Usage

1. Start pi
2. Run `/login kimi-for-coding-oauth`
3. Open the verification URL and approve the device code
4. Select `kimi-for-coding-oauth / kimi-for-coding` as your model

## Thinking Levels

pi's thinking levels map to kimi's wire format as follows:

| pi level  | reasoning_effort | thinking            | Behavior |
|-----------|------------------|--------------------|----------|
| (none)    | *(omitted)*      | *(omitted)*        | Auto — server decides |
| minimal   | *(omitted)*      | { type: "disabled" }| Thinking off |
| low       | "low"            | { type: "enabled" } | Low reasoning effort |
| medium    | "medium"         | { type: "enabled" } | Medium reasoning effort |
| high      | "high"           | { type: "enabled" } | High reasoning effort |
| xhigh     | "high"           | { type: "enabled" } | Mapped to high |

Use `Ctrl+T` or `/think` in pi to cycle through thinking levels.

## Request Fields

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, set to session id | Session-scoped cache key, mirroring kimi-cli |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high"` | Sent together, matching kimi-cli |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-Os-Version` | Matches kimi-cli's `_kimi_default_headers()` |
| `~/.kimi/device_id` | UUID persisted on disk, in `X-Msh-Device-Id` | Same `X-Msh-Device-Id` as a locally-installed kimi-cli |

## Version Strategy

kimi-cli itself reads its version dynamically via `importlib.metadata.version("kimi-cli")`. We mirror this by fetching the latest version from the PyPI JSON API at startup. If the fetch fails, we fall back to a known-good pinned version.

This means **no code changes are needed when kimi-cli updates** — the next time pi starts, the extension automatically picks up the new version.

## Files the extension touches

| Path | Purpose |
|---|---|
| `~/.kimi/device_id` | Stable UUID used in `X-Msh-Device-Id`. Shared with kimi-cli. |
| `~/.pi/agent/auth.json` | Token storage for `kimi-for-coding-oauth` provider, managed by pi. |

No other state is persisted. Credentials are never written to `~/.kimi/credentials/`; that path belongs to kimi-cli, and sharing it would cause refresh-token races.

## Architecture

```
┌────────────── pi core ──────────────────┐
│                                          │
│  /login ──▶ oauth.login()               │  device-code flow, poll
│               └─▶ oauth.ts               │
│                                          │
│  chat ────▶ registerProvider()           │  Provider with:
│               ├─▶ headers: kimiHeaders() │   • 7 X-Msh-* headers
│               ├─▶ authHeader: true       │   • Authorization: Bearer
│               └─▶ api: openai-completions│   • OpenAI-compat streaming
│                                          │
│  request ──▶ before_provider_request     │  Custom payload rewrite:
│               ├─▶ thinking.type          │   • thinking + reasoning_effort
│               ├─▶ reasoning_effort       │   • prompt_cache_key
│               └─▶ prompt_cache_key       │   • wire model id rewrite
│                                          │
│  refresh ──▶ oauth.refreshToken()        │  Token refresh + model
│               └─▶ oauth.ts               │  discovery on refresh
│                                          │
│  models ──▶ oauth.modifyModels()         │  Context window + wire
│               └─▶ discovery metadata     │  model id from /models
└──────────────────────────────────────────┘
```

## License

MIT
