// Constants that mirror kimi-cli. When upstream bumps, the version is
// fetched dynamically from PyPI (see headers.ts), but we keep a pinned
// fallback here for when the PyPI API is unreachable.
//
// Source of truth: research/kimi-cli/src/kimi_cli/constant.py,
// research/kimi-cli/src/kimi_cli/auth/oauth.py

export const KIMI_CLI_VERSION_FALLBACK = "1.36.0"

export const OAUTH_HOST = "https://auth.kimi.com"
export const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`
export const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`
export const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const OAUTH_SCOPE = "kimi-code"
export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const OAUTH_REFRESH_GRANT = "refresh_token"

export const API_BASE_URL = "https://api.kimi.com/coding/v1"
export const MODEL_ID = "kimi-for-coding"

// Provider id used by pi. Intentionally NOT "kimi-for-coding" to avoid
// colliding with any future built-in entry for static API key flow.
export const PROVIDER_ID = "kimi-for-coding-oauth"

// Refresh a bit before the server-reported expiry so we never race it.
export const REFRESH_SAFETY_WINDOW_MS = 60_000

// PyPI JSON API for fetching the latest kimi-cli version at runtime.
// kimi-cli itself reads its version dynamically via
// importlib.metadata.version("kimi-cli"), so there is no hardcoded
// version on the server side — Moonshot only validates the UA prefix
// "KimiCLI/", not the version number. We mirror this by fetching the
// latest version from PyPI and falling back to the pinned constant
// above when the API is unreachable.
export const PYPI_KIMI_CLI_URL = "https://pypi.org/pypi/kimi-cli/json"
