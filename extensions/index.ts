/**
 * pi-ollama-usage — shows Ollama Cloud quota usage in the Pi footer status line.
 *
 * Data source: authenticated GET https://ollama.com/api/usage (Bearer API key) —
 * the same data as the ollama.com/settings dashboard:
 *   - rolling 5-hour session window  → `Ollama 5h:12.3%`
 *   - rolling 7-day weekly window    → `Wk:3.4%`
 *   - per-model request counts + 4-week activity cost (via /ollama-usage)
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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";
const PROVIDER_IDS = ["ollama-cloud", "ollama"] as const;
const STATUS_KEY = "pi-ollama-usage";
const USAGE_TIMEOUT_MS = 15_000;
const MIN_REFRESH_MS = 60_000;
const MAX_MODELS_PER_WINDOW = 64;
const HELP = "Usage: /ollama-usage [status [on|off]]";
const AUTH_HELP = "Usage: /ollama-auth";

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

interface UsageSnapshot {
  cost?: string;
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  activityModels: UsageModelActivity[];
  session: UsageWindow;
  weekly: UsageWindow;
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
          return { key: key.trim(), source: `Pi provider auth (${providerId})` };
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
  if (cloudFile) return { key: cloudFile, source: "auth.json (ollama-cloud entry)" };
  const ollamaFile = readAuthJsonEntry("ollama");
  if (ollamaFile) return { key: ollamaFile, source: "auth.json (ollama entry)" };
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
 * Resolve a credential for the usage endpoint: Bearer API key when available,
 * otherwise the local daemon's signed keypair identity.
 */
export async function resolveCredential(ctx: any): Promise<Credential | null> {
  const apiKey = await resolveApiKey(ctx);
  if (apiKey) return { kind: "api-key", key: apiKey };
  const keypair = loadOllamaKeypair();
  if (keypair) return { kind: "keypair", ...keypair };
  return null;
}

/**
 * Build the request URL + Authorization header for GET /api/usage.
 * - api-key: `Bearer <key>`
 * - keypair: mirrors ollama's cloud proxy signing — sign "<METHOD>,<uri?ts=...>"
 *   with the ed25519 identity and send "<pubkey-blob>:<base64-signature>".
 *   The signed URI must match the request URI exactly, so the ts query param is
 *   included in the URL as well.
 */
function buildAuth(credential: Credential): {
  url: string;
  authorization: string;
} {
  if (credential.kind === "api-key") {
    return { url: OLLAMA_USAGE_URL, authorization: `Bearer ${credential.key}` };
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const uri = `/api/usage?ts=${ts}`;
  const signature = cryptoSign(
    null,
    Buffer.from(`GET,${uri}`),
    credential.privateKey,
  );
  return {
    url: `${OLLAMA_USAGE_URL}?ts=${ts}`,
    authorization: `${credential.publicKey}:${signature.toString("base64")}`,
  };
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
  const existingMode = existsSync(path)
    ? statSync(path).mode & 0o777
    : 0o600;
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
    else writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
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
  if (withSource) return `API key — ${withSource.source} · ${maskKey(withSource.key)}`;
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

export function parseUsage(payload: any): UsageSnapshot {
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
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
    session: parseWindow(limits.session),
    weekly: parseWindow(limits.weekly),
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
      return parseUsage(await response.json());
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError("invalid", "Ollama usage returned malformed JSON.");
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(1))}%`;
}

function usedPercent(window: UsageWindow): number | undefined {
  return window.usageFraction === undefined
    ? undefined
    : window.usageFraction * 100;
}

/** Compact footer status: `Ollama 5h:12.3% Wk:3.4%`. */
export function renderFooterStatus(usage: UsageSnapshot): string {
  const parts: string[] = [];
  const session = usedPercent(usage.session);
  const weekly = usedPercent(usage.weekly);
  if (session !== undefined)
    parts.push(`5h:${formatPercent(usage.session.usageFraction!)}`);
  if (weekly !== undefined)
    parts.push(`Wk:${formatPercent(usage.weekly.usageFraction!)}`);
  if (parts.length === 0)
    return usage.cost === undefined ? "Ollama ok" : `Ollama $${usage.cost}`;
  return `Ollama ${parts.join(" ")}`;
}

function renderWindow(title: string, window: UsageWindow): string[] {
  const lines: string[] = [];
  const used = usedPercent(window);
  if (used !== undefined) {
    lines.push(
      `${title}: ${formatPercent(window.usageFraction!)} used · ${formatPercent(Math.max(0, 1 - window.usageFraction!))} left`,
    );
  }
  for (const model of window.models) {
    const count =
      model.requestCount === undefined
        ? ""
        : ` (${model.requestCount} requests)`;
    lines.push(`  ${model.name}${count}`);
  }
  return lines;
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
  const lines = ["Ollama Cloud usage:"];
  const sessionLines = renderWindow("Session (5h rolling)", usage.session);
  if (sessionLines.length > 0) lines.push(...sessionLines);
  const weeklyLines = renderWindow("Weekly (7d rolling)", usage.weekly);
  if (weeklyLines.length > 0) lines.push("", ...weeklyLines);
  if (usage.cost !== undefined) {
    const period =
      usage.periodType === "last_4_weeks"
        ? "last 4 weeks"
        : (usage.periodType ?? "last 4 weeks");
    const range = usage.periodStart
      ? ` (${[formatDate(usage.periodStart), usage.periodEnd ? formatDate(usage.periodEnd) : undefined].filter(Boolean).join(" – ")})`
      : "";
    lines.push("", `Activity (${period})${range}: $${usage.cost}`);
    for (const model of usage.activityModels) {
      const parts = [
        model.requestCount !== undefined
          ? `${model.requestCount} requests`
          : undefined,
        model.cost !== undefined ? `$${model.cost}` : undefined,
      ].filter(Boolean);
      lines.push(
        `  ${model.name}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
      );
    }
  }
  if (lines.length === 1)
    lines.push("No usage data was returned for this account.");
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
        const credential = await resolveCredential(ctx);
        if (!credential) {
          clearStatus(ctx);
          return;
        }
        const usage = await fetchUsage(credential, controller.signal);
        if (
          myGeneration === generation &&
          statusEnabled &&
          isCloudModel(ctx.model)
        ) {
          ctx.ui.setStatus(STATUS_KEY, renderFooterStatus(usage));
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
      "Show Ollama Cloud usage (5h session + weekly) or toggle the footer indicator",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

      // One-shot full report.
      if (parts.length === 0) {
        try {
          const credential = await resolveCredential(ctx);
          if (!credential) {
            ctx.ui.notify(
              "No Ollama Cloud identity found. Set OLLAMA_API_KEY, run /login ollama, " +
                "sign in with the Ollama app (ollama signin), or add an ollama-cloud entry " +
                "to ~/.pi/agent/auth.json.",
              "error",
            );
            return;
          }
          const usage = await fetchUsage(credential, ctx.signal);
          ctx.ui.notify(renderReport(usage), "info");
          if (statusEnabled && isCloudModel(ctx.model)) {
            ctx.ui.setStatus(STATUS_KEY, renderFooterStatus(usage));
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
        ctx.ui.notify(`Ollama Cloud credential: ${await describeCredential(ctx)}`, "info");
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
            const credential = await resolveCredential(ctx);
            if (!credential) {
              ctx.ui.notify(
                "No credential found. Set an API key below, run /login ollama, or sign in " +
                  "with the Ollama app (ollama signin).",
                "warning",
              );
              continue;
            }
            const usage = await fetchUsage(credential, ctx.signal);
            const session = usedPercent(usage.session);
            const weekly = usedPercent(usage.weekly);
            ctx.ui.notify(
              `Credential works. Usage — 5h: ${session !== undefined ? formatPercent(usage.session.usageFraction!) : "n/a"}, `
                + `weekly: ${weekly !== undefined ? formatPercent(usage.weekly.usageFraction!) : "n/a"}`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(
              error instanceof UsageError ? error.message : "Credential test failed.",
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
            const usage = await fetchUsage({ kind: "api-key", key }, ctx.signal);
            const session = usedPercent(usage.session);
            const ok = await ctx.ui.confirm(
              "Key validated",
              session !== undefined
                ? `Key works — 5h usage ${formatPercent(usage.session.usageFraction!)}. Save to ~/.pi/agent/auth.json?`
                : "Key works. Save to ~/.pi/agent/auth.json?",
            );
            if (!ok) {
              ctx.ui.notify("Key not saved.", "info");
              continue;
            }
            saveApiKeyToAuthJson(key);
            ctx.ui.notify(`API key saved to ${authJsonPath()} (mode 0600).`, "info");
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
            "Delete the ollama / ollama-cloud API key entries from ~/.pi/agent/auth.json? "
              + "OLLAMA_API_KEY and Pi provider auth are not touched.",
          );
          if (!ok) continue;
          const removed = removeStoredKeys();
          ctx.ui.notify(
            removed ? "Stored key entries removed." : "No stored key entries found in auth.json.",
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
