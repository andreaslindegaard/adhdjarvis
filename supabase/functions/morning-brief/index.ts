/**
 * Scheduled morning briefing for ADHD Jarvis.
 *
 * Deploy: `supabase functions deploy morning-brief`
 * Secrets: `CRON_SECRET` (you choose; same value in cron Authorization header)
 *          Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY automatically.
 *
 * Schedule (Supabase Dashboard → Edge Functions → morning-brief → Schedules):
 *   cron: * * * * * (every minute). For every 2 minutes, use the dashboard or a 5-field cron with a step on minutes (avoid writing star-slash in comments).
 *
 * Invoke manually (replace URL and secrets):
 *   curl -i -X POST "https://<project-ref>.supabase.co/functions/v1/morning-brief" \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json"
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type NotifSettings = {
  morningBriefing?: boolean;
  morningTime?: string;
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  timeZone?: string;
};

function calendarDateInTimeZone(timeZone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

function clockInTimeZone(timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { hour, minute };
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function sortNotesByTime(dayNotes: Note[]): Note[] {
  return [...dayNotes].sort((a, b) => {
    const timeA = a.time || "99:99";
    const timeB = b.time || "99:99";
    return timeA.localeCompare(timeB);
  });
}

type Recurring = {
  id: string;
  text: string;
  time?: string;
  startDate: string;
  doneDate?: string | null;
  frequency?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  leadTime?: number | null;
  isEvent?: boolean;
};

type Note = {
  id: string;
  text: string;
  done?: boolean;
  time?: string;
  smartList?: string;
  listItems?: { done?: boolean; text?: string }[];
  isRecurring?: boolean;
};

function getRecurringForDate(
  recurring: Recurring[],
  forDate: string,
  todayKey: string,
): Note[] {
  const d = parseDateKey(forDate);
  return recurring
    .filter((r) => {
      if (forDate < r.startDate) return false;
      if (r.doneDate === forDate) return false;

      const freq = r.frequency || "daily";
      if (freq === "daily") {
        return forDate === todayKey || forDate === r.startDate;
      }
      if (freq === "biweekly") {
        if (d.getUTCDay() !== r.dayOfWeek) return false;
        const start = parseDateKey(r.startDate);
        const diffMs = d.getTime() - start.getTime();
        const diffDays = Math.round(diffMs / 86400000);
        const diffWeeks = Math.round(diffDays / 7);
        return diffWeeks % 2 === 0;
      }
      if (freq === "weekly") return d.getUTCDay() === r.dayOfWeek;
      if (freq === "monthly") return d.getUTCDate() === r.dayOfMonth;
      if (freq === "yearly") {
        return d.getUTCMonth() === r.month && d.getUTCDate() === r.dayOfMonth;
      }
      return false;
    })
    .map((r) => ({
      id: `recurring-${r.id}-${forDate}`,
      recurringId: r.id,
      text: r.text,
      done: false,
      time: r.time || "",
      isRecurring: true,
      frequency: r.frequency || "daily",
      leadTime: r.leadTime ?? null,
      isEvent: r.isEvent || false,
    }));
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/g, "").trim();
}

function buildMorningBriefing(
  notes: Record<string, Note[]>,
  recurring: Recurring[],
  todayKey: string,
): string | null {
  const dayRaw = notes[todayKey] || [];
  const smartTodoNotes = dayRaw.filter((n) => n.smartList === "todo");
  const smartShopNotes = dayRaw.filter((n) => n.smartList === "shopping");

  const regularNotes = sortNotesByTime(
    dayRaw.filter((n) => !n.smartList && !n.done),
  );
  const recurringNotes = getRecurringForDate(recurring, todayKey, todayKey).filter(
    (n) => !n.done,
  );
  const allNotes = sortNotesByTime([...regularNotes, ...recurringNotes]);

  const todoBlocks: string[] = [];
  for (const n of smartTodoNotes) {
    const items = (n.listItems || []).filter(
      (li) => !li.done && (li.text || "").trim(),
    );
    if (!items.length) continue;
    const lines: string[] = [];
    if ((n.text || "").trim()) {
      lines.push(`<b>${stripUrls(n.text || "")}</b>`);
    }
    for (const li of items) {
      const cleanText = stripUrls((li.text || "").trim());
      lines.push(`  - ${cleanText}`);
    }
    todoBlocks.push(lines.join("\n"));
  }

  const shopBlocks: string[] = [];
  for (const n of smartShopNotes) {
    const items = (n.listItems || []).filter(
      (li) => !li.done && (li.text || "").trim(),
    );
    if (!items.length) continue;
    const lines: string[] = [];
    if ((n.text || "").trim()) {
      lines.push(`<b>${stripUrls(n.text || "")}</b>`);
    }
    for (const li of items) {
      const cleanText = stripUrls((li.text || "").trim());
      lines.push(`  - ${cleanText}`);
    }
    shopBlocks.push(lines.join("\n"));
  }

  const hasTodo = todoBlocks.length > 0;
  const hasShop = shopBlocks.length > 0;

  if (allNotes.length === 0 && !hasTodo && !hasShop) return null;

  const todayDate = parseDateKey(todayKey);
  const dayName = WEEKDAYS[todayDate.getUTCDay()];
  const monthName = MONTHS[todayDate.getUTCMonth()];
  const dayNum = todayDate.getUTCDate();

  let msg = `<b>Good morning, sir.</b>\n`;
  msg += `<i>Your ${dayName} briefing &mdash; ${monthName} ${dayNum}</i>\n\n`;

  const timed = allNotes.filter((n) => n.time);
  const untimed = allNotes.filter((n) => !n.time);

  if (timed.length > 0) {
    msg += `<b>Today\u2019s schedule</b>\n`;
    for (const n of timed) {
      const cleanText = stripUrls(n.text);
      const recur = n.isRecurring ? " <i>(recurring)</i>" : "";
      msg += `  \u2022 <b>${n.time}</b> \u2014 ${cleanText}${recur}\n`;
    }
    msg += "\n";
  }

  if (untimed.length > 0) {
    msg += `<b>Also on your list for today</b>\n`;
    for (const n of untimed) {
      const cleanText = stripUrls(n.text);
      const recur = n.isRecurring ? " <i>(recurring)</i>" : "";
      msg += `  \u2022 ${cleanText}${recur}\n`;
    }
    msg += "\n";
  }

  if (hasTodo) {
    msg += `<b>To-do lists</b>\n`;
    msg += `${todoBlocks.join("\n\n")}\n\n`;
  }
  if (hasShop) {
    msg += `<b>Shopping</b>\n`;
    msg += `${shopBlocks.join("\n\n")}\n\n`;
  }

  let smartItemCount = 0;
  for (const n of smartTodoNotes) {
    smartItemCount += (n.listItems || []).filter(
      (li) => !li.done && (li.text || "").trim(),
    ).length;
  }
  for (const n of smartShopNotes) {
    smartItemCount += (n.listItems || []).filter(
      (li) => !li.done && (li.text || "").trim(),
    ).length;
  }
  const totalCount = allNotes.length + smartItemCount;
  msg += `<i>That is ${totalCount} item${totalCount !== 1 ? "s" : ""} on your programme, sir.</i>`;
  return msg;
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      },
    );
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!cronSecret || bearer !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: rows, error: fetchErr } = await supabase
    .from("planner_data")
    .select("key, payload")
    .in("key", ["notes", "recurring", "notifSettings", "morningBriefSent"]);

  if (fetchErr) {
    return new Response(
      JSON.stringify({ error: fetchErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const byKey = new Map<string, unknown>();
  for (const row of rows ?? []) {
    byKey.set(row.key as string, row.payload);
  }

  const notif = (byKey.get("notifSettings") || {}) as NotifSettings;
  if (!notif.morningBriefing) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "morning_briefing_disabled" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  if (!notif.telegramEnabled) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "telegram_disabled" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  const token = (notif.telegramBotToken || "").trim();
  const chatId = (notif.telegramChatId || "").trim();
  if (!token || !chatId) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_telegram_credentials" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Missing timeZone defaults to UTC: "06:30" then means 06:30 UTC (e.g. 08:30 in CEST).
  // The app merges IANA zones from the browser into notifSettings on sync.
  const timeZone = (notif.timeZone || "").trim() || "UTC";
  const todayKey = calendarDateInTimeZone(timeZone);

  const sentPayload = byKey.get("morningBriefSent") as { date?: string } | null;
  if (sentPayload?.date === todayKey) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "already_sent", todayKey }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const [bh, bm] = (notif.morningTime || "06:30").split(":").map(Number);
  if (isNaN(bh) || isNaN(bm)) {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid_morning_time" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const clock = clockInTimeZone(timeZone);
  if (clock.hour !== bh || clock.minute !== bm) {
    return new Response(
      JSON.stringify({
        ok: true,
        skipped: "not_briefing_minute",
        timeZone,
        now: clock,
        scheduled: { hour: bh, minute: bm },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const notes = (byKey.get("notes") || {}) as Record<string, Note[]>;
  const recurring = (byKey.get("recurring") || []) as Recurring[];

  const msgHtml = buildMorningBriefing(notes, recurring, todayKey);
  let text: string;
  if (msgHtml) {
    text = msgHtml;
  } else {
    const d = parseDateKey(todayKey);
    const dayName = WEEKDAYS[d.getUTCDay()];
    text =
      `<b>Good morning, sir.</b>\nNothing appears on your calendar for ${dayName}. Your day is at your discretion.`;
  }

  const ok = await sendTelegramMessage(token, chatId, text);
  if (!ok) {
    return new Response(
      JSON.stringify({ ok: false, error: "telegram_send_failed" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const { error: upErr } = await supabase.from("planner_data").upsert(
    {
      key: "morningBriefSent",
      payload: { date: todayKey },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );

  if (upErr) {
    return new Response(
      JSON.stringify({ ok: false, telegram: true, persistError: upErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, sent: true, todayKey, timeZone }),
    { headers: { "Content-Type": "application/json" } },
  );
});
