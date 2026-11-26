/* Ascend platform layer: Supabase auth + data adapter.
   The app talks to a small document API (doc/collection/onSnapshot). This file implements it
   on a single Supabase table `docs (owner, path, data)` protected by row-level security,
   and gates the whole app behind an email + password login. */
(() => {
  "use strict";
  const CFG = window.ASCEND_CONFIG || {};
  const LSK = { uid: "ascend.uid", cache: ["ascend100.cache", "titan.base"] };
  const lsGet = k => { try { return localStorage.getItem(k) } catch { return null } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { } };
  const lsDel = k => { try { localStorage.removeItem(k) } catch { } };
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  const parent = p => p.split("/").slice(0, -1).join("/");
  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

  let readyResolve; const ready = new Promise(r => readyResolve = r); // resolves {uid, role, email} after login
  const SESSION = { uid: null, role: null, email: null, name: "" };

  /* ---------------- data adapter ---------------- */
  function makeDB(me) {
    const owners = {};
    const resolve = path => { const p = path.split("/"); if (p[0] === "students" && p.length >= 2) return p.length === 2 ? { o: p[1], k: "roster" } : { o: p[1], k: p.slice(2).join("/") }; return { o: me, k: path } };
    const meta = { fromCache: false, hasPendingWrites: false };
    const dsnap = (O, k) => { const v = O.map.get(k); return { id: k.split("/").pop(), exists: v !== undefined, data: () => v === undefined ? undefined : clone(v), metadata: meta } };
    async function loadOwner(o) { let all = [], from = 0; for (; ;) { const { data, error } = await sb.from("docs").select("path,data").eq("owner", o).range(from, from + 999); if (error) throw error; all = all.concat(data || []); if (!data || data.length < 1000) break; from += 1000 } return all }
    function emit(O, path) { O.L.forEach(l => { if ((l.kind === "doc" && l.k === path) || (l.kind === "col" && parent(path) === l.k)) l.fire() }) }
    function ensure(o) {
      if (owners[o]) return owners[o];
      const O = owners[o] = { map: new Map(), L: new Set() };
      O.ready = loadOwner(o).then(rows => rows.forEach(r => O.map.set(r.path, r.data)));
      sb.channel("docs-" + o).on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "owner=eq." + o }, pl => {
        if (pl.eventType === "DELETE") { const k = pl.old && pl.old.path; if (!k) return; O.map.delete(k); emit(O, k) }
        else { O.map.set(pl.new.path, pl.new.data); emit(O, pl.new.path) }
      }).subscribe();
      return O;
    }
    const fail = e => { console.warn("[ascend] write failed", e); return Promise.reject({ code: "unavailable", message: String(e && e.message || e) }) };
    function doc(path) {
      const { o, k } = resolve(path);
      return {
        id: k.split("/").pop(), path,
        async get() { const O = ensure(o); await O.ready; return dsnap(O, k) },
        async set(data) { const O = ensure(o); O.map.set(k, clone(data)); emit(O, k); const { error } = await sb.from("docs").upsert({ owner: o, path: k, data, updated_at: new Date().toISOString() }); if (error) return fail(error) },
        async update(data) { const O = ensure(o); await O.ready; const cur = O.map.get(k); if (cur === undefined) return Promise.reject({ code: "invalid_argument" }); return this.set({ ...cur, ...data }) },
        async delete() { const O = ensure(o); O.map.delete(k); emit(O, k); const { error } = await sb.from("docs").delete().eq("owner", o).eq("path", k); if (error) return fail(error) },
        onSnapshot(cb, err) { const O = ensure(o); const l = { kind: "doc", k, on: false, fire() { if (l.on) cb(dsnap(O, k)) } }; O.L.add(l); O.ready.then(() => { l.on = true; l.fire() }, e => err && err({ code: "unavailable", message: String(e && e.message) })); return () => O.L.delete(l) },
        collection(sub) { return collection(path + "/" + sub) }
      };
    }
    function collection(path) {
      if (path === "students") return roster;
      const { o, k } = resolve(path);
      const snap = (O, prev) => {
        const docs = [...O.map.keys()].filter(p => parent(p) === k).sort().map(p => dsnap(O, p));
        const cur = new Map(docs.map(d => [d.id, d])), changes = [];
        docs.forEach(d => { if (!prev.has(d.id)) changes.push({ type: "added", doc: d }); else if (JSON.stringify(prev.get(d.id).data()) !== JSON.stringify(d.data())) changes.push({ type: "modified", doc: d }) });
        prev.forEach((d, id) => { if (!cur.has(id)) changes.push({ type: "removed", doc: d }) });
        return { s: { docs, size: docs.length, empty: !docs.length, docChanges: () => changes, metadata: meta }, cur };
      };
      return {
        path, doc: id => doc(path + "/" + id),
        async add(data) { const d = doc(path + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)); await d.set(data); return d },
        async get() { const O = ensure(o); await O.ready; return snap(O, new Map()).s },
        onSnapshot(cb, err) { const O = ensure(o); let prev = new Map(); const l = { kind: "col", k, on: false, fire() { if (!l.on) return; const r = snap(O, prev); prev = r.cur; cb(r.s) } }; O.L.add(l); O.ready.then(() => { l.on = true; l.fire() }, e => err && err({ code: "unavailable", message: String(e && e.message) })); return () => O.L.delete(l) }
      };
    }
    /* roster: every student member, merged with the summary doc they keep at path "roster" */
    const RL = new Set(); let rosterSub = false;
    async function rosterSnap() {
      const [m, r] = await Promise.all([sb.from("members").select("user_id,name,email,active,role").eq("role", "student"), sb.from("docs").select("owner,data").eq("path", "roster")]);
      const byOwner = new Map((r.data || []).map(x => [x.owner, x.data]));
      const docs = (m.data || []).map(x => { const d = { ...(byOwner.get(x.user_id) || {}), email: x.email, active: x.active !== false }; if (!d.name) d.name = x.name || ""; return { id: x.user_id, exists: true, data: () => clone(d), metadata: meta } });
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map(d => ({ type: "added", doc: d })), metadata: meta };
    }
    async function refreshRoster() { if (!RL.size) return; try { const s = await rosterSnap(); RL.forEach(cb => cb(s)) } catch (e) { console.warn(e) } }
    const roster = {
      path: "students", doc: id => doc("students/" + id),
      async get() { return rosterSnap() },
      onSnapshot(cb) { RL.add(cb); refreshRoster(); if (!rosterSub) { rosterSub = true; sb.channel("roster").on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "path=eq.roster" }, refreshRoster).on("postgres_changes", { event: "*", schema: "public", table: "members" }, refreshRoster).subscribe() } return () => RL.delete(cb) }
    };
    return { doc, collection, refreshRoster };
  }

  /* ---------------- AI via edge function ---------------- */
  async function toImagePart(blob) {
    const bmp = await createImageBitmap(blob); const s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] };
  }
  async function askClaude(input, opts = {}) {
    if (!sb) throw { code: "unavailable" };
    const prompt = typeof input === "string" ? input : input.filter(t => t.role === "user").map(t => t.content).join("\n\n");
    const images = opts.images ? await Promise.all([...opts.images].slice(0, 2).map(toImagePart)) : [];
    const { data, error } = await sb.functions.invoke("ai", { body: { prompt, images } });
    if (error || !data || typeof data.text !== "string") throw { code: data && data.error === "refused" ? "refused" : "unavailable", message: String(error && error.message || "") };
    return { text: data.text, truncated: false };
  }
  const sample = Object.assign((input, opts) => askClaude(input, opts), {
    json: async (input, opts) => { const { text } = await askClaude(input, opts); try { return JSON.parse(text) } catch { } const f = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) try { return JSON.parse(f[1]) } catch { } const i = text.search(/[\[{]/); if (i >= 0) try { return JSON.parse(text.slice(i, Math.max(text.lastIndexOf("]"), text.lastIndexOf("}")) + 1)) } catch { } throw { code: "bad_json" } },
    limits: async () => ({ images: true })
  });
  const downloads = { async save({ filename, data }) { const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: "application/json" })); const a = Object.assign(document.createElement("a"), { href: url, download: filename }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000) } };

  /* ---------------- capability shim used by the app ---------------- */
  let DBI = null;
  window.claude = {
    use: async name => {
      if (name === "sample") return configured ? sample : null;
      if (name === "downloads") return downloads;
      if (!configured) return null;
      const s = await ready;
      if (name === "db") return DBI || (DBI = makeDB(s.uid));
      if (name === "user") return {
        isOwner: async () => s.role === "coach", canEdit: async () => s.role === "coach", id: async () => s.uid, me: async () => ({ id: s.uid, name: s.name }),
        profiles: async ids => { const { data } = await sb.from("members").select("user_id,name").in("user_id", ids); return Object.fromEntries((data || []).map(m => [m.user_id, { name: m.name || "" }])) }
      };
      return null;
    }
  };
  window.ASCEND = { sb, ready, session: SESSION, refreshRoster: () => DBI && DBI.refreshRoster() };

  /* ---------------- login UI ---------------- */
  const css = `.auth{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:radial-gradient(120% 80% at 50% -10%,var(--sky1) 0%,var(--void) 60%)}
  .auth .card{width:min(420px,100%);border-radius:24px;padding:28px 24px;background:linear-gradient(145deg,var(--glass-hi),var(--glass));border:1px solid var(--line-hi);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 20px 60px var(--shadow),inset 0 1px 0 var(--hl);display:grid;gap:14px;color:var(--fg)}
  .auth h1{font-family:"Chakra Petch",system-ui,sans-serif;font-size:30px;letter-spacing:.06em;margin:0;text-transform:uppercase}
  .auth .mot{margin:-8px 0 6px;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .auth label{display:grid;gap:6px;font-size:12px;color:var(--muted)}
  .auth input{font:inherit;font-size:15px;color:var(--fg);background:var(--field);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .auth button{font:inherit;font-weight:600;cursor:pointer;border-radius:12px;padding:12px 16px;border:1px solid var(--line-hi);background:var(--glass-hi);color:var(--fg)}
  .auth button.pri{background:linear-gradient(135deg,var(--cyan),var(--violet));color:var(--on-accent);border-color:transparent}
  .auth .lnk{background:none;border:0;padding:0;color:var(--cyan);font-weight:500;justify-self:start}
  .auth .msg{font-size:13px;min-height:1em;color:var(--warn)}.auth .msg.ok{color:var(--good)}
  .auth .tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:14px;background:var(--inset);border:1px solid var(--line)}
  .auth .tabs button{border:0;border-radius:10px;padding:10px;background:none;color:var(--muted)}
  .auth .tabs button[aria-selected="true"]{background:linear-gradient(135deg,var(--cyan),var(--violet));color:var(--on-accent)}
  .auth input:focus-visible,.auth button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}`;
  const LOGO = `<svg width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="alg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="var(--cyan)"/><stop offset=".55" stop-color="var(--violet)"/><stop offset="1" stop-color="var(--rose)"/></linearGradient></defs><path d="M16 2.5 28 9.3v13.4L16 29.5 4 22.7V9.3z" fill="none" stroke="url(#alg)" stroke-width="2.2" stroke-linejoin="round"/><path d="M10 11.5h12M16 11.5V24" fill="none" stroke="url(#alg)" stroke-width="2.8" stroke-linecap="round"/></svg>`;
  let box = null;
  function overlay(html) {
    if (!box) { const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st); box = document.createElement("div"); box.className = "auth"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); document.body.appendChild(box) }
    box.hidden = false; box.innerHTML = `<div class="card">${LOGO}<h1>Ascend</h1><p class="mot">Rise daily. Never settle.</p>${html}</div>`;
    const f = box.querySelector("input"); if (f) setTimeout(() => f.focus(), 30); return box;
  }
  const hide = () => { if (box) box.hidden = true };
  const msg = (t, ok) => { const m = box && box.querySelector(".msg"); if (m) { m.textContent = t; m.className = "msg" + (ok ? " ok" : "") } };
  const tabs = which => CFG.allowSignup === false ? "" : `<div class="tabs" role="tablist"><button type="button" role="tab" data-tab="in" aria-selected="${which === "in"}">Sign in</button><button type="button" role="tab" data-tab="up" aria-selected="${which === "up"}">Create account</button></div>`;
  const wireTabs = () => box.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => b.dataset.tab === "up" ? showSignup() : showLogin());
  function showLogin(note) {
    overlay(`${tabs("in")}<form id="lf" style="display:grid;gap:12px"><label>Email<input id="le" type="email" autocomplete="username" required></label><label>Password<input id="lp" type="password" autocomplete="current-password" required></label><button class="pri" type="submit">Sign in</button></form><button class="lnk" type="button" id="lforgot">Forgot password?</button><p class="msg">${esc(note || "")}</p>`);
    wireTabs();
    box.querySelector("#lf").onsubmit = async e => { e.preventDefault(); msg("Signing in…", true); const { error } = await sb.auth.signInWithPassword({ email: box.querySelector("#le").value.trim(), password: box.querySelector("#lp").value }); if (error) msg(error.message === "Invalid login credentials" ? "Wrong email or password. Check both, or ask your coach to reset your password." : error.message) };
    box.querySelector("#lforgot").onclick = async () => { const em = box.querySelector("#le").value.trim(); if (!em) { msg("Type your email first, then tap Forgot password."); return } const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname }); msg(error ? error.message : "Check your inbox for a reset link.", !error) };
  }
  function showSignup() {
    overlay(`${tabs("up")}<p style="margin:0;color:#8e9bbb;font-size:13.5px">Create your athlete account. Your coach will see your progress.</p><form id="sf" style="display:grid;gap:12px"><label>Full name<input id="sn" autocomplete="name" required maxlength="80"></label><label>Email<input id="se" type="email" autocomplete="email" required></label><label>Password<input id="sp1" type="password" autocomplete="new-password" minlength="8" required></label><label>Repeat password<input id="sp2" type="password" autocomplete="new-password" minlength="8" required></label><button class="pri" type="submit">Create account</button></form><p class="msg"></p>`);
    wireTabs();
    box.querySelector("#sf").onsubmit = async e => {
      e.preventDefault(); const name = box.querySelector("#sn").value.trim(), email = box.querySelector("#se").value.trim(), a = box.querySelector("#sp1").value;
      if (a !== box.querySelector("#sp2").value) { msg("The two passwords don't match."); return }
      msg("Creating your account…", true);
      const { data, error } = await sb.auth.signUp({ email, password: a, options: { data: { name }, emailRedirectTo: location.origin + location.pathname } });
      if (error) { msg(/not allowed|disabled/i.test(error.message) ? "Sign-up is closed right now. Ask your coach for an account." : /registered|exists/i.test(error.message) ? "This email already has an account. Sign in instead." : error.message); return }
      if (data && data.session) return; // signed in straight away; onAuthStateChange starts the app
      showLogin(); msg("Account created. Check your inbox for a confirmation email, tap the link, then sign in here.", true);
    };
  }
  function showNewPassword() {
    overlay(`<p style="margin:0">Choose a new password for your account.</p><form id="np" style="display:grid;gap:12px"><label>New password<input id="np1" type="password" autocomplete="new-password" minlength="8" required></label><label>Repeat it<input id="np2" type="password" autocomplete="new-password" minlength="8" required></label><button class="pri" type="submit">Save password</button></form><p class="msg"></p>`);
    box.querySelector("#np").onsubmit = async e => { e.preventDefault(); const a = box.querySelector("#np1").value, b = box.querySelector("#np2").value; if (a !== b) { msg("The two passwords don't match."); return } const { error } = await sb.auth.updateUser({ password: a }); if (error) msg(error.message); else { msg("Password saved.", true); setTimeout(() => start(), 600) } };
  }
  function showSetup() {
    overlay(`<p style="margin:0">This copy of Ascend isn't connected to a database yet.</p><p style="margin:0;color:#8e9bbb;font-size:13.5px">Open <b>config.js</b> and paste your Supabase project URL and anon key, then reload. The README has the full setup steps.</p>`);
  }
  let started = false;
  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin(); return }
    const uid = session.user.id;
    if (lsGet(LSK.uid) && lsGet(LSK.uid) !== uid) { LSK.cache.forEach(lsDel); lsSet(LSK.uid, uid); location.reload(); return }
    lsSet(LSK.uid, uid);
    const { data: m, error } = await sb.from("members").select("role,name,email,active").eq("user_id", uid).maybeSingle();
    if (error || !m) { await sb.auth.signOut(); showLogin("This account isn't set up in Ascend yet. Ask your coach to add you."); return }
    if (m.active === false) { await sb.auth.signOut(); showLogin("This account is paused. Contact your coach."); return }
    Object.assign(SESSION, { uid, role: m.role, email: session.user.email, name: m.name || "" });
    hide(); if (!started) { started = true; readyResolve({ ...SESSION }) }
    accountUI();
  }
  async function signOut() { LSK.cache.forEach(lsDel); lsDel(LSK.uid); await sb.auth.signOut(); location.hash = ""; location.reload() }

  /* ---------------- account + coach admin UI hooks ---------------- */
  function toast(t) { const el = document.getElementById("toast"); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => el.hidden = true, 2600) }
  function accountUI() { const e = document.getElementById("acctEmail"); if (e) e.textContent = `${SESSION.email} · ${SESSION.role === "coach" ? "Coach" : "Athlete"}` }
  const genPw = () => { const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.getRandomValues(new Uint32Array(12)); return [...r].map(x => a[x % a.length]).join("") };
  async function admin(body) { const { data, error } = await sb.functions.invoke("manage-student", { body }); if (error || (data && data.error)) throw new Error((data && data.error) || (error && error.message) || "Request failed"); return data }
  function miniDialog(html, onSubmit) {
    const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`; document.body.appendChild(bg);
    const close = () => bg.remove(); bg.addEventListener("click", e => { if (e.target === bg || e.target.closest("[data-x]")) close() });
    const f = bg.querySelector("form"); f.onsubmit = async e => { e.preventDefault(); const b = f.querySelector("[type=submit]"); b.disabled = true; try { await onSubmit(f); close() } catch (err) { const m = f.querySelector(".dmsg"); if (m) m.textContent = err.message } b.disabled = false };
    const i = f.querySelector("input"); if (i) setTimeout(() => i.focus(), 30);
  }
  document.addEventListener("click", async e => {
    if (e.target.closest("#signOut")) { signOut(); return }
    if (e.target.closest("#chgPw")) { miniDialog(`<h2>Change password</h2><form class="stack" style="margin-top:12px"><label class="f">New password<input type="password" id="cp1" minlength="8" required autocomplete="new-password"></label><label class="f">Repeat it<input type="password" id="cp2" minlength="8" required autocomplete="new-password"></label><p class="dmsg muted" style="margin:0;color:var(--warn)"></p><div class="row"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn primary" type="submit" style="flex:1">Save password</button></div></form>`,
      async f => { const a = f.querySelector("#cp1").value; if (a !== f.querySelector("#cp2").value) throw new Error("The two passwords don't match."); const { error } = await sb.auth.updateUser({ password: a }); if (error) throw error; toast("Password changed") }); return }
    if (e.target.closest("#as-gen")) { const i = document.getElementById("as-pw"); if (i) { i.value = genPw(); i.type = "text" } return }
    const rp = e.target.closest("[data-resetpw]"); if (rp) { const id = rp.dataset.resetpw;
      miniDialog(`<h2>Reset athlete password</h2><p class="muted" style="font-size:13px">Set a new password and send it to the athlete. They can change it later in the Me tab.</p><form class="stack"><label class="f">New password<input id="rp1" minlength="8" required value="${genPw()}"></label><p class="dmsg" style="margin:0;color:var(--warn)"></p><div class="row"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn primary" type="submit" style="flex:1">Set password</button></div></form>`,
        async f => { const pw = f.querySelector("#rp1").value; await admin({ action: "set_password", user_id: id, password: pw }); try { await navigator.clipboard.writeText(pw); toast("Password set and copied") } catch { toast("Password set") } }); return }
    const ac = e.target.closest("[data-active]"); if (ac) { const id = ac.dataset.active, on = ac.dataset.on === "1"; if (!ac.dataset.arm) { ac.dataset.arm = 1; ac.textContent = on ? "Tap to confirm" : "Tap to reactivate"; return }
      try { await admin({ action: "set_active", user_id: id, active: !on }); toast(on ? "Athlete paused" : "Athlete reactivated"); window.ASCEND.refreshRoster() } catch (err) { toast(err.message) } return }
  });
  document.addEventListener("submit", async e => {
    if (e.target.id !== "addStu") return; e.preventDefault(); const f = e.target, b = f.querySelector("[type=submit]"), out = document.getElementById("as-out");
    const name = f.querySelector("#as-name").value.trim(), email = f.querySelector("#as-email").value.trim(), password = f.querySelector("#as-pw").value;
    if (password.length < 8) { out.textContent = "Use at least 8 characters for the password."; return }
    b.disabled = true; out.textContent = "Creating account…";
    try { await admin({ action: "create", name, email, password }); const card = `Ascend login\nLink: ${location.origin + location.pathname}\nEmail: ${email}\nPassword: ${password}`;
      try { await navigator.clipboard.writeText(card) } catch { }
      window.ASCEND.lastOut = out.innerHTML = `Created <b>${esc(name)}</b>. Login details copied to your clipboard. Send them privately:<pre class="mono" style="white-space:pre-wrap;margin:8px 0 0;user-select:all">${esc(card)}</pre>`; f.reset(); window.ASCEND.refreshRoster() }
    catch (err) { out.textContent = err.message } b.disabled = false;
  });

  /* ---------------- boot ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    if (!configured) { showSetup(); return }
    sb.auth.onAuthStateChange((ev) => { if (ev === "PASSWORD_RECOVERY") showNewPassword(); else if (ev === "SIGNED_IN" && !started) start(); else if (ev === "SIGNED_OUT" && started) location.reload() });
    if (!/type=recovery/.test(location.hash)) start();
  });
})();
