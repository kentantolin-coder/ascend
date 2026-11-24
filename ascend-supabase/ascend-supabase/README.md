# Ascend: Supabase edition

**Rise daily. Never settle.** This is the same Ascend app (daily log, food diary, workouts, program builder, coach console) with **email and password logins** backed by your own Supabase project.

- **Athletes** sign in with the email and password you create for them. They see only their own data.
- **You (the coach)** sign in to see every athlete in **Ascend Command** (`#coach`), send weekly adjustments, reset passwords and pause access.
- Data is protected by row-level security in the database, not just hidden in the app.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The app (built from the artifact by `build.py`) |
| `platform.js` | Login screen and the Supabase data connection |
| `config.js` | **You edit this:** your Supabase URL and anon key |
| `manifest.json`, `icon.svg`, `icon-512.png` | Lets phones install it like an app |
| `supabase/schema.sql` | Tables and security rules. Run once. |
| `supabase/functions/manage-student` | Coach-only: create athlete logins, reset passwords, pause |
| `supabase/functions/ai` | Optional: AI meal estimates and coach message drafts |

## Setup (about 20 minutes)

### 1. Create the Supabase project
1. Sign up at supabase.com and create a new project (the free tier is fine). Save the database password it shows you.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.

### 2. Create your coach login
1. **Authentication → Users → Add user → Create new user.** Enter your email and a strong password, and tick **Auto Confirm User**.
2. Back in **SQL Editor**, run this with your email:
   ```sql
   insert into public.members (user_id, role, name, email)
   select id, 'coach', 'Coach Kent', email from auth.users where email = 'you@example.com'
   on conflict (user_id) do update set role = 'coach', active = true;
   ```
3. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Only accounts you create can log in.

### 3. Deploy the edge functions
Install the Supabase CLI (supabase.com/docs/guides/cli), then from this folder:

```bash
supabase login
```
```bash
supabase link --project-ref YOUR_PROJECT_REF
```
```bash
supabase functions deploy manage-student
```

Optional AI features (meal photo and text estimates, coach message drafts). These use your own Anthropic API key from console.anthropic.com:

```bash
supabase functions deploy ai
```
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key
```

If you skip the AI function, everything else works and the AI buttons show a short notice.

### 4. Connect the app
Open `config.js` and fill in both values from **Project Settings → API**:

```js
window.ASCEND_CONFIG = {
  supabaseUrl: "https://abcdefghijkl.supabase.co",
  supabaseAnonKey: "eyJhbGciOi..."   // the "anon public" key
};
```

The anon key is safe to publish. Never put the **service_role** key in this folder.

### 5. Put it online
Any static host works. The easiest:
- **Netlify Drop:** go to app.netlify.com/drop and drag this whole folder in. You get a link like `https://ascend-xyz.netlify.app`.
- Or **Vercel**, **Cloudflare Pages** or **GitHub Pages**.

Then, in Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that link, so password-reset emails open your app.

### 6. Bring your existing data over
1. In the old claude.ai version, go to **Me → Export backup** and save the JSON file.
2. Sign in to the new app as coach, go to **Me → Import backup**, and pick the file. Your 105 days, measurements and weekly reviews move into your account.

## Daily use

**Add an athlete:** open `#coach`, scroll to **Add an athlete**, and enter their name, email and password (or tap **Generate**). The login details are copied for you to send privately.

**Reset a password or pause an athlete:** open the athlete in the coach console and use the buttons next to their status.

**Athletes change their own password:** **Me → Change password**. They can also use **Forgot password?** on the login screen (needs the Site URL from step 5).

**Install on a phone:** open the link, then use **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android).

## Updating the app

`index.html` is generated from the artifact source. After changing the artifact's `index.html`, rebuild:

```bash
python3 build.py ../ascend100/index.html
```

## How the data is stored

Everything lives in one table, `docs (owner, path, data)`. Each row is one JSON document (a day, a food diary, a workout) owned by one user. The policies in `schema.sql` allow:
- athletes to read and write only rows where `owner` is their own id, while their account is active;
- the coach to read and write all rows (that is how weekly adjustments reach athletes);
- nobody but the `manage-student` function (using the service key on the server) to create accounts or change roles.
