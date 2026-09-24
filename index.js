#!/usr/bin/env node
/**
 * Band Log MCP  —  zero-dependency edition
 * ----------------------------------------
 * Lets Claude log workouts and meals, and read streaks/totals, in the same Supabase `bandlog`
 * schema the Band Log phone app and web app use. Meal text is priced by the web app's
 * /api/parse-meal (Haiku + the Indian food table), so all three surfaces agree.
 *
 * No npm install: speaks MCP stdio directly and uses Node's built-in fetch (Node 18+).
 *
 * Config (env vars):
 *   SUPABASE_URL       e.g. https://xxxxxxxx.supabase.co
 *   SUPABASE_KEY       the project's anon (public) key
 *   BANDLOG_EMAIL      the Band Log account (same as the phone app)
 *   BANDLOG_PASSWORD   its password — signs in on first use, refreshes automatically
 *   BANDLOG_API        optional, web app base for meal parsing (default: Railway URL below)
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const EMAIL = process.env.BANDLOG_EMAIL;
const PASSWORD = process.env.BANDLOG_PASSWORD;
const API = (process.env.BANDLOG_API || "https://web-production-ff1cf.up.railway.app").replace(/\/+$/, "");

if (!SUPABASE_URL || !SUPABASE_KEY || !EMAIL || !PASSWORD) {
  console.error("bandlog-mcp: need SUPABASE_URL, SUPABASE_KEY, BANDLOG_EMAIL, BANDLOG_PASSWORD.");
  process.exit(1);
}

const SCHEMA = "bandlog";
const MUSCLES = ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Forearms", "Core", "Glutes", "Quads", "Hamstrings", "Calves", "Other"];
const BANDS = ["Light", "Medium", "Heavy"];

// ---------- auth (GoTrue password grant + refresh) ----------
let session = null; // { access, refresh, exp, userId }

async function gotrue(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const o = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(o.msg || o.error_description || o.message || `Auth ${res.status}`);
  session = { access: o.access_token, refresh: o.refresh_token, exp: Date.now() / 1000 + (o.expires_in || 3600), userId: o.user?.id };
}

async function token() {
  if (!session) await gotrue("token?grant_type=password", { email: EMAIL, password: PASSWORD });
  else if (session.exp - Date.now() / 1000 < 60) {
    try { await gotrue("token?grant_type=refresh_token", { refresh_token: session.refresh }); }
    catch { session = null; await gotrue("token?grant_type=password", { email: EMAIL, password: PASSWORD }); }
  }
  return session.access;
}

// ---------- PostgREST on the bandlog schema ----------
async function sb(method, path, { body, prefer } = {}) {
  const t = await token();
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${t}`,
    "Accept-Profile": SCHEMA,
    "Content-Profile": SCHEMA,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  return text ? JSON.parse(text) : null;
}

// ---------- dates / streaks (same rules as the apps) ----------
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); const x = new Date(y, m - 1, d); x.setDate(x.getDate() + n); return iso(x); };
const weekStart = (s) => { const [y, m, d] = s.split("-").map(Number); const x = new Date(y, m - 1, d); return addDays(s, -((x.getDay() + 6) % 7)); };
const resolveDate = (s) => {
  if (!s) return today();
  const v = String(s).trim().toLowerCase();
  if (v === "today") return today();
  if (v === "yesterday") return addDays(today(), -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  throw new Error(`Date must be YYYY-MM-DD, "today" or "yesterday" (got "${s}")`);
};

function weekStreak(dates, target) {
  const per = {}; for (const d of dates) per[weekStart(d)] = (per[weekStart(d)] || 0) + 1;
  let w = weekStart(today()); if ((per[w] || 0) < target) w = addDays(w, -7);
  let n = 0; while ((per[w] || 0) >= target) { n++; w = addDays(w, -7); }
  return n;
}
function dayStreak(dates) {
  const set = new Set(dates); let cur = set.has(today()) ? today() : addDays(today(), -1);
  let n = 0; while (set.has(cur)) { n++; cur = addDays(cur, -1); }
  return n;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const r1 = (n) => Math.round(n * 10) / 10;

async function profile() {
  const rows = await sb("GET", "profiles?select=weekly_workout_target,protein_target_g,calorie_target&limit=1");
  return rows[0] || { weekly_workout_target: 3, protein_target_g: 120, calorie_target: 2200 };
}

// ---------- tools ----------
const TOOLS = [
  {
    name: "log_workout",
    description: "Log a resistance-band workout. Appears in the Band Log app immediately.",
    inputSchema: {
      type: "object",
      properties: {
        muscles: { type: "array", items: { type: "string", enum: MUSCLES }, description: "Muscle groups trained" },
        date: { type: "string", description: "YYYY-MM-DD, 'today' (default) or 'yesterday'" },
        band_level: { type: "string", enum: BANDS, description: "Default Medium" },
        resistance_kg: { type: "number", description: "e.g. 9" },
        minutes: { type: "number" },
        exercises: { type: "string", description: "Free text, e.g. 'rows, chest press, lateral raise'" },
        notes: { type: "string" },
      },
      required: ["muscles"],
    },
  },
  {
    name: "log_meal",
    description:
      "Log what was eaten from plain text ('150 g rice, 100 g dal, 2 eggs, 1 scoop whey'). Haiku parses it, the Indian food table prices it, and the meal is saved with calories/protein. Returns the priced items.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The food description, as spoken or typed" },
        date: { type: "string", description: "YYYY-MM-DD, 'today' (default) or 'yesterday'" },
        dry_run: { type: "boolean", description: "Only parse and price; do not save" },
      },
      required: ["text"],
    },
  },
  {
    name: "get_today",
    description: "Today's (or a given day's) totals: calories, protein vs targets, workouts and meals logged.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD, default today" } } },
  },
  {
    name: "get_streaks",
    description: "Workout week streak, day streak, sessions this week vs target, meal-logging streak, days since each muscle was trained.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_workouts",
    description: "Recent workouts (default last 30 days).",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "Look-back window, default 30" } } },
  },
  {
    name: "list_meals",
    description: "Recent meals with items (default last 7 days).",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "Look-back window, default 7" } } },
  },
  {
    name: "delete_workout",
    description: "Delete a workout by id (from list_workouts).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_meal",
    description: "Delete a meal by id (from list_meals / get_today).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "set_targets",
    description: "Update weekly workout target and/or daily protein (g) and calorie (kcal) targets.",
    inputSchema: {
      type: "object",
      properties: {
        weekly_workout_target: { type: "number" },
        protein_target_g: { type: "number" },
        calorie_target: { type: "number" },
      },
    },
  },
];

async function callTool(name, a = {}) {
  if (name === "log_workout") {
    const muscles = (a.muscles || []).map((m) => MUSCLES.find((x) => x.toLowerCase() === String(m).toLowerCase())).filter(Boolean);
    if (!muscles.length) return text(`Pick at least one of: ${MUSCLES.join(", ")}`);
    const band = BANDS.find((b) => b.toLowerCase() === String(a.band_level || "medium").toLowerCase()) || "Medium";
    await token();
    const [row] = await sb("POST", "workouts", {
      prefer: "return=representation",
      body: {
        user_id: session.userId, date: resolveDate(a.date), muscles, band_level: band,
        resistance_kg: a.resistance_kg ?? null, minutes: a.minutes ?? null,
        exercises: (a.exercises || "").trim(), notes: (a.notes || "").trim(),
      },
    });
    return text(`Logged ${row.date}: ${muscles.join(", ")} · ${band}${row.resistance_kg ? ` ${row.resistance_kg} kg` : ""}${row.minutes ? ` · ${row.minutes} min` : ""}  (${row.id})`);
  }

  if (name === "log_meal") {
    if (!a.text || !a.text.trim()) return text("Tell me what was eaten.");
    const date = resolveDate(a.date);
    const t = await token();
    const res = await fetch(`${API}/api/parse-meal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: a.text }),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parsed.error || `Parser ${res.status}`);
    const items = parsed.items || [];
    if (!items.length) return text(`Nothing food-like found. Ignored: ${(parsed.unparsed || []).join(", ") || "—"}`);
    const kcal = Math.round(items.reduce((s, i) => s + i.calories, 0));
    const prot = r1(items.reduce((s, i) => s + i.protein_g, 0));
    const lines = items.map((i) => `  • ${i.name} ${r1(i.grams)} g → ${Math.round(i.calories)} kcal, P ${r1(i.protein_g)} g${i.source === "estimated" ? " (est.)" : ""}`);
    if (parsed.assumptions?.length) lines.push(`  assumptions: ${parsed.assumptions.join("; ")}`);
    if (parsed.unparsed?.length) lines.push(`  ignored: ${parsed.unparsed.join(", ")}`);
    if (a.dry_run) return text(`Would log ${kcal} kcal · ${prot} g protein:\n${lines.join("\n")}`);

    const [meal] = await sb("POST", "meals", { prefer: "return=representation", body: { user_id: session.userId, date, raw_text: a.text.trim() } });
    await sb("POST", "meal_items", {
      body: items.map((i) => ({
        meal_id: meal.id, user_id: session.userId, food_id: i.food_id ?? null, name: i.name, grams: i.grams,
        calories: i.calories, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g, source: i.source, confidence: i.confidence ?? null,
      })),
    });
    return text(`Logged ${date}: ${kcal} kcal · ${prot} g protein  (${meal.id})\n${lines.join("\n")}`);
  }

  if (name === "get_today") {
    const date = resolveDate(a.date);
    const p = await profile();
    const [workouts, meals] = await Promise.all([
      sb("GET", `workouts?select=id,muscles,band_level,resistance_kg,minutes,exercises&date=eq.${date}`),
      sb("GET", `meals?select=id,raw_text,meal_items(name,grams,calories,protein_g)&date=eq.${date}&order=created_at.asc`),
    ]);
    const items = meals.flatMap((m) => m.meal_items || []);
    const kcal = Math.round(items.reduce((s, i) => s + Number(i.calories), 0));
    const prot = r1(items.reduce((s, i) => s + Number(i.protein_g), 0));
    const out = [`${date}: ${kcal}/${p.calorie_target} kcal · ${prot}/${p.protein_target_g} g protein`];
    out.push(workouts.length ? `Workouts: ${workouts.map((w) => `${w.muscles.join("+")} ${w.band_level}${w.resistance_kg ? ` ${w.resistance_kg}kg` : ""}${w.minutes ? ` ${w.minutes}min` : ""} (${w.id})`).join("; ")}` : "Workouts: none yet");
    if (meals.length) for (const m of meals) out.push(`Meal (${m.id}): ${(m.meal_items || []).map((i) => `${i.name} ${r1(Number(i.grams))}g`).join(", ")} → ${Math.round((m.meal_items || []).reduce((s, i) => s + Number(i.calories), 0))} kcal`);
    else out.push("Meals: none yet");
    return text(out.join("\n"));
  }

  if (name === "get_streaks") {
    const p = await profile();
    const from = addDays(today(), -120);
    const [workouts, meals] = await Promise.all([
      sb("GET", `workouts?select=date,muscles&date=gte.${from}&order=date.desc`),
      sb("GET", `meals?select=date&date=gte.${from}`),
    ]);
    const wd = [...new Set(workouts.map((w) => w.date))];
    const md = [...new Set(meals.map((m) => m.date))];
    const ws = weekStart(today());
    const thisWeek = wd.filter((d) => d >= ws && d <= today()).length;
    const rest = MUSCLES.map((m) => {
      const hit = workouts.find((w) => w.muscles.includes(m));
      if (!hit) return `${m}: never`;
      const [y, mo, d] = hit.date.split("-").map(Number); const days = Math.round((new Date() - new Date(y, mo - 1, d)) / 864e5);
      return `${m}: ${days === 0 ? "today" : `${days}d ago`}`;
    });
    return text([
      `Week streak: ${weekStreak(wd, p.weekly_workout_target)} (target ${p.weekly_workout_target}/wk) · this week ${thisWeek}/${p.weekly_workout_target}`,
      `Day streak: ${dayStreak(wd)} · meal-logging streak: ${dayStreak(md)}`,
      `Rest: ${rest.join(", ")}`,
    ].join("\n"));
  }

  if (name === "list_workouts") {
    const from = addDays(today(), -(a.days || 30));
    const rows = await sb("GET", `workouts?select=id,date,muscles,band_level,resistance_kg,minutes,exercises,notes&date=gte.${from}&order=date.desc`);
    if (!rows.length) return text("No workouts in that window.");
    return text(rows.map((w) => `${w.date}  ${w.muscles.join(", ")} · ${w.band_level}${w.resistance_kg ? ` ${w.resistance_kg} kg` : ""}${w.minutes ? ` · ${w.minutes} min` : ""}${w.exercises ? ` — ${w.exercises}` : ""}  (${w.id})`).join("\n"));
  }

  if (name === "list_meals") {
    const from = addDays(today(), -(a.days || 7));
    const rows = await sb("GET", `meals?select=id,date,raw_text,meal_items(name,grams,calories,protein_g)&date=gte.${from}&order=date.desc,created_at.desc`);
    if (!rows.length) return text("No meals in that window.");
    return text(rows.map((m) => {
      const its = m.meal_items || [];
      return `${m.date}  ${Math.round(its.reduce((s, i) => s + Number(i.calories), 0))} kcal · ${r1(its.reduce((s, i) => s + Number(i.protein_g), 0))} g P — ${its.map((i) => `${i.name} ${r1(Number(i.grams))}g`).join(", ")}  (${m.id})`;
    }).join("\n"));
  }

  if (name === "delete_workout") { await sb("DELETE", `workouts?id=eq.${a.id}`); return text("Workout deleted."); }
  if (name === "delete_meal") { await sb("DELETE", `meals?id=eq.${a.id}`); return text("Meal deleted."); }

  if (name === "set_targets") {
    const p = await profile();
    await token();
    const body = {
      id: session.userId,
      weekly_workout_target: a.weekly_workout_target ?? p.weekly_workout_target,
      protein_target_g: a.protein_target_g ?? p.protein_target_g,
      calorie_target: a.calorie_target ?? p.calorie_target,
    };
    await sb("POST", "profiles", { prefer: "resolution=merge-duplicates", body });
    return text(`Targets: ${body.weekly_workout_target}/wk · ${body.protein_target_g} g protein · ${body.calorie_target} kcal`);
  }

  return text(`Unknown tool: ${name}`);
}

// --- minimal MCP stdio plumbing (newline-delimited JSON-RPC 2.0) ---
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bandlog", version: "1.0.0" } } });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      let result;
      try { result = await callTool(params?.name, params?.arguments || {}); }
      catch (e) { result = { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
      send({ jsonrpc: "2.0", id, result });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(line);
  }
});

console.error("bandlog-mcp: ready.");
