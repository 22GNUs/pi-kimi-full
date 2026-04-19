import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import childProcess from "node:child_process"
import { KIMI_CLI_VERSION_FALLBACK, PYPI_KIMI_CLI_URL } from "./constants.ts"

// =============================================================================
// Device ID — shared with kimi-cli via ~/.kimi/device_id
// =============================================================================

// kimi-cli persists its device id at `~/.kimi/device_id` as a plain UUIDv4
// hex string (no dashes). We intentionally share the same path so users who
// also run the real kimi CLI keep a single stable fingerprint.
const DEVICE_ID_DIR = path.join(os.homedir(), ".kimi")
const DEVICE_ID_PATH = path.join(DEVICE_ID_DIR, "device_id")

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function getDeviceId(): string {
  ensureDir(DEVICE_ID_DIR)
  if (fs.existsSync(DEVICE_ID_PATH)) {
    const existing = fs.readFileSync(DEVICE_ID_PATH, "utf8").trim()
    if (existing) return existing
  }
  const id = crypto.randomUUID().replace(/-/g, "")
  fs.writeFileSync(DEVICE_ID_PATH, id, { mode: 0o600 })
  return id
}

// =============================================================================
// Dynamic kimi-cli version — fetched from PyPI, cached in memory + on disk
// =============================================================================

const VERSION_CACHE_PATH = path.join(DEVICE_ID_DIR, ".pi_kimi_version_cache")
const DAY_MS = 24 * 60 * 60 * 1000

let cachedVersion: string | undefined
let versionFetchPromise: Promise<string> | undefined

function readDiskVersionCache(): string | undefined {
  try {
    const raw = fs.readFileSync(VERSION_CACHE_PATH, "utf8")
    const data = JSON.parse(raw) as { version?: string; fetchedAt?: string }
    if (
      data.version &&
      data.fetchedAt &&
      Date.now() - new Date(data.fetchedAt).getTime() < DAY_MS
    ) {
      return data.version
    }
  } catch {}
  return undefined
}

function writeDiskVersionCache(version: string) {
  try {
    fs.writeFileSync(
      VERSION_CACHE_PATH,
      JSON.stringify({ version, fetchedAt: new Date().toISOString() }),
      { mode: 0o600 }
    )
  } catch {}
}

/**
 * Fetch the latest kimi-cli version from the PyPI JSON API.
 *
 * kimi-cli itself reads its version dynamically via
 * `importlib.metadata.version("kimi-cli")`, and Moonshot's backend only
 * validates the UA *prefix* ("KimiCLI/"), not the specific version number.
 * We mirror this by fetching the latest published version so the plugin
 * stays current without code changes.
 *
 * Caching strategy (daily):
 *   1. In-memory cache (process lifetime)
 *   2. Disk cache at ~/.kimi/.pi_kimi_version_cache (24h TTL)
 *   3. Live PyPI fetch (10s timeout)
 *   4. Hard-coded fallback constant
 *
 * Falls back to `KIMI_CLI_VERSION_FALLBACK` if PyPI is unreachable.
 */
export async function getKimiCliVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion
  if (versionFetchPromise) return versionFetchPromise

  versionFetchPromise = (async () => {
    // 2. Disk cache (daily)
    const disk = readDiskVersionCache()
    if (disk) {
      cachedVersion = disk
      return disk
    }

    // 3. Live fetch
    try {
      const res = await fetch(PYPI_KIMI_CLI_URL, {
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/json" },
      })
      if (!res.ok) throw new Error(`PyPI returned ${res.status}`)
      const json = (await res.json()) as { info?: { version?: string } }
      const version = json?.info?.version
      if (version && /^\d+\.\d+\.\d+$/.test(version)) {
        cachedVersion = version
        writeDiskVersionCache(version)
        return version
      }
      throw new Error("Invalid version from PyPI")
    } catch {
      cachedVersion = KIMI_CLI_VERSION_FALLBACK
      return cachedVersion
    }
  })()

  return versionFetchPromise
}

/**
 * Synchronous getter for the cached version. Returns the fallback if the
 * async fetch hasn't completed yet. Used by kimiHeaders() which must be
 * synchronous (called at provider registration time).
 */
export function getCachedKimiCliVersion(): string {
  return cachedVersion ?? KIMI_CLI_VERSION_FALLBACK
}

/**
 * Mutate an existing headers object in-place with the latest cached version.
 *
 * pi stores provider.headers by reference and re-reads it via
 * `Object.entries()` on every request, so in-place mutation updates live
 * requests without re-registering the provider.
 */
export function updateHeadersVersion(
  headers: Record<string, string>,
  version: string
) {
  headers["User-Agent"] = `KimiCLI/${version}`
  headers["X-Msh-Version"] = version
}

// =============================================================================
// Header value sanitization
// =============================================================================

// Non-ASCII characters in HTTP headers will be rejected by Node's undici
// fetch (`TypeError: Invalid character in header content`). kimi-cli strips
// non-ASCII bytes in oauth._ascii_header_value; we do the same while also
// dropping control characters to stay within Node's header rules.
export function asciiHeaderValue(value: string, fallback = "unknown"): string {
  const sanitized = value.replace(/[^\x20-\x7e]/g, "").trim()
  return sanitized || fallback
}

// =============================================================================
// Device model string — mirrors kimi-cli's _device_model()
// =============================================================================

let cachedMacVersion: string | undefined

function macProductVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined
  if (cachedMacVersion !== undefined) return cachedMacVersion || undefined
  try {
    cachedMacVersion = childProcess.execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    cachedMacVersion = ""
  }
  return cachedMacVersion || undefined
}

/**
 * Mirrors kimi-cli's `_device_model()` logic, including the Darwin/Windows
 * special cases. Must produce the same string format — Moonshot's backend
 * 403s if this field is off-spec.
 */
export function kimiDeviceModel(input?: {
  system?: string
  release?: string
  machine?: string
  macVersion?: string
}) {
  const system = input?.system ?? os.type()
  const release = input?.release ?? os.release()
  const machine = input?.machine ?? os.machine?.() ?? os.arch()

  if (system === "Darwin") {
    const version = input?.macVersion ?? macProductVersion() ?? release
    if (version && machine) return `macOS ${version} ${machine}`
    if (version) return `macOS ${version}`
    return `macOS ${machine}`.trim()
  }

  if (system === "Windows_NT") {
    const parts = release.split(".")
    const build = Number(parts[2] ?? "")
    const label =
      parts[0] === "10" ? (Number.isFinite(build) && build >= 22000 ? "11" : "10") : release
    if (label && machine) return `Windows ${label} ${machine}`
    if (label) return `Windows ${label}`
    return `Windows ${machine}`.trim()
  }

  if (system) {
    if (release && machine) return `${system} ${release} ${machine}`
    if (release) return `${system} ${release}`
    return `${system} ${machine}`.trim()
  }

  return "Unknown"
}

// =============================================================================
// Build the 7 X-Msh-* / UA headers
// =============================================================================

/**
 * Builds the 7 X-Msh-* / UA headers kimi-cli sends on every request.
 *
 * Uses the latest kimi-cli version if the async fetch has completed,
 * otherwise falls back to the pinned constant. Call `await getKimiCliVersion()`
 * early (e.g., on session_start) to ensure the cached value is warm.
 *
 * Values mirror research/kimi-cli/src/kimi_cli/auth/oauth.py → _common_headers
 * and _device_model. Deviations cause Moonshot's backend to 403 with
 * "access_terminated_error: Kimi For Coding is currently only available for
 * Coding Agents".
 */
export function kimiHeaders(): Record<string, string> {
  const version = getCachedKimiCliVersion()
  return {
    "User-Agent": `KimiCLI/${version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": version,
    "X-Msh-Device-Name": asciiHeaderValue(os.hostname() || "unknown"),
    "X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
    "X-Msh-Device-Id": getDeviceId(),
    "X-Msh-Os-Version": asciiHeaderValue(os.version?.() || `${os.type()} ${os.release()}`),
  }
}
