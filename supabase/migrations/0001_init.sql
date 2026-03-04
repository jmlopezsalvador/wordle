create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  icon_url text,
  entry_mode text not null default 'daily' check (entry_mode in ('daily', 'history')),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table public.groups add column if not exists icon_url text;
alter table public.groups add column if not exists entry_mode text not null default 'daily';

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.game_types (
  id smallserial primary key,
  key text not null unique,
  label text not null,
  max_attempts int not null,
  active boolean not null default true
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_type_id smallint not null references public.game_types(id) on delete restrict,
  game_edition int not null,
  played_on date not null,
  attempts int not null,
  is_failure boolean not null default false,
  raw_share_text text not null,
  grid_rows text[] not null,
  created_at timestamptz not null default now(),
  unique (group_id, user_id, game_type_id, played_on)
);

create index if not exists idx_submissions_group_date on public.submissions(group_id, played_on desc);
create index if not exists idx_submissions_group_user on public.submissions(group_id, user_id);

insert into public.game_types(key, label, max_attempts, active)
values
  ('wordle', 'Wordle', 6, true),
  ('frase_del_dia', 'Frase del dia', 6, true)
on conflict (key) do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (new.id, split_part(new.email, '@', 1), new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.game_types enable row level security;
alter table public.submissions enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.group_members to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.game_types to authenticated;
grant select, insert, update on public.submissions to authenticated;

drop policy if exists "Profiles are viewable by authenticated users" on public.profiles;
create policy "Profiles are viewable by authenticated users"
on public.profiles for select
using (auth.role() = 'authenticated');

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update
using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
on public.profiles for insert
with check (auth.uid() = id);

drop policy if exists "Members can view groups" on public.groups;
drop policy if exists "Authenticated users can create groups" on public.groups;
drop policy if exists "Users can update own groups" on public.groups;
drop policy if exists "Users can delete own groups" on public.groups;
create policy "Members can view groups"
on public.groups for select
using (
  exists (
    select 1 from public.group_members gm
    where gm.group_id = id and gm.user_id = auth.uid()
  )
);

create policy "Authenticated users can create groups"
on public.groups for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Users can update own groups"
on public.groups for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Users can delete own groups"
on public.groups for delete
to authenticated
using (owner_id = auth.uid());

drop policy if exists "Users can switch own group mode" on public.groups;
create policy "Users can switch own group mode"
on public.groups for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Members can view memberships" on public.group_members;
create policy "Authenticated can view memberships"
on public.group_members for select
using (auth.role() = 'authenticated');

drop policy if exists "Users can insert own memberships" on public.group_members;
create policy "Users can insert own memberships"
on public.group_members for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can upsert own memberships" on public.group_members;
create policy "Users can upsert own memberships"
on public.group_members for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Game types visible to authenticated" on public.game_types;
create policy "Game types visible to authenticated"
on public.game_types for select
using (auth.role() = 'authenticated');

drop policy if exists "Members can read submissions" on public.submissions;
create policy "Members can read submissions"
on public.submissions for select
using (
  exists (
    select 1 from public.group_members gm
    where gm.group_id = group_id and gm.user_id = auth.uid()
  )
);

drop policy if exists "Users manage own submissions in their groups" on public.submissions;
create policy "Users manage own submissions in their groups"
on public.submissions for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.group_members gm
    where gm.group_id = group_id and gm.user_id = auth.uid()
  )
);

drop policy if exists "Users update own submissions" on public.submissions;
create policy "Users update own submissions"
on public.submissions for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.create_group(p_name text, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_group_id uuid;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.profiles (id, username, avatar_url)
  select
    u.id,
    split_part(u.email, '@', 1),
    u.raw_user_meta_data ->> 'avatar_url'
  from auth.users u
  where u.id = v_user_id
  on conflict (id) do nothing;

  insert into public.groups (name, code, owner_id)
  values (p_name, p_code, v_user_id)
  returning id into v_group_id;

  insert into public.group_members (group_id, user_id, role)
  values (v_group_id, v_user_id, 'owner')
  on conflict (group_id, user_id) do update set role = excluded.role;

  return v_group_id;
end;
$$;

revoke all on function public.create_group(text, text) from public;
grant execute on function public.create_group(text, text) to authenticated;

create or replace function public.join_group_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_group_id uuid;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.profiles (id, username, avatar_url)
  select
    u.id,
    split_part(u.email, '@', 1),
    u.raw_user_meta_data ->> 'avatar_url'
  from auth.users u
  where u.id = v_user_id
  on conflict (id) do nothing;

  select g.id into v_group_id
  from public.groups g
  where upper(g.code) = upper(p_code)
  limit 1;

  if v_group_id is null then
    return null;
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_group_id, v_user_id, 'member')
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

revoke all on function public.join_group_by_code(text) from public;
grant execute on function public.join_group_by_code(text) to authenticated;

create table if not exists public.member_scores (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  total_points int not null default 0,
  calculated_through date not null default current_date,
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.member_scores enable row level security;
grant select, insert, update on public.member_scores to authenticated;

drop policy if exists "Members can read member scores" on public.member_scores;
create policy "Members can read member scores"
on public.member_scores for select
using (
  exists (
    select 1 from public.group_members gm
    where gm.group_id = group_id and gm.user_id = auth.uid()
  )
);

drop policy if exists "Users can write own member score" on public.member_scores;
create policy "Users can write own member score"
on public.member_scores for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own member score" on public.member_scores;
create policy "Users can update own member score"
on public.member_scores for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.recalc_member_score(p_group_id uuid, p_user_id uuid, p_through date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_joined_on date;
  v_day date;
  v_total int := 0;
  v_day_attempts int;
begin
  select gm.joined_at::date into v_joined_on
  from public.group_members gm
  where gm.group_id = p_group_id and gm.user_id = p_user_id;

  if v_joined_on is null then
    raise exception 'Member not found in group';
  end if;

  if p_through < v_joined_on then
    v_total := 0;
  else
    v_day := v_joined_on;
    while v_day <= p_through loop
      select coalesce(sum(s.attempts), 0) into v_day_attempts
      from public.submissions s
      where s.group_id = p_group_id
        and s.user_id = p_user_id
        and s.played_on = v_day;

      if v_day_attempts > 0 then
        v_total := v_total + v_day_attempts;
      else
        v_total := v_total + 2;
      end if;

      v_day := v_day + interval '1 day';
    end loop;
  end if;

  insert into public.member_scores(group_id, user_id, total_points, calculated_through, updated_at)
  values (p_group_id, p_user_id, v_total, p_through, now())
  on conflict (group_id, user_id)
  do update set
    total_points = excluded.total_points,
    calculated_through = excluded.calculated_through,
    updated_at = now();

  return v_total;
end;
$$;

revoke all on function public.recalc_member_score(uuid, uuid, date) from public;
grant execute on function public.recalc_member_score(uuid, uuid, date) to authenticated;

create or replace function public.recalc_group_scores(p_group_id uuid, p_through date default current_date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  m record;
begin
  select g.owner_id into v_owner
  from public.groups g
  where g.id = p_group_id;

  if v_owner is null then
    raise exception 'Group not found';
  end if;

  if auth.uid() <> v_owner then
    raise exception 'Only owner can recalc group scores';
  end if;

  for m in
    select gm.user_id
    from public.group_members gm
    where gm.group_id = p_group_id
  loop
    perform public.recalc_member_score(p_group_id, m.user_id, p_through);
  end loop;
end;
$$;

revoke all on function public.recalc_group_scores(uuid, date) from public;
grant execute on function public.recalc_group_scores(uuid, date) to authenticated;

create or replace function public.remove_group_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select g.owner_id into v_owner
  from public.groups g
  where g.id = p_group_id;

  if v_owner is null then
    raise exception 'Group not found';
  end if;

  if auth.uid() <> v_owner then
    raise exception 'Only owner can remove members';
  end if;

  if p_user_id = v_owner then
    raise exception 'Owner cannot be removed';
  end if;

  delete from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_user_id;

  delete from public.member_scores ms
  where ms.group_id = p_group_id
    and ms.user_id = p_user_id;
end;
$$;

revoke all on function public.remove_group_member(uuid, uuid) from public;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

create table if not exists public.group_comments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  comment_date date not null,
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);

create index if not exists idx_group_comments_group_date on public.group_comments(group_id, comment_date desc, created_at desc);

alter table public.group_comments enable row level security;
grant select, insert, update, delete on public.group_comments to authenticated;

drop policy if exists "Members can read comments" on public.group_comments;
create policy "Members can read comments"
on public.group_comments for select
using (
  exists (
    select 1
    from public.group_members gm
    where gm.group_id = group_id
      and gm.user_id = auth.uid()
  )
);

drop policy if exists "Members can write own comments" on public.group_comments;
create policy "Members can write own comments"
on public.group_comments for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.group_members gm
    where gm.group_id = group_id
      and gm.user_id = auth.uid()
  )
);

drop policy if exists "Authors can update own comments" on public.group_comments;
create policy "Authors can update own comments"
on public.group_comments for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Owners can update group comments" on public.group_comments;
create policy "Owners can update group comments"
on public.group_comments for update
using (
  exists (
    select 1
    from public.groups g
    where g.id = group_comments.group_id
      and g.owner_id = auth.uid()
  )
)
with check (true);

drop policy if exists "Authors can delete own comments" on public.group_comments;
create policy "Authors can delete own comments"
on public.group_comments for delete
using (auth.uid() = user_id);

drop policy if exists "Owners can delete group comments" on public.group_comments;
create policy "Owners can delete group comments"
on public.group_comments for delete
using (
  exists (
    select 1
    from public.groups g
    where g.id = group_comments.group_id
      and g.owner_id = auth.uid()
  )
);
