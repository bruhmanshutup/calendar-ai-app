import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before seeding.",
  );
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = process.env.DEMO_USER_EMAIL ?? "demo@planpilot.local";
const password = process.env.DEMO_USER_PASSWORD ?? "PlanPilot-demo-2026!";
const created = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
const userId =
  created.data.user?.id ??
  (
    await supabase.auth.admin.listUsers()
  ).data.users.find((user) => user.email === email)?.id;

if (!userId) throw new Error("Unable to resolve the demo user.");

await supabase.from("profiles").upsert({
  id: userId,
  display_name: "Alex Morgan",
  time_zone: "America/Los_Angeles",
});
await supabase.from("user_preferences").upsert({
  user_id: userId,
  waking_time: "07:00",
  sleeping_time: "23:00",
  preferred_focus_minutes: 45,
  maximum_focus_minutes: 90,
  preferred_break_minutes: 10,
  planning_mode: "balanced",
  weekends_allowed: true,
  preferred_focus_windows: [{ start: "09:00", end: "12:00" }],
  preferred_routine_windows: [{ start: "17:00", end: "20:00" }],
});
await supabase.from("availability_rules").upsert(
  [1, 2, 3, 4, 5].map((day) => ({
    user_id: userId,
    rule_type: "available",
    day_of_week: day,
    start_time: "16:00",
    end_time: "21:00",
    label: "Weekday planning time",
  })),
);

console.log(`Seeded PlanPilot demo user: ${email}`);

