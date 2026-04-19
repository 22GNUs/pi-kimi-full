/**
 * pi-kimi-full — Kimi For Coding (OAuth) provider extension for pi
 *
 * Brings the official Kimi device-flow OAuth path into pi, matching the
 * upstream kimi-cli 1:1. This is the K2.6 / `kimi-for-coding` OAuth path:
 * Moonshot routes static `sk-kimi-...` API keys to K2.5, and OAuth tokens
 * with `scope: kimi-code` to K2.6.
 *
 * Usage:
 *   1. Place this directory at ~/.pi/agent/extensions/pi-kimi-full/
 *      (or anywhere pi discovers extensions)
 *   2. Run: pi
 *   3. Run: /login kimi-for-coding-oauth
 *   4. Select the kimi-for-coding-oauth/kimi-for-coding model
 *
 * Key behaviors that mirror kimi-cli:
 *   - OAuth device flow with scope: kimi-code
 *   - Seven X-Msh-* headers + User-Agent matching the latest kimi-cli
 *     (fallback version pinned; background PyPI fetch warms cache non-blocking)
 *   - Shared ~/.kimi/device_id with locally-installed kimi-cli
 *   - prompt_cache_key for session-scoped cache reuse
 *   - thinking + reasoning_effort fields per thinking level
 *   - Model discovery from GET /coding/v1/models (wire model id rewrite)
 *   - Automatic token refresh with safety window
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { API_BASE_URL, MODEL_ID, PROVIDER_ID } from "./constants.ts"
import { getKimiCliVersion, kimiHeaders } from "./headers.ts"
import {
  loginKimi,
  refreshKimiToken,
  type KimiOAuthCredentials,
  type ModelDiscovery,
} from "./oauth.ts"

// =============================================================================
// Kimi body field types and mapping logic
// =============================================================================

type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: { type: "enabled" | "disabled" }
  reasoning_effort?: string
}

/**
 * Map pi's openai-style reasoning_effort to kimi's paired format.
 *
 * pi sends reasoning_effort as "minimal" | "low" | "medium" | "high" | "xhigh"
 * (when supportsReasoningEffort=true). kimi needs thinking.type + reasoning_effort:
 *
 * | pi effort  | kimi reasoning_effort | kimi thinking            |
 * |------------|----------------------|--------------------------|
 * | (absent)   | *(omitted)*          | *(omitted)*              | auto
 * | "minimal"  | *(omitted)*          | { type: "disabled" }    | off
 * | "low"      | "low"                | { type: "enabled" }     |
 * | "medium"   | "medium"             | { type: "enabled" }     |
 * | "high"     | "high"               | { type: "enabled" }     |
 * | "xhigh"    | "high"               | { type: "enabled" }     | (no xhigh in kimi)
 */
function resolveKimiBodyFields(payload: Record<string, unknown>): KimiBodyFields {
  const fields: KimiBodyFields = {}
  const effort = payload.reasoning_effort as string | undefined

  if (!effort) {
    return fields
  }

  if (effort === "minimal") {
    fields.thinking = { type: "disabled" }
    return fields
  }

  const kimiEffort = effort === "xhigh" ? "high" : effort

  if (["low", "medium", "high"].includes(kimiEffort)) {
    fields.thinking = { type: "enabled" }
    fields.reasoning_effort = kimiEffort
  }

  return fields
}

/**
 * Apply kimi-specific body fields to the request payload.
 *
 * Kimi uses a paired thinking.type + reasoning_effort format instead of
 * the standard OpenAI reasoning_effort alone. We always override these
 * fields because our compat.supportsReasoningEffort=true tells pi-ai to
 * emit reasoning_effort, and we transform it here.
 */
function applyKimiBodyFields(target: Record<string, unknown>, fields: KimiBodyFields) {
  if (fields.prompt_cache_key) {
    target.prompt_cache_key = fields.prompt_cache_key
  }

  if (fields.thinking) {
    target.thinking = fields.thinking
    if (fields.reasoning_effort) {
      target.reasoning_effort = fields.reasoning_effort
    } else {
      delete target.reasoning_effort
    }
  } else {
    delete target.thinking
    delete target.reasoning_effort
  }
}

// =============================================================================
// Module-level state
// =============================================================================

let cachedDiscovery: ModelDiscovery = {}
let currentSessionId: string | undefined
let versionFetchStarted = false

function isKimiRequestModel(model: string): boolean {
  if (model === MODEL_ID) return true
  return !!cachedDiscovery.model_id && model === cachedDiscovery.model_id
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  const registerKimiProvider = () => {
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: API_BASE_URL,
      apiKey: "KIMI_FOR_CODING_DUMMY",
      api: "openai-completions",
      authHeader: true,
      headers: kimiHeaders(),
      models: [
        {
          id: MODEL_ID,
          name: "Kimi For Coding",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 16384,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            maxTokensField: "max_tokens",
          },
        },
      ],
      oauth: {
        name: "Kimi For Coding (OAuth)",

        async login(callbacks) {
          return await loginKimi(callbacks)
        },

        async refreshToken(credentials) {
          return await refreshKimiToken(credentials)
        },

        getApiKey(credentials) {
          return credentials.access
        },

        modifyModels(models, credentials) {
          const discovery = (credentials as KimiOAuthCredentials)._discovery
          if (discovery?.model_id) {
            cachedDiscovery = discovery
          }

          return models.map((model) => {
            if (model.id !== MODEL_ID) return model
            const updated = { ...model }

            if (discovery?.context_length && discovery.context_length > 0) {
              updated.contextWindow = discovery.context_length
            }

            // Use the server-reported display_name so the user can see
            // which backend model their account is actually routed to.
            // The wire model id is the same for all tiers, so display_name
            // is the only way to tell them apart.
            if (discovery?.model_display) {
              updated.name = discovery.model_display
            }

            return updated
          })
        },
      },
    })
  }

  registerKimiProvider()

  pi.on("session_start", () => {
    currentSessionId = crypto.randomUUID()

    if (versionFetchStarted) return
    versionFetchStarted = true

    // Fire-and-forget: warm the version cache in the background.
    // Must not await — pi blocks on session_start handlers.
    getKimiCliVersion().catch(() => {})
  })

  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, unknown> | undefined
    if (!payload || typeof payload !== "object") return

    const model = payload.model as string | undefined
    if (!model || !isKimiRequestModel(model)) return

    const kimiFields = resolveKimiBodyFields(payload)
    if (currentSessionId) {
      kimiFields.prompt_cache_key = currentSessionId
    }
    applyKimiBodyFields(payload, kimiFields)

    if (
      cachedDiscovery.model_id &&
      cachedDiscovery.model_id !== MODEL_ID &&
      payload.model === MODEL_ID
    ) {
      payload.model = cachedDiscovery.model_id
    }

    return payload
  })
}
