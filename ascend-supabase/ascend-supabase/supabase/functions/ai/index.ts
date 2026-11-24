// AI helper for signed-in members: meal estimates from text or a photo, and coach message drafts.
// Deploy: supabase functions deploy ai
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the function's secrets
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Only active Ascend members may use the AI (it spends your Anthropic credits).
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  if (!who?.user) return json({ error: "unauthorized" }, 401);
  const { data: member } = await admin.from("members").select("active").eq("user_id", who.user.id).maybeSingle();
  if (!member?.active) return json({ error: "unauthorized" }, 403);

  let prompt = "";
  let images: { media_type: string; data: string }[] = [];
  try {
    const body = await req.json();
    prompt = String(body.prompt ?? "");
    images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!prompt || prompt.length > 20000) return json({ error: "bad_request" }, 400);
  images = images.filter((i) => IMAGE_TYPES.has(i.media_type) && typeof i.data === "string" && i.data.length < 7_000_000);

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low" }, // short, structured tasks: low effort keeps replies fast and cheap
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a request is declined, the API retries it on a suitable fallback model
      messages: [{
        role: "user",
        content: [
          ...images.map((i) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: i.media_type as "image/jpeg", data: i.data },
          })),
          { type: "text" as const, text: prompt },
        ],
      }],
    });
    if (response.stop_reason === "refusal") return json({ error: "refused" }, 422);
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return json({ text });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "AI key missing or invalid" }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: "ai_unavailable" }, 502);
    return json({ error: "ai_unavailable" }, 500);
  }
});
