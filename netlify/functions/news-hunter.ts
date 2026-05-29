type SupabaseConfig = {
  url: string;
  key: string;
};

type NotifSettings = {
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  newsHunterEnabled?: boolean;
  newsHunterItemsText?: string;
  newsHunterItems?: unknown[];
  newsGoallyEnabled?: boolean;
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

type WatchTarget = {
  id: string;
  title: string;
  message: string;
  sentKey: string;
  legacySentKeys?: string[];
  requestPatterns: RegExp[];
  sources: WatchSource[];
  patterns: { label: string; pattern: RegExp }[];
};

type SourceScanResult = {
  targetId: string;
  sourceId: string;
  label: string;
  pageUrl: string;
  found: boolean;
  matched?: string;
  matchedUrl?: string;
  errors: string[];
};

type WatchHit = SourceScanResult & {
  title: string;
  message: string;
};

type TargetScanResult = {
  targetId: string;
  title: string;
  found: boolean;
  hits: WatchHit[];
  sources: SourceScanResult[];
};

const DEFAULT_SUPABASE_URL = "https://wavyqvbsaoahbulkunbq.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_qs8Q-O3K-7Bn538WRHwEqA_dAHDuYZs";
const DEFAULT_NEWS_HUNTER_ITEMS = [
  "Claude Opus 4.8 on ARC Prize leaderboard and DeepSWE leaderboard",
];

const WATCH_TARGETS: WatchTarget[] = [
  {
    id: "opus-48-leaderboards",
    title: "Claude Opus 4.8",
    message: "Claude Opus 4.8 ser ud til at være landet på leaderboardet.",
    sentKey: "newsHunterSent:opus-48-leaderboards",
    legacySentKeys: ["newsGoallySent:opus-48-leaderboards", "opus48LeaderboardWatchSent"],
    requestPatterns: [
      /\bclaude-opus-4-8\b/,
      /\bopus-4-8\b/,
      /\bclaude-4-8\b/,
    ],
    sources: [
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
    ],
    patterns: [
      { label: "claude-opus-4.8", pattern: /\bclaude-opus-4-8(?:-[a-z0-9]+)?\b/ },
      { label: "opus-4.8", pattern: /\b(?:anthropic-)?opus-4-8(?:-[a-z0-9]+)?\b/ },
      { label: "claude-4.8", pattern: /\bclaude-4-8(?:-[a-z0-9]+)?\b/ },
    ],
  },
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

function getSentKeys(target: WatchTarget): string[] {
  return [target.sentKey, ...(target.legacySentKeys || [])];
}

function isTargetAlreadySent(rows: Map<string, unknown>, target: WatchTarget): boolean {
  return getSentKeys(target).some((key) => rows.has(key));
}

async function claimSent(config: SupabaseConfig, target: WatchTarget, hits: WatchHit[]): Promise<boolean> {
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
      key: target.sentKey,
      payload: {
        type: "newsHunter",
        targetId: target.id,
        title: target.title,
        source: "netlify",
        claimedAt: now,
        hits: hits.map((hit) => ({
          sourceId: hit.sourceId,
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

function normalizeForSearch(value: string): string {
  return decodeCommonEntities(value)
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-");
}

function findTargetMention(target: WatchTarget, value: string): string | null {
  const normalized = normalizeForSearch(value);
  for (const { label, pattern } of target.patterns) {
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
        "User-Agent": "ADHD-Jarvis-News-Hunter/1.0 (+https://adhdjarvis.netlify.app)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function scanSource(target: WatchTarget, source: WatchSource): Promise<SourceScanResult> {
  const errors: string[] = [];

  for (const scanUrl of source.scanUrls) {
    try {
      const text = await fetchText(scanUrl);
      const matched = findTargetMention(target, text);
      if (matched) {
        return {
          targetId: target.id,
          sourceId: source.id,
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
    targetId: target.id,
    sourceId: source.id,
    label: source.label,
    pageUrl: source.pageUrl,
    found: false,
    errors,
  };
}

async function scanTarget(target: WatchTarget): Promise<TargetScanResult> {
  const sources = await Promise.all(target.sources.map((source) => scanSource(target, source)));
  const hits = sources
    .filter((source) => source.found)
    .map((source) => ({
      ...source,
      title: target.title,
      message: target.message,
    }));

  return {
    targetId: target.id,
    title: target.title,
    found: hits.length > 0,
    hits,
    sources,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendTelegramMessage(token: string, chatId: string, hitGroups: TargetScanResult[]): Promise<boolean> {
  const sections = hitGroups
    .map((group) => {
      const lines = group.hits
        .map((hit) => {
          const matched = hit.matched ? ` (${escapeHtml(hit.matched)})` : "";
          return `- <a href="${escapeHtml(hit.pageUrl)}">${escapeHtml(hit.label)}</a>${matched}`;
        })
        .join("\n");
      return [`<b>${escapeHtml(group.title)}</b>`, escapeHtml(group.hits[0]?.message || ""), lines].join("\n");
    })
    .join("\n\n");

  const text = ["<b>News Hunter</b>", sections].join("\n\n");

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

function parseNewsHunterItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getNewsHunterItems(settings: NotifSettings): string[] {
  if (typeof settings.newsHunterItemsText === "string") {
    return parseNewsHunterItems(settings.newsHunterItemsText);
  }
  if (Array.isArray(settings.newsHunterItems)) {
    return settings.newsHunterItems.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return [...DEFAULT_NEWS_HUNTER_ITEMS];
}

function isNewsHunterEnabled(settings: NotifSettings): boolean {
  if (typeof settings.newsHunterEnabled === "boolean") return settings.newsHunterEnabled;
  if (typeof settings.newsGoallyEnabled === "boolean") return settings.newsGoallyEnabled;
  if (typeof settings.opus48LeaderboardWatch === "boolean") return settings.opus48LeaderboardWatch;
  return true;
}

function isTargetRequested(target: WatchTarget, items: string[]): boolean {
  return items.some((item) => {
    const normalized = normalizeForSearch(item);
    return target.requestPatterns.some((pattern) => pattern.test(normalized));
  });
}

export default async function handler(): Promise<Response> {
  const supabase = getSupabaseConfig();
  const sentKeys = WATCH_TARGETS.flatMap(getSentKeys);

  let rows: Map<string, unknown>;
  try {
    rows = await fetchPlannerRows(supabase, ["notifSettings", ...sentKeys]);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "settings_read_failed" },
      500,
    );
  }

  const settings = (rows.get("notifSettings") || {}) as NotifSettings;
  if (!isNewsHunterEnabled(settings)) {
    return jsonResponse({ ok: true, skipped: "news_hunter_disabled" });
  }
  if (settings.telegramEnabled === false) {
    return jsonResponse({ ok: true, skipped: "telegram_disabled" });
  }

  const telegramToken = (settings.telegramBotToken || readEnv("TELEGRAM_BOT_TOKEN")).trim();
  const telegramChatId = (settings.telegramChatId || readEnv("TELEGRAM_CHAT_ID")).trim();
  if (!telegramToken || !telegramChatId) {
    return jsonResponse({ ok: false, error: "missing_telegram_credentials" }, 400);
  }

  const newsHunterItems = getNewsHunterItems(settings);
  if (newsHunterItems.length === 0) {
    return jsonResponse({ ok: true, skipped: "no_news_hunter_items" });
  }

  const activeTargets = WATCH_TARGETS.filter((target) =>
    !isTargetAlreadySent(rows, target) && isTargetRequested(target, newsHunterItems)
  );
  if (activeTargets.length === 0) {
    return jsonResponse({ ok: true, skipped: "no_active_supported_targets" });
  }

  const results = await Promise.all(activeTargets.map(scanTarget));
  const foundGroups = results.filter((result) => result.found);
  if (foundGroups.length === 0) {
    return jsonResponse({
      ok: true,
      found: false,
      checkedAt: new Date().toISOString(),
      targets: results,
    });
  }

  const claimedGroups: TargetScanResult[] = [];
  for (const group of foundGroups) {
    const target = WATCH_TARGETS.find((candidate) => candidate.id === group.targetId);
    if (!target) continue;

    try {
      const claimed = await claimSent(supabase, target, group.hits);
      if (claimed) claimedGroups.push(group);
    } catch (err) {
      return jsonResponse(
        { ok: false, error: err instanceof Error ? err.message : "claim_failed", targetId: group.targetId },
        500,
      );
    }
  }

  if (claimedGroups.length === 0) {
    return jsonResponse({ ok: true, skipped: "already_claimed", found: true, targets: foundGroups });
  }

  const telegramOk = await sendTelegramMessage(telegramToken, telegramChatId, claimedGroups);
  if (!telegramOk) {
    return jsonResponse({ ok: false, error: "telegram_send_failed", targets: claimedGroups }, 502);
  }

  return jsonResponse({
    ok: true,
    sent: true,
    checkedAt: new Date().toISOString(),
    targets: claimedGroups,
  });
}

export const config = {
  schedule: "*/5 * * * *",
};
