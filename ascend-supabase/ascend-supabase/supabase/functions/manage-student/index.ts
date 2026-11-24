// Coach-only account management: create athlete logins, reset passwords, pause or reactivate.
// Deploy: supabase functions deploy manage-student
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Who is calling? Verify their session token, then check they are an active coach.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Sign in again." }, 401);
  const { data: me } = await admin.from("members").select("role, active").eq("user_id", who.user.id).maybeSingle();
  if (!me || me.role !== "coach" || !me.active) return json({ error: "Only the coach can manage athletes." }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = String(body.action ?? "");

  if (action === "create") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const name = String(body.name ?? "").trim().slice(0, 80);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    if (password.length < 8) return json({ error: "Use at least 8 characters for the password." }, 400);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (error) {
      const taken = /already|registered|exists/i.test(error.message);
      return json({ error: taken ? "An account with this email already exists." : error.message }, 400);
    }
    const { error: mErr } = await admin.from("members").insert({ user_id: data.user.id, role: "student", name, email });
    if (mErr) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: mErr.message }, 500); }
    return json({ ok: true, user_id: data.user.id });
  }

  const userId = String(body.user_id ?? "");
  if (!userId) return json({ error: "Missing athlete." }, 400);
  const { data: target } = await admin.from("members").select("role").eq("user_id", userId).maybeSingle();
  if (!target || target.role !== "student") return json({ error: "That athlete wasn't found." }, 404);

  if (action === "set_password") {
    const password = String(body.password ?? "");
    if (password.length < 8) return json({ error: "Use at least 8 characters for the password." }, 400);
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    return error ? json({ error: error.message }, 400) : json({ ok: true });
  }

  if (action === "set_active") {
    const active = body.active === true;
    const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? "none" : "876000h" });
    if (error) return json({ error: error.message }, 400);
    await admin.from("members").update({ active }).eq("user_id", userId);
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
