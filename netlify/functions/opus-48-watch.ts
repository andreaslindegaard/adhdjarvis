type SupabaseConfig = {
  url: string;
  key: string;
};

type NotifSettings = {
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  opus48LeaderboardWatch?: boolean;
};

type PlannerRow = {
  key: string;
  payload: unknown;
};

type WatchSource = {
  id: string;
  label: string;
  pageUrl: string;
  scanUrls: string[];
};

type ScanResult = {
  id: string;
  label: string;
  pageUrl: string;
  found: boolean;
  matched?: string;
  matchedUrl?: string;
  errors: string[];
};

const DEFAULT_SUPABASE_URL = "https://wavyqvbsaoahbulkunbq.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_qs8Q-O3K-7Bn538WRHwEqA_dAHDuYZs";
const SENT_KEY = "opus48LeaderboardWatchSent";

const SOURCES: WatchSource[] = [
  {
    id: "arc-prize",
    label: "ARC Prize leaderboard",
    pageUrl: "https://arcprize.org/leaderboard",
    scanUrls: [
      "https://arcprize.org/scripts/leaderboard/data.js",
      "https://arcprize.org/leaderboard",
    ],
  },
  {
    id: "deepswe",
    label: "DeepSWE leaderboard",
    pageUrl: "https://deepswe.datacurve.ai/blog#leaderboard",
    scanUrls: ["https://deepswe.datacurve.ai/blog"],
  },
];

const MODEL_PATTERNS = [
  { label: "claude-opus-4.8", pattern: /\bclaude-opus-4-8(?:-[a-z0-9]+)?\b/ },
  { label: "opus-4.8", pattern: /\b(?:anthropic-)?opus-4-8(?:-[a-z0-9]+)?\b/ },
  { label: "claude-4.8", pattern: /\bclaude-4-8(?:-[a-z0-9]+)?\b/ },
];

function readEnv(name: string): string {
  const netlifyEnv = (globalThis as {
    Netlify?: { env?: { get?: (key: string) => string | undefined } };
  }).Netlify?.env?.get?.(name);
  if (netlifyEnv) return netlifyEnv;

  const processEnv = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.[name];
  return processEnv || "";
}

function getSupabaseConfig(): SupabaseConfig {
  return {
    url: readEnv("SUPABASE_URL") || DEFAULT_SUPABASE_URL,
    key:
      readEnv("SUPABASE_SERVICE_ROLE_KEY") ||
      readEnv("SUPABASE_ANON_KEY") ||
      readEnv("SUPABASE_PUBLISHABLE_KEY") ||
      DEFAULT_SUPABASE_KEY,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function supabaseHeaders(config: SupabaseConfig): HeadersInit {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    Accept: "application/json",
  };
}

async function fetchPlannerRows(config: SupabaseConfig, keys: string[]): Promise<Map<string, unknown>> {
  const url = new URL("/rest/v1/planner_data", config.url);
  url.searchParams.set("select", "key,payload");
  url.searchParams.set("key", `in.(${keys.join(",")})`);

  const res = await fetch(url, {
    headers: supabaseHeaders(config),
  });

  if (!res.ok) {
    throw new Error(`Supabase read failed (${res.status}): ${await res.text()}`);
  }

  const rows = (await res.json()) as PlannerRow[];
  return new Map(rows.map((row) => [row.key, row.payload]));
}

async function claimSent(config: SupabaseConfig, hits: ScanResult[]): Promise<boolean> {
  const now = new Date().toISOString();
  const url = new URL("/rest/v1/planner_data", config.url);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(config),
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      key: SENT_KEY,
      payload: {
        type: "opus48LeaderboardWatch",
        model: "Claude Opus 4.8",
        source: "netlify",
        claimedAt: now,
        hits: hits.map((hit) => ({
          id: hit.id,
          label: hit.label,
          pageUrl: hit.pageUrl,
          matched: hit.matched || "",
          matchedUrl: hit.matchedUrl || "",
        })),
      },
      updated_at: now,
    }),
  });

  if (res.status === 201 || res.status === 204) return true;
  if (res.status === 409) return false;
  throw new Error(`Supabase claim failed (${res.status}): ${await res.text()}`);
}

function decodeCommonEntities(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    )
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function normalizeForModelSearch(value: string): string {
  return decodeCommonEntities(value)
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-");
}

function findOpus48Mention(value: string): string | null {
  const normalized = normalizeForModelSearch(value);
  for (const { label, pattern } of MODEL_PATTERNS) {
    if (pattern.test(normalized)) return label;
  }
  return null;
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/javascript,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "ADHD-Jarvis-Opus-4.8-Watch/1.0 (+https://adhdjarvis.netlify.app)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function scanSource(source: WatchSource): Promise<ScanResult> {
  const errors: string[] = [];

  for (const scanUrl of source.scanUrls) {
    try {
      const text = await fetchText(scanUrl);
      const matched = findOpus48Mention(text);
      if (matched) {
        return {
          id: source.id,
          label: source.label,
          pageUrl: source.pageUrl,
          found: true,
          matched,
          matchedUrl: scanUrl,
          errors,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown_error";
      errors.push(`${scanUrl}: ${message}`);
    }
  }

  return {
    id: source.id,
    label: source.label,
    pageUrl: source.pageUrl,
    found: false,
    errors,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendTelegramMessage(token: string, chatId: string, hits: ScanResult[]): Promise<boolean> {
  const sourceLines = hits
    .map((hit) => {
      const matched = hit.matched ? ` (${escapeHtml(hit.matched)})` : "";
      return `- <a href="${escapeHtml(hit.pageUrl)}">${escapeHtml(hit.label)}</a>${matched}`;
    })
    .join("\n");

  const text = [
    "<b>Opus 4.8 watch</b>",
    "Claude Opus 4.8 ser ud til at være landet på leaderboardet.",
    "",
    sourceLines,
  ].join("\n");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
  return !!data?.ok;
}

export default async function handler(): Promise<Response> {
  const supabase = getSupabaseConfig();

  let rows: Map<string, unknown>;
  try {
    rows = await fetchPlannerRows(supabase, ["notifSettings", SENT_KEY]);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "settings_read_failed" },
      500,
    );
  }

  if (rows.has(SENT_KEY)) {
    return jsonResponse({ ok: true, skipped: "already_sent" });
  }

  const settings = (rows.get("notifSettings") || {}) as NotifSettings;
  if (settings.opus48LeaderboardWatch === false) {
    return jsonResponse({ ok: true, skipped: "watch_disabled" });
  }
  if (settings.telegramEnabled === false) {
    return jsonResponse({ ok: true, skipped: "telegram_disabled" });
  }

  const telegramToken = (settings.telegramBotToken || readEnv("TELEGRAM_BOT_TOKEN")).trim();
  const telegramChatId = (settings.telegramChatId || readEnv("TELEGRAM_CHAT_ID")).trim();
  if (!telegramToken || !telegramChatId) {
    return jsonResponse({ ok: false, error: "missing_telegram_credentials" }, 400);
  }

  const results = await Promise.all(SOURCES.map(scanSource));
  const hits = results.filter((result) => result.found);
  if (hits.length === 0) {
    return jsonResponse({
      ok: true,
      found: false,
      checkedAt: new Date().toISOString(),
      sources: results,
    });
  }

  let claimed = false;
  try {
    claimed = await claimSent(supabase, hits);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "claim_failed", hits },
      500,
    );
  }

  if (!claimed) {
    return jsonResponse({ ok: true, skipped: "already_claimed", found: true, hits });
  }

  const telegramOk = await sendTelegramMessage(telegramToken, telegramChatId, hits);
  if (!telegramOk) {
    return jsonResponse({ ok: false, error: "telegram_send_failed", hits }, 502);
  }

  return jsonResponse({
    ok: true,
    sent: true,
    checkedAt: new Date().toISOString(),
    hits,
  });
}

export const config = {
  schedule: "*/5 * * * *",
};
