-- Ascend database schema. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run.

-- Who can use the app, and their role. Rows are created by the manage-student edge function
-- (and once by hand for the coach, see the bottom of this file).
create table if not exists public.members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'student' check (role in ('coach', 'student')),
  name       text not null default '',
  email      text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Every piece of app data is one JSON document, owned by one user.
-- path examples: app/profile, days/2026-05-10, food/2026-05-10, workouts/w123, adjust/2026-11-30, roster
create table if not exists public.docs (
  owner      uuid not null references auth.users(id) on delete cascade,
  path       text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner, path)
);
create index if not exists docs_path_idx on public.docs (path);

-- true when the signed-in user is an active coach
create or replace function public.is_coach() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'coach' and active);
$$;

-- true when the signed-in user is an active member (paused athletes lose access)
create or replace function public.is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and active);
$$;

alter table public.members enable row level security;
alter table public.docs    enable row level security;

-- members: you can read your own row; the coach reads everyone. No client writes (edge function only).
drop policy if exists "members read" on public.members;
create policy "members read" on public.members for select
  using (user_id = auth.uid() or public.is_coach());

-- docs: athletes read and write only their own documents; the coach reads and writes all.
drop policy if exists "docs read"   on public.docs;
drop policy if exists "docs insert" on public.docs;
drop policy if exists "docs update" on public.docs;
drop policy if exists "docs delete" on public.docs;
create policy "docs read"   on public.docs for select
  using ((owner = auth.uid() and public.is_active_member()) or public.is_coach());
create policy "docs insert" on public.docs for insert
  with check ((owner = auth.uid() and public.is_active_member()) or public.is_coach());
create policy "docs update" on public.docs for update
  using ((owner = auth.uid() and public.is_active_member()) or public.is_coach())
  with check ((owner = auth.uid() and public.is_active_member()) or public.is_coach());
create policy "docs delete" on public.docs for delete
  using ((owner = auth.uid() and public.is_active_member()) or public.is_coach());

-- live updates (realtime respects the policies above)
alter table public.docs replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.docs;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------------
-- MAKE YOURSELF THE COACH (run after creating your own user in Authentication -> Users).
-- Replace the email, then run just this statement:
--
-- insert into public.members (user_id, role, name, email)
-- select id, 'coach', 'Coach Kent', email from auth.users where email = 'you@example.com'
-- on conflict (user_id) do update set role = 'coach', active = true;
