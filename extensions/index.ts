/**
 * pi-ollama-usage — shows Ollama Cloud quota usage in the Pi footer status line.
 *
 * Data sources, both authenticated:
 *   GET /api/balance → { included: { balance_usd, allowance_usd, period },
 *                        purchased: { balance_usd } }   — what is LEFT
 *   GET /api/usage?range=30d → totals + daily buckets     — what was spent
 *
 * The indicator shows the remaining credit from /api/balance, the same numbers
 * the ollama.com settings page renders:
 *   - included  = the plan's allowance for the current (rolling) period
 *   - purchased = top-up credit bought on top of the allowance
 *   footer → `Ollama Mo:$4.07 left` (included + purchased); /ollama-usage breaks
 *   the two pools down and adds the 30-day spend.
 *
 * No percentages: a share of the allowance says nothing about what is left to
 * spend, and with two pools (plan allowance + top-ups) any single percentage is
 * wrong. The balance also cannot be recomputed from the usage API — its quota
 * period is NOT a calendar month (it runs from the subscription date, e.g. Oct
 * 2 → Nov 2), so summing "this month's" daily buckets lands on a completely
 * different number. Ask /api/balance instead of deriving it.
 *
 * The status line is shown only while an Ollama Cloud model is active:
 *   - provider "ollama-cloud" (pi-ollama-cloud package), or
 *   - provider "ollama" with a `:cloud` model id (built-in provider).
 *
 * Credentials (in order):
 *   1. API key — Pi provider auth ("ollama-cloud" / "ollama"), OLLAMA_API_KEY env,
 *      or ~/.pi/agent/auth.json
 *   2. Fallback: signed auth with the local Ollama daemon's keypair
 *      (~/.ollama/id_ed25519) — the same identity used for cloud model requests,
 *      so no API key is required if you are signed in via the Ollama app/CLI.
 *
 * Commands:
 *   /ollama-usage            one-shot full usage report
 *   /ollama-usage status     show whether the footer indicator is on/off
 *   /ollama-usage status on  enable the footer indicator (on by default)
 *   /ollama-usage status off disable the footer indicator
 *   /ollama-auth             interactive auth TUI: inspect the active credential,
 *                            set/validate/save an API key, remove a stored key
 *
 * The indicator is a plain extension status, so pi renders it on its own line
 * under the footer and pi-open-tui on its extension-status line. It is never
 * inlined into a host TUI's own footer rows: doing that required patching
 * pi-open-tui's footer.ts, and the patch broke the TUI on every pi-open-tui
 * release that touched footer.ts.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createPrivateKey,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_API_BASE = "https://ollama.com";
const USAGE_PATH = "/api/usage";
const BALANCE_PATH = "/api/balance";
const PROVIDER_IDS = ["ollama-cloud", "ollama"] as const;
// Plain status key — pi and pi-open-tui both render it on the extension-status
// line below the footer. No `stats:` prefix: the indicator is deliberately not
// inlined into pi-open-tui's stats row (that needed a local patch of its
// footer.ts, which kept breaking on pi-open-tui releases).
const STATUS_KEY = "pi-ollama-usage";
const USAGE_TIMEOUT_MS = 15_000;
const MIN_REFRESH_MS = 60_000;
const MAX_MODELS_PER_WINDOW = 64;
const HELP = "Usage: /ollama-usage [status [on|off]]";
const AUTH_HELP = "Usage: /ollama-auth";

// ANSI SGR colors for the footer status and usage report. Status surfaces are
// ANSI-aware TUI components; wherever escapes get stripped the text just
// degrades to plain. `NO_COLOR` (any non-empty value) opts out.
const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[2m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RED = "\u001b[31m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelBreakdown {
  name: string;
  requestCount?: number;
}

interface UsageWindow {
  usageFraction?: number; // 0..1 fraction of the allowance
  models: ModelBreakdown[];
}

interface UsageModelActivity {
  name: string;
  requestCount?: number;
  cost?: string;
}

/**
 * Remaining credits from `GET /api/balance` — the account's real balance, the
 * same numbers the ollama.com settings page shows. Two pools: the plan's
 * included allowance for the current (rolling) period, and purchased top-up
 * credit that survives the period reset.
 */
interface UsageBalance {
  /** Included (plan) credit still available, US$. */
  includedLeft: number;
  /** Included allowance for the current period, US$ (when reported). */
  allowance?: number;
  periodStart?: string;
  periodEnd?: string;
  /** Purchased (top-up) credit still available, US$. */
  purchasedLeft?: number;
}

interface UsageSnapshot {
  cost?: string;
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  activityModels: UsageModelActivity[];
  monthly: UsageWindow;
  /** Remaining credits — the source of truth for the indicator. */
  balance?: UsageBalance;
  /** Spend of the queried rolling range, from its daily buckets. */
  recent?: {
    usd: number;
    requests?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
}

type UsageErrorCode = "auth" | "http" | "invalid" | "timeout" | "transport";

class UsageError extends Error {
  readonly code: UsageErrorCode;
  constructor(code: UsageErrorCode, message: string) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

function readAuthJsonEntry(providerId: string): string | null {
  try {
    const override = process.env.PI_AGENT_DIR?.trim();
    const dir = override || join(homedir(), ".pi", "agent");
    const path = join(dir, "auth.json");
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const entry = data?.[providerId];
    if (!entry || typeof entry !== "object") return null;
    // Tolerate the shapes written by pi (`key`/`apiKey`) and raw headers.
    const key =
      typeof entry.key === "string" && entry.key.trim()
        ? entry.key
        : typeof entry.apiKey === "string" && entry.apiKey.trim()
          ? entry.apiKey
          : null;
    if (key) return key.trim();
    const authorization =
      typeof entry.headers?.Authorization === "string"
        ? entry.headers.Authorization
        : "";
    return authorization.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim() || null
      : null;
  } catch {
    return null;
  }
}

function readEnvApiKey(): string | null {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key || null;
}

/**
 * Resolve an Ollama Cloud API key: pi's provider auth registry, then
 * OLLAMA_API_KEY, then ~/.pi/agent/auth.json. Returns the source label so the
 * auth TUI can show where the key came from.
 */
export async function resolveApiKeyWithSource(
  ctx: any,
): Promise<{ key: string; source: string } | null> {
  const registry = ctx?.modelRegistry;
  const modelRuntime = ctx?.modelRuntime;

  for (const providerId of PROVIDER_IDS) {
    if (registry && typeof registry.getApiKeyForProvider === "function") {
      try {
        const key = await registry.getApiKeyForProvider(providerId);
        if (typeof key === "string" && key.trim()) {
          return {
            key: key.trim(),
            source: `Pi provider auth (${providerId})`,
          };
        }
      } catch {
        // fall through
      }
    }
    if (modelRuntime && typeof modelRuntime.getAuth === "function") {
      try {
        const auth = await modelRuntime.getAuth(providerId);
        const key = extractKeyFromAuth(auth);
        if (key) return { key, source: `Pi provider auth (${providerId})` };
      } catch {
        // fall through
      }
    }
  }

  const env = readEnvApiKey();
  if (env) return { key: env, source: "OLLAMA_API_KEY environment variable" };
  const cloudFile = readAuthJsonEntry("ollama-cloud");
  if (cloudFile)
    return { key: cloudFile, source: "auth.json (ollama-cloud entry)" };
  const ollamaFile = readAuthJsonEntry("ollama");
  if (ollamaFile)
    return { key: ollamaFile, source: "auth.json (ollama entry)" };
  return null;
}

async function resolveApiKey(ctx: any): Promise<string | null> {
  return (await resolveApiKeyWithSource(ctx))?.key ?? null;
}

function extractKeyFromAuth(auth: unknown): string | null {
  if (!auth || typeof auth !== "object") return null;
  const value = auth as { auth?: { apiKey?: unknown }; apiKey?: unknown };
  const direct = value.auth?.apiKey ?? value.apiKey;
  return typeof direct === "string" && direct.trim() ? direct.trim() : null;
}

// ---------------------------------------------------------------------------
// Credentials — Bearer API key, or signed auth with ~/.ollama/id_ed25519
// (the same keypair identity the local Ollama daemon uses for cloud requests)
// ---------------------------------------------------------------------------

type Credential =
  | { kind: "api-key"; key: string }
  | { kind: "keypair"; privateKey: KeyObject; publicKey: string };

let keypairCache:
  | { privateKey: KeyObject; publicKey: string }
  | null
  | undefined;

/**
 * Load the local Ollama daemon's identity (~/.ollama/id_ed25519, openssh-key v1
 * format, unencrypted). Node's decoder does not parse OpenSSH keys, so extract
 * the raw ed25519 seed and re-wrap it in PKCS8 DER. Result is cached; null when
 * no usable key exists.
 */
function loadOllamaKeypair(): {
  privateKey: KeyObject;
  publicKey: string;
} | null {
  if (keypairCache !== undefined) return keypairCache;
  try {
    const ollamaDir = process.env.OLLAMA_HOME?.trim()
      ? join(process.env.OLLAMA_HOME.trim(), ".ollama")
      : join(homedir(), ".ollama");
    const pubPath = join(ollamaDir, "id_ed25519.pub");
    if (!existsSync(pubPath)) return (keypairCache = null);
    const publicKey =
      readFileSync(pubPath, "utf8").trim().split(/\s+/)[1] ?? "";
    if (!publicKey) return (keypairCache = null);

    const pem = readFileSync(join(ollamaDir, "id_ed25519"), "utf8");
    if (!pem.includes("OPENSSH PRIVATE KEY")) return (keypairCache = null);
    const b64 = pem
      .split("\n")
      .filter((l) => !l.startsWith("-----"))
      .join("");
    const raw = Buffer.from(b64, "base64");
    if (!raw.subarray(0, 15).toString("latin1").startsWith("openssh-key-v1")) {
      return (keypairCache = null);
    }
    let i = 15;
    const readStr = (buf: Buffer, at: number) => {
      const len = buf.readUInt32BE(at);
      return { value: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
    };
    ({ next: i } = readStr(raw, i)); // cipher name (expect "none")
    ({ next: i } = readStr(raw, i)); // kdf name
    ({ next: i } = readStr(raw, i)); // kdf options
    i += 4; // key count
    ({ next: i } = readStr(raw, i)); // public key blob
    const enc = readStr(raw, i).value; // "encrypted" section — plaintext when cipher is none
    if (enc.length < 16) return (keypairCache = null);
    let j = 8; // skip checkint1 + checkint2
    j += 4 + enc.readUInt32BE(j); // key type string
    j += 4 + 32; // ed25519 public key (32 bytes)
    const seed = enc.subarray(j + 4, j + 4 + 32); // private field = seed(32) + pub(32)
    if (seed.length !== 32) return (keypairCache = null);
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    const privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
    return (keypairCache = { privateKey, publicKey });
  } catch {
    return (keypairCache = null);
  }
}

/**
 * Collect EVERY available credential, in priority order: pi's provider auth
 * registry (per provider), OLLAMA_API_KEY, the auth.json entries, and finally
 * the signed daemon identity. The usage fetch tries each in turn on auth
 * rejection, so one dead source (e.g. the signed identity after `ollama
 * logout`) can no longer take the indicator down while a valid API key exists
 * — and vice versa.
 */
export async function resolveCredentialCandidates(
  ctx: any,
): Promise<Array<{ credential: Credential; source: string }>> {
  const out: Array<{ credential: Credential; source: string }> = [];
  const seen = new Set<string>();
  const push = (credential: Credential, source: string) => {
    const sig =
      credential.kind === "api-key"
        ? `k:${credential.key}`
        : `kp:${credential.publicKey}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ credential, source });
  };

  const registry = ctx?.modelRegistry;
  const modelRuntime = ctx?.modelRuntime;
  for (const providerId of PROVIDER_IDS) {
    if (registry && typeof registry.getApiKeyForProvider === "function") {
      try {
        const key = await registry.getApiKeyForProvider(providerId);
        if (typeof key === "string" && key.trim())
          push(
            { kind: "api-key", key: key.trim() },
            `Pi provider auth (${providerId})`,
          );
      } catch {
        // fall through
      }
    }
    if (modelRuntime && typeof modelRuntime.getAuth === "function") {
      try {
        const auth = await modelRuntime.getAuth(providerId);
        const key = extractKeyFromAuth(auth);
        if (key) push({ kind: "api-key", key }, `Pi provider auth (${providerId})`);
      } catch {
        // fall through
      }
    }
  }

  const env = readEnvApiKey();
  if (env) push({ kind: "api-key", key: env }, "OLLAMA_API_KEY environment variable");
  const cloudFile = readAuthJsonEntry("ollama-cloud");
  if (cloudFile) push({ kind: "api-key", key: cloudFile }, "auth.json (ollama-cloud entry)");
  const ollamaFile = readAuthJsonEntry("ollama");
  if (ollamaFile) push({ kind: "api-key", key: ollamaFile }, "auth.json (ollama entry)");
  const keypair = loadOllamaKeypair();
  if (keypair)
    push({ kind: "keypair", ...keypair }, "signed identity (~/.ollama/id_ed25519)");
  return out;
}

/**
 * Resolve a credential for the usage endpoint: Bearer API key when available,
 * otherwise the local daemon's signed keypair identity.
 */
export async function resolveCredential(ctx: any): Promise<Credential | null> {
  const candidates = await resolveCredentialCandidates(ctx);
  return candidates[0]?.credential ?? null;
}

/**
 * Build the request URL + Authorization header for a GET on the Ollama Cloud
 * API.
 * - api-key: `Bearer <key>`
 * - keypair: mirrors ollama's cloud proxy signing — sign "<METHOD>,<uri?ts=...>"
 *   with the ed25519 identity and send "<pubkey-blob>:<base64-signature>".
 *   The signed URI must match the request URI exactly, so the ts query param is
 *   included in the URL as well.
 */
function signedRequest(
  credential: Credential,
  path: string,
  query = "",
): {
  url: string;
  authorization: string;
} {
  if (credential.kind === "api-key") {
    return {
      url: `${OLLAMA_API_BASE}${path}${query ? `?${query}` : ""}`,
      authorization: `Bearer ${credential.key}`,
    };
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const uri = `${path}?${query ? `${query}&` : ""}ts=${ts}`;
  const signature = cryptoSign(
    null,
    Buffer.from(`GET,${uri}`),
    credential.privateKey,
  );
  return {
    url: `${OLLAMA_API_BASE}${uri}`,
    authorization: `${credential.publicKey}:${signature.toString("base64")}`,
  };
}

/**
 * Build the request URL + Authorization header for GET /api/usage.
 * range=30d: the activity figures cover the whole 30-day window —
 * the default (7d) only meters dollars for the last week.
 */
function buildAuth(credential: Credential): {
  url: string;
  authorization: string;
} {
  return signedRequest(credential, USAGE_PATH, "range=30d");
}

/** Bounded non-negative US$ amount from an API payload. */
function boundedUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Remaining credits from `GET https://ollama.com/api/balance` (documented —
 * docs.ollama.com/api/balance):
 *   { included: { balance_usd, allowance_usd, period: {from, until} },
 *     purchased: { balance_usd } }
 * `included` is the plan allowance for the current rolling period; `purchased`
 * is top-up credit bought on top of it. The period is NOT a calendar month
 * (it starts when the subscription/renewal started), which is why summing the
 * month's daily buckets can never reproduce this number.
 */
export function parseBalance(payload: any): UsageBalance | undefined {
  const included = payload?.included;
  const includedLeft = boundedUsd(included?.balance_usd);
  if (includedLeft === undefined) return undefined;
  return {
    includedLeft,
    allowance: boundedUsd(included?.allowance_usd),
    periodStart: boundedTimestamp(included?.period?.from),
    periodEnd: boundedTimestamp(included?.period?.until),
    purchasedLeft: boundedUsd(payload?.purchased?.balance_usd),
  };
}

/**
 * Fetch the remaining credit balance. Returns undefined on any failure — the
 * indicator then falls back to the spend, and /ollama-usage reports the error.
 */
async function fetchBalance(
  credential: Credential,
): Promise<UsageBalance | undefined> {
  try {
    const { url, authorization } = signedRequest(credential, BALANCE_PATH);
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "User-Agent": "pi-ollama-usage/1.3.0",
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return parseBalance(await response.json());
  } catch {
    return undefined; // balance unavailable — spend is still shown
  }
}

// ---------------------------------------------------------------------------
// Auth TUI helpers
// ---------------------------------------------------------------------------

function agentDir(): string {
  const override = process.env.PI_AGENT_DIR?.trim();
  return override || join(homedir(), ".pi", "agent");
}

function authJsonPath(): string {
  return join(agentDir(), "auth.json");
}

/** Mask a secret for display: `ok-12…wxyz` (first 6 + last 4). */
export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * Store an Ollama Cloud API key in ~/.pi/agent/auth.json under "ollama" (the
 * built-in provider). Preserves other entries; file mode tightened to 0600.
 */
export function saveApiKeyToAuthJson(key: string): void {
  const path = authJsonPath();
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    data = {}; // corrupt file: start fresh rather than failing
  }
  data["ollama"] = { type: "api_key", key };
  mkdirSync(agentDir(), { recursive: true });
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {
    mode: Math.min(existingMode, 0o600),
  });
}

/** Remove stored ollama / ollama-cloud API key entries from auth.json. */
export function removeStoredKeys(): boolean {
  const path = authJsonPath();
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) ?? {};
    let removed = false;
    for (const providerId of PROVIDER_IDS) {
      if (data[providerId] !== undefined) {
        delete data[providerId];
        removed = true;
      }
    }
    if (Object.keys(data).length === 0) rmSync(path);
    else
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
    return removed;
  } catch {
    return false;
  }
}

/**
 * Describe the active credential for the auth TUI, e.g.
 * `API key (auth.json ollama entry) · ok-12…wxyz` or `Signed keypair · AAAA…B1`.
 */
export async function describeCredential(ctx: any): Promise<string> {
  const withSource = await resolveApiKeyWithSource(ctx);
  if (withSource)
    return `API key — ${withSource.source} · ${maskKey(withSource.key)}`;
  const keypair = loadOllamaKeypair();
  if (keypair) {
    return `Signed keypair (~/.ollama/id_ed25519) · ${keypair.publicKey.slice(0, 8)}…${keypair.publicKey.slice(-4)}`;
  }
  return "None — no API key and no signed Ollama identity found";
}

// ---------------------------------------------------------------------------
// Cloud-model detection
// ---------------------------------------------------------------------------

/** True when the active session model is an Ollama Cloud model. */
function isCloudModel(model: unknown): boolean {
  const m = model as { provider?: string; id?: string } | undefined;
  if (!m?.provider) return false;
  if (m.provider === "ollama-cloud") return true;
  if (m.provider === "ollama") {
    const id = (m.id ?? "").toLowerCase();
    return id.endsWith(":cloud") || id.includes("-cloud");
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

function boundedFraction(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    return undefined;
  }
  // API reports 0..1; tolerate percent-style values defensively.
  return value <= 1 ? value : value / 100;
}

function boundedModels(value: unknown): ModelBreakdown[] {
  if (!Array.isArray(value)) return [];
  const models: ModelBreakdown[] = [];
  for (const entry of value.slice(0, MAX_MODELS_PER_WINDOW)) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const requestCount =
      typeof entry?.request_count === "number" &&
      Number.isSafeInteger(entry.request_count) &&
      entry.request_count >= 0
        ? entry.request_count
        : undefined;
    models.push({ name, requestCount });
  }
  return models;
}

function parseWindow(value: any): UsageWindow {
  const usageFraction = boundedFraction(value?.usage);
  const models = boundedModels(value?.models);
  return { usageFraction, models };
}

function parseActivityModels(value: unknown): UsageModelActivity[] {
  if (!Array.isArray(value)) return [];
  const models: UsageModelActivity[] = [];
  for (const entry of value.slice(0, MAX_MODELS_PER_WINDOW)) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    models.push({
      name,
      requestCount:
        typeof entry?.request_count === "number" &&
        Number.isSafeInteger(entry.request_count) &&
        entry.request_count >= 0
          ? entry.request_count
          : undefined,
      cost:
        typeof entry?.cost === "string" && /^[0-9.]{1,20}$/.test(entry.cost)
          ? entry.cost
          : undefined,
    });
  }
  return models;
}

function boundedTimestamp(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

export function parseUsage(payload: any, balance?: UsageBalance): UsageSnapshot {
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  // 2026-10 shape: { range, from, until, totals: {usage_usd, request_count, ...},
  // buckets: [...] } — no limits, no per-model breakdown; dollar metering is
  // only kept for recent bucket days, and the range=30d totals may omit
  // usage_usd entirely (then the buckets carry it for recent days).
  if (root.totals !== undefined || Array.isArray(root.buckets)) {
    const totals = root.totals ?? {};
    const buckets: any[] = Array.isArray(root.buckets) ? root.buckets : [];
    const bucketSum = (key: string) =>
      buckets.reduce(
        (acc: number, b: any) =>
          acc + (typeof b?.[key] === "number" ? b[key] : 0),
        0,
      );
    const dollars =
      typeof totals.usage_usd === "number" && totals.usage_usd > 0
        ? totals.usage_usd
        : bucketSum("usage_usd");
    // Prefer the reported range totals; the buckets cover the same window.
    const ranged = (key: string) =>
      typeof totals[key] === "number" ? totals[key] : bucketSum(key);

    return {
      cost: dollars > 0 ? dollars.toFixed(2) : undefined,
      periodType: root.range,
      periodStart: boundedTimestamp(root.from),
      periodEnd: boundedTimestamp(root.until),
      // Per-model breakdown is gone from this shape; the range totals carry the
      // request count, so no activity rows are emitted (nothing to attribute).
      activityModels: [],
      monthly: { models: [] },
      balance,
      recent: {
        usd: dollars,
        requests: ranged("request_count"),
        inputTokens: ranged("input_tokens"),
        cachedInputTokens: ranged("cached_input_tokens"),
        outputTokens: ranged("output_tokens"),
      },
    };
  }
  const limits = root.limits ?? {};
  const activity = root.activity ?? {};

  return {
    cost:
      typeof activity.cost === "string" && /^[0-9.]{1,20}$/.test(activity.cost)
        ? activity.cost
        : undefined,
    periodType:
      typeof activity.period?.type === "string"
        ? activity.period.type
        : undefined,
    periodStart: boundedTimestamp(activity.period?.starting_at),
    periodEnd: boundedTimestamp(activity.period?.ending_at),
    activityModels: parseActivityModels(activity.models),
    monthly: parseWindow(limits.monthly),
    balance,
  };
}

export async function fetchUsage(
  credential: Credential,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, USAGE_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();

  // Balance (what is left) and usage (what was spent) are independent reads —
  // run them concurrently so a refresh costs one round trip, not two.
  const balancePromise = fetchBalance(credential);

  try {
    const { url, authorization } = buildAuth(credential);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "User-Agent": "pi-ollama-usage/1.0.0",
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timedOut)
        throw new UsageError("timeout", "Ollama usage request timed out.");
      throw new UsageError(
        "transport",
        "Ollama usage request failed (network error).",
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new UsageError(
          "auth",
          credential.kind === "api-key"
            ? "Ollama Cloud rejected the API key. Check OLLAMA_API_KEY or ~/.pi/agent/auth.json."
            : "Ollama Cloud rejected the signed identity. Run `ollama signin` or set OLLAMA_API_KEY.",
        );
      }
      if (response.status === 404) {
        throw new UsageError(
          "http",
          "The Ollama usage endpoint is unavailable (404). The API contract may have changed.",
        );
      }
      if (response.status === 429) {
        throw new UsageError(
          "http",
          "Ollama usage is rate limited. Try again later.",
        );
      }
      throw new UsageError(
        "http",
        `Ollama usage request failed with status ${response.status}.`,
      );
    }
    try {
      const payload = await response.json();
      // A balance failure must not hide the usage report (and vice versa).
      return parseUsage(payload, await balancePromise);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError("invalid", "Ollama usage returned malformed JSON.");
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Fetch usage trying EVERY available credential in priority order. Only
 * credential rejections (401/403) advance to the next candidate — transport,
 * timeout, and HTTP errors are not credential-specific. Returns the usage plus
 * the source label that worked, for diagnostics.
 */
export async function fetchUsageWithFallback(
  ctx: any,
  signal?: AbortSignal,
): Promise<{ usage: UsageSnapshot; source: string }> {
  const candidates = await resolveCredentialCandidates(ctx);
  if (candidates.length === 0) {
    throw new UsageError(
      "auth",
      "No Ollama Cloud credential found. Set OLLAMA_API_KEY, run /login ollama, sign in with " +
        "the Ollama app (ollama signin), or add an ollama-cloud entry to ~/.pi/agent/auth.json.",
    );
  }
  for (const { credential, source } of candidates) {
    try {
      return { usage: await fetchUsage(credential, signal), source };
    } catch (error) {
      if (error instanceof UsageError && error.code === "auth") {
        continue; // rejected credential → try the next source
      }
      throw error;
    }
  }
  throw new UsageError(
    "auth",
    `Ollama Cloud rejected every credential (${candidates.length} tried: ${candidates
      .map((c) => c.source)
      .join(", ")}). Run \`ollama signin\` or update the API key via /ollama-auth.`,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatUsd(amount: number): string {
  return `$${Math.max(0, amount).toFixed(2)}`;
}

/** Compact token count: 1234 → `1.2k`, 74214255 → `74.2M`. */
function formatTokens(count: number): string {
  if (count >= 1e9) return `${Number((count / 1e9).toFixed(1))}B`;
  if (count >= 1e6) return `${Number((count / 1e6).toFixed(1))}M`;
  if (count >= 1e3) return `${Number((count / 1e3).toFixed(1))}k`;
  return `${count}`;
}

function colored(text: string, ...codes: string[]): string {
  if (process.env.NO_COLOR?.trim()) return text;
  return `${codes.join("")}${text}${ANSI_RESET}`;
}

/**
 * Credit that is left, as reported by /api/balance: included (plan) credit plus
 * purchased top-up credit. Undefined when the balance call failed.
 */
export interface CreditsLeft {
  /** Included + purchased, US$. */
  left: number;
  includedLeft?: number;
  purchasedLeft?: number;
  allowance?: number;
  periodStart?: string;
  periodEnd?: string;
}

/**
 * SGR code for the balance: green while the included allowance is healthy,
 * yellow once the plan allowance is spent (running on purchased credit), red
 * when less than 10% of the allowance — or nothing at all — is left.
 */
function creditsColor(credit: CreditsLeft): string {
  if (credit.left <= 0) return ANSI_RED;
  if (credit.includedLeft !== undefined && credit.includedLeft <= 0)
    return ANSI_YELLOW;
  const allowance = credit.allowance;
  if (allowance && allowance > 0 && credit.includedLeft !== undefined) {
    const share = credit.includedLeft / allowance;
    if (share <= 0.1) return ANSI_RED;
    if (share < 0.3) return ANSI_YELLOW;
  }
  return ANSI_GREEN;
}

/** `$4.10 left`, colored by how much credit remains. */
function creditsLeftLabel(credit: CreditsLeft): string {
  return colored(`${formatUsd(credit.left)} left`, creditsColor(credit));
}

export function creditsLeft(usage: UsageSnapshot): CreditsLeft | undefined {
  const balance = usage.balance;
  if (!balance) return undefined;
  const purchasedLeft = balance.purchasedLeft ?? 0;
  return {
    left: balance.includedLeft + purchasedLeft,
    includedLeft: balance.includedLeft,
    purchasedLeft: balance.purchasedLeft,
    allowance: balance.allowance,
    periodStart: balance.periodStart,
    periodEnd: balance.periodEnd,
  };
}

/**
 * Compact footer status: `Mo:$4.10 left` — the remaining usage credit
 * (included + purchased) from /api/balance. No percentage: a share of some
 * allowance says nothing about what is actually left to spend, and the two
 * pools (plan allowance vs top-up) make any single percentage wrong. When the
 * balance is unavailable, the recent spend is shown instead — never a
 * percentage, and never a balance derived from a billing window the API does
 * not report. Empty string when there is nothing to show either way.
 */
export function renderFooterStatus(usage: UsageSnapshot): string {
  const credit = creditsLeft(usage);
  if (credit) {
    return `${colored("Mo:", ANSI_DIM)}${creditsLeftLabel(credit)}`;
  }
  const usd = usage.recent?.usd;
  if (usd === undefined) return "";
  return `${colored("Mo:", ANSI_DIM)}${colored(`${formatUsd(usd)} used`, ANSI_DIM)}`;
}

function formatDate(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Full multi-line report for `/ollama-usage`. */
export function renderReport(usage: UsageSnapshot): string {
  const lines = [colored("Ollama Cloud usage:", ANSI_DIM)];
  // Balance first — it is the account's real remaining credit, including
  // purchased top-ups, and it is the only number the quota actually resets.
  const credit = creditsLeft(usage);
  if (credit) {
    const pools: string[] = [];
    if (credit.includedLeft !== undefined) {
      pools.push(
        credit.allowance !== undefined
          ? `included ${formatUsd(credit.includedLeft)} of ${formatUsd(credit.allowance)}`
          : `included ${formatUsd(credit.includedLeft)}`,
      );
    }
    if (credit.purchasedLeft !== undefined) {
      pools.push(`purchased ${formatUsd(credit.purchasedLeft)}`);
    }
    const period = credit.periodStart
      ? ` (${[formatDate(credit.periodStart), credit.periodEnd ? formatDate(credit.periodEnd) : undefined]
          .filter(Boolean)
          .join(" – ")})`
      : "";
    lines.push(
      `${colored("Balance", ANSI_DIM)}: ${creditsLeftLabel(credit)}${
        pools.length > 0 ? ` — ${pools.join(" · ")}` : ""
      }${period}`,
    );
  } else {
    lines.push(
      colored("Balance: unavailable (the /api/balance call failed).", ANSI_YELLOW),
    );
  }
  const recent = usage.recent;
  if (recent) {
    const tokens =
      recent.inputTokens === undefined
        ? ""
        : ` · in ${formatTokens(recent.inputTokens)}` +
          (recent.cachedInputTokens
            ? ` (${formatTokens(recent.cachedInputTokens)} cached)`
            : "") +
          (recent.outputTokens === undefined
            ? ""
            : ` · out ${formatTokens(recent.outputTokens)}`);
    lines.push(
      `${colored(`Spend (${usage.periodType ?? "30d"})`, ANSI_DIM)}: ${colored(
        formatUsd(recent.usd),
        ANSI_YELLOW,
      )}${recent.requests === undefined ? "" : ` · ${recent.requests} requests`}${tokens}`,
    );
  }
  if (usage.cost !== undefined && usage.activityModels.length > 0) {
    const period =
      usage.periodType === "last_4_weeks"
        ? "last 4 weeks"
        : (usage.periodType ?? "last 4 weeks");
    const range = usage.periodStart
      ? ` (${[formatDate(usage.periodStart), usage.periodEnd ? formatDate(usage.periodEnd) : undefined].filter(Boolean).join(" – ")})`
      : "";
    lines.push(
      "",
      `Activity (${period})${range}: ${colored(`$${usage.cost}`, ANSI_YELLOW)}`,
    );
    for (const model of usage.activityModels) {
      const parts = [
        model.requestCount === undefined
          ? undefined
          : `${model.requestCount} requests`,
        model.cost === undefined
          ? undefined
          : colored(`$${model.cost}`, ANSI_YELLOW),
      ].filter(Boolean);
      lines.push(
        `  ${model.name}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
      );
    }
  }
  if (lines.length === 1)
    lines.push(
      colored("No usage data was returned for this account.", ANSI_YELLOW),
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let statusEnabled = true; // on by default
  let lastRefreshAt = 0;
  let inFlight: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let generation = 0;

  const clearStatus = (ctx: any) => {
    try {
      ctx?.ui?.setStatus(STATUS_KEY, undefined);
    } catch {
      // cosmetic only
    }
  };

  const refresh = async (ctx: any, force: boolean): Promise<void> => {
    if (!statusEnabled || !isCloudModel(ctx?.model)) {
      clearStatus(ctx);
      return;
    }
    const now = Date.now();
    if (!force && lastRefreshAt > 0 && now - lastRefreshAt < MIN_REFRESH_MS)
      return;
    if (pending) return pending;

    const myGeneration = ++generation;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    const run: Promise<void> = (async () => {
      try {
        const { usage } = await fetchUsageWithFallback(ctx, controller.signal);
        if (
          myGeneration === generation &&
          statusEnabled &&
          isCloudModel(ctx.model)
        ) {
          const text = renderFooterStatus(usage);
          if (text) ctx.ui.setStatus(STATUS_KEY, text);
          else clearStatus(ctx);
          lastRefreshAt = Date.now();
        }
      } catch {
        // Footer is cosmetic — hide it on errors rather than nagging.
        if (myGeneration === generation) clearStatus(ctx);
      } finally {
        if (inFlight === controller) inFlight = undefined;
        // Clear the dedup slot only if no newer refresh has replaced it.
        if (myGeneration === generation) pending = undefined;
      }
    })();
    pending = run;
    return run;
  };

  pi.registerCommand("ollama-usage", {
    description:
      "Show Ollama Cloud usage (monthly limit) or toggle the footer indicator",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

      // One-shot full report.
      if (parts.length === 0) {
        try {
          const { usage, source } = await fetchUsageWithFallback(ctx, ctx.signal);
          ctx.ui.notify(renderReport(usage) + `\n(via ${source})`, "info");
          if (statusEnabled && isCloudModel(ctx.model)) {
            const text = renderFooterStatus(usage);
            if (text) ctx.ui.setStatus(STATUS_KEY, text);
            else clearStatus(ctx);
            lastRefreshAt = Date.now();
          }
        } catch (error) {
          ctx.ui.notify(
            error instanceof UsageError
              ? error.message
              : "Ollama usage request failed.",
            "error",
          );
        }
        return;
      }

      // status subcommand.
      if (
        parts[0] !== "status" ||
        parts.length > 2 ||
        (parts[1] && !["on", "off"].includes(parts[1]))
      ) {
        ctx.ui.notify(HELP, "error");
        return;
      }
      if (!parts[1]) {
        ctx.ui.notify(
          `Ollama usage footer indicator is ${statusEnabled ? "on" : "off"}.`,
          "info",
        );
        return;
      }
      if (parts[1] === "off") {
        statusEnabled = false;
        inFlight?.abort();
        clearStatus(ctx);
        ctx.ui.notify("Ollama usage footer indicator is off.", "info");
        return;
      }
      statusEnabled = true;
      lastRefreshAt = 0;
      if (!isCloudModel(ctx.model)) {
        clearStatus(ctx);
        ctx.ui.notify(
          "Ollama usage footer indicator is on. Select an Ollama Cloud model to show it.",
          "info",
        );
        return;
      }
      await refresh(ctx, true);
      ctx.ui.notify("Ollama usage footer indicator is on.", "info");
    },
  });

  pi.registerCommand("ollama-auth", {
    description:
      "Manage Ollama Cloud auth: view the active credential, set/validate an API key, remove a stored key",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Non-interactive modes: report status as text instead of dialogs.
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `Ollama Cloud credential: ${await describeCredential(ctx)}`,
          "info",
        );
        return;
      }

      while (true) {
        const current = await describeCredential(ctx);
        const choice = await ctx.ui.select(
          `Ollama Cloud auth — current: ${current}`,
          [
            "Test current credential",
            "Set / update API key",
            "Remove stored key (auth.json)",
            "Done",
          ],
        );
        if (choice === undefined || choice === "Done") return;

        if (choice === "Test current credential") {
          try {
            const { usage, source } = await fetchUsageWithFallback(ctx, ctx.signal);
            const credit = creditsLeft(usage);
            ctx.ui.notify(
              `Credential works via ${source}. Credit left: ${
                credit ? formatUsd(credit.left) : "unavailable"
              }`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(
              error instanceof UsageError
                ? error.message
                : "Credential test failed.",
              "error",
            );
          }
          continue;
        }

        if (choice === "Set / update API key") {
          const key = (
            await ctx.ui.input(
              "Ollama Cloud API key (created at ollama.com/settings/keys)",
              "paste API key",
            )
          )?.trim();
          if (!key) continue;
          ctx.ui.notify("Validating key against ollama.com…", "info");
          try {
            const usage = await fetchUsage(
              { kind: "api-key", key },
              ctx.signal,
            );
            const credit = creditsLeft(usage);
            const ok = await ctx.ui.confirm(
              "Key validated",
              credit
                ? `Key works — ${formatUsd(credit.left)} credit left. Save to ~/.pi/agent/auth.json?`
                : "Key works. Save to ~/.pi/agent/auth.json?",
            );
            if (!ok) {
              ctx.ui.notify("Key not saved.", "info");
              continue;
            }
            saveApiKeyToAuthJson(key);
            ctx.ui.notify(
              `API key saved to ${authJsonPath()} (mode 0600).`,
              "info",
            );
            lastRefreshAt = 0;
            await refresh(ctx, true);
          } catch (error) {
            ctx.ui.notify(
              error instanceof UsageError
                ? `Key rejected: ${error.message}`
                : "Key validation failed.",
              "error",
            );
          }
          continue;
        }

        if (choice === "Remove stored key (auth.json)") {
          const ok = await ctx.ui.confirm(
            "Remove stored key",
            "Delete the ollama / ollama-cloud API key entries from ~/.pi/agent/auth.json? " +
              "OLLAMA_API_KEY and Pi provider auth are not touched.",
          );
          if (!ok) continue;
          const removed = removeStoredKeys();
          ctx.ui.notify(
            removed
              ? "Stored key entries removed."
              : "No stored key entries found in auth.json.",
            removed ? "info" : "warning",
          );
          lastRefreshAt = 0;
          await refresh(ctx, true);
        }
      }
    },
  });

  pi.on("session_start", (_event: unknown, ctx: any) => {
    void refresh(ctx, true).catch(() => undefined);
  });

  pi.on("model_select", (_event: unknown, ctx: any) => {
    void refresh(ctx, true).catch(() => undefined);
  });

  pi.on("turn_end", (_event: unknown, ctx: any) => {
    // Rate-limited to once per minute inside refresh().
    void refresh(ctx, false).catch(() => undefined);
  });

  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    void refresh(ctx, false).catch(() => undefined);
  });

  pi.on("session_shutdown", (_event: unknown, ctx: any) => {
    inFlight?.abort();
    clearStatus(ctx);
  });
}
