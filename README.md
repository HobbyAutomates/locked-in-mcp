# bandlog-mcp

One-file MCP server (no `npm install`) that lets Claude log workouts and meals, and read
streaks and daily totals, in the same Supabase `bandlog` schema the Band Log phone app and
web app use. Meal text is priced by the web app's `/api/parse-meal` (Haiku + food table).

## Config (env)
- `SUPABASE_URL` — `https://evizkfvltacrfngsgbuu.supabase.co`
- `SUPABASE_KEY` — the project's anon key
- `BANDLOG_EMAIL` / `BANDLOG_PASSWORD` — the Band Log account (same as the app). The server
  signs in on first call and refreshes the token itself.
- `BANDLOG_API` — optional, defaults to the Railway web app.

## Register with Claude Code
```
claude mcp add bandlog -s user \
  -e SUPABASE_URL=https://evizkfvltacrfngsgbuu.supabase.co \
  -e SUPABASE_KEY=<anon key> \
  -e BANDLOG_EMAIL=<email> \
  -e BANDLOG_PASSWORD=<password> \
  -- node C:/Users/sohum/bandlog-mcp/index.js
```

## Tools
- `log_workout(muscles[], date?, band_level?, resistance_kg?, minutes?, exercises?, notes?)`
- `log_meal(text, date?, dry_run?)`
- `get_today(date?)` · `get_streaks()`
- `list_workouts(days?)` · `list_meals(days?)`
- `delete_workout(id)` · `delete_meal(id)`
- `set_targets(weekly_workout_target?, protein_target_g?, calorie_target?)`
