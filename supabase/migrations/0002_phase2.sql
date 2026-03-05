alter table public.groups add column if not exists penalties_enabled boolean not null default true;
alter table public.groups add column if not exists new_member_start_points int not null default 0;
alter table public.groups add column if not exists last_group_recalc_on date;

alter table public.groups drop constraint if exists groups_new_member_start_points_check;
alter table public.groups
  add constraint groups_new_member_start_points_check
  check (new_member_start_points >= 0);

alter table public.group_members add column if not exists initial_points int not null default 0;
alter table public.group_members drop constraint if exists group_members_initial_points_check;
alter table public.group_members
  add constraint group_members_initial_points_check
  check (initial_points >= 0);

alter table public.group_comments
  add column if not exists parent_comment_id uuid references public.group_comments(id) on delete cascade;

create index if not exists idx_group_comments_parent on public.group_comments(parent_comment_id);

drop policy if exists "Users can insert own memberships" on public.group_members;
create policy "Users can insert own memberships"
on public.group_members for insert
with check (auth.uid() = user_id and role = 'member');

drop policy if exists "Users can upsert own memberships" on public.group_members;
create policy "Users can upsert own memberships"
on public.group_members for update
using (auth.uid() = user_id and role = 'member')
with check (auth.uid() = user_id and role = 'member');

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

  insert into public.groups (name, code, owner_id, penalties_enabled, new_member_start_points)
  values (p_name, p_code, v_user_id, true, 0)
  returning id into v_group_id;

  insert into public.group_members (group_id, user_id, role, initial_points)
  values (v_group_id, v_user_id, 'owner', 0)
  on conflict (group_id, user_id)
  do update set role = excluded.role;

  insert into public.member_scores (group_id, user_id, total_points, calculated_through, updated_at)
  values (v_group_id, v_user_id, 0, (current_date - interval '1 day')::date, now())
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

create or replace function public.join_group_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_group_id uuid;
  v_start_points int := 0;
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

  select g.id, g.new_member_start_points
  into v_group_id, v_start_points
  from public.groups g
  where upper(g.code) = upper(p_code)
  limit 1;

  if v_group_id is null then
    return null;
  end if;

  insert into public.group_members (group_id, user_id, role, initial_points)
  values (v_group_id, v_user_id, 'member', coalesce(v_start_points, 0))
  on conflict (group_id, user_id) do nothing;

  insert into public.member_scores (group_id, user_id, total_points, calculated_through, updated_at)
  values (v_group_id, v_user_id, coalesce(v_start_points, 0), (current_date - interval '1 day')::date, now())
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

create or replace function public.recalc_member_score(p_group_id uuid, p_user_id uuid, p_through date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_joined_on date;
  v_initial_points int := 0;
  v_total int := 0;
  v_penalty_total int := 0;
  v_day date;
  v_through date;
  v_penalties_enabled boolean := true;
  g record;
  v_has_submission boolean;
  v_prev_attempts int;
begin
  v_through := least(coalesce(p_through, current_date), (current_date - interval '1 day')::date);

  select gm.joined_at::date, gm.initial_points
  into v_joined_on, v_initial_points
  from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_user_id;

  if v_joined_on is null then
    raise exception 'Member not found in group';
  end if;

  select g.penalties_enabled into v_penalties_enabled
  from public.groups g
  where g.id = p_group_id;

  if v_penalties_enabled is null then
    raise exception 'Group not found';
  end if;

  select coalesce(sum(s.attempts), 0)
  into v_total
  from public.submissions s
  where s.group_id = p_group_id
    and s.user_id = p_user_id
    and s.played_on <= v_through;

  v_total := v_total + coalesce(v_initial_points, 0);

  if v_penalties_enabled and v_through >= v_joined_on then
    v_day := v_joined_on;
    while v_day <= v_through loop
      for g in
        select gt.id, gt.max_attempts
        from public.game_types gt
        where gt.active = true
      loop
        select exists (
          select 1
          from public.submissions s
          where s.group_id = p_group_id
            and s.user_id = p_user_id
            and s.played_on = v_day
            and s.game_type_id = g.id
        ) into v_has_submission;

        if not v_has_submission then
          select s.attempts
          into v_prev_attempts
          from public.submissions s
          where s.group_id = p_group_id
            and s.user_id = p_user_id
            and s.game_type_id = g.id
            and s.played_on < v_day
          order by s.played_on desc
          limit 1;

          v_penalty_total := v_penalty_total + (coalesce(v_prev_attempts, g.max_attempts) + 1);
        end if;
      end loop;

      v_day := v_day + interval '1 day';
    end loop;
  end if;

  v_total := v_total + v_penalty_total;

  insert into public.member_scores (group_id, user_id, total_points, calculated_through, updated_at)
  values (p_group_id, p_user_id, v_total, v_through, now())
  on conflict (group_id, user_id)
  do update set
    total_points = excluded.total_points,
    calculated_through = excluded.calculated_through,
    updated_at = now();

  return v_total;
end;
$$;

create or replace function public.recalc_group_if_needed(p_group_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_target_day date;
  v_last date;
  m record;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = v_user_id
  ) then
    raise exception 'Only group members can trigger recalc';
  end if;

  v_target_day := (current_date - interval '1 day')::date;

  select g.last_group_recalc_on into v_last
  from public.groups g
  where g.id = p_group_id;

  if v_last is not null and v_last >= v_target_day then
    return false;
  end if;

  for m in
    select gm.user_id
    from public.group_members gm
    where gm.group_id = p_group_id
  loop
    perform public.recalc_member_score(p_group_id, m.user_id, v_target_day);
  end loop;

  update public.groups
  set last_group_recalc_on = v_target_day
  where id = p_group_id;

  return true;
end;
$$;

revoke all on function public.recalc_group_if_needed(uuid) from public;
grant execute on function public.recalc_group_if_needed(uuid) to authenticated;

create or replace function public.set_group_penalties_enabled(p_group_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can change penalties setting';
  end if;

  update public.groups
  set penalties_enabled = p_enabled
  where id = p_group_id;
end;
$$;

revoke all on function public.set_group_penalties_enabled(uuid, boolean) from public;
grant execute on function public.set_group_penalties_enabled(uuid, boolean) to authenticated;

create or replace function public.set_group_new_member_start_points(p_group_id uuid, p_points int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_points < 0 then
    raise exception 'Initial points must be >= 0';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can change initial points setting';
  end if;

  update public.groups
  set new_member_start_points = p_points
  where id = p_group_id;
end;
$$;

revoke all on function public.set_group_new_member_start_points(uuid, int) from public;
grant execute on function public.set_group_new_member_start_points(uuid, int) to authenticated;

create or replace function public.promote_group_member_to_owner(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary_owner uuid;
begin
  select g.owner_id into v_primary_owner
  from public.groups g
  where g.id = p_group_id;

  if v_primary_owner is null then
    raise exception 'Group not found';
  end if;

  if auth.uid() <> v_primary_owner then
    raise exception 'Only primary owner can promote co-owners';
  end if;

  update public.group_members
  set role = 'owner'
  where group_id = p_group_id
    and user_id = p_user_id;

  if not found then
    raise exception 'Member not found';
  end if;
end;
$$;

revoke all on function public.promote_group_member_to_owner(uuid, uuid) from public;
grant execute on function public.promote_group_member_to_owner(uuid, uuid) to authenticated;

create or replace function public.reset_group_season(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := current_date;
begin
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can reset season';
  end if;

  update public.group_members
  set joined_at = now(),
      initial_points = 0
  where group_id = p_group_id;

  insert into public.member_scores (group_id, user_id, total_points, calculated_through, updated_at)
  select gm.group_id, gm.user_id, 0, (v_today - interval '1 day')::date, now()
  from public.group_members gm
  where gm.group_id = p_group_id
  on conflict (group_id, user_id)
  do update set
    total_points = 0,
    calculated_through = excluded.calculated_through,
    updated_at = now();

  update public.groups
  set last_group_recalc_on = (v_today - interval '1 day')::date
  where id = p_group_id;
end;
$$;

revoke all on function public.reset_group_season(uuid) from public;
grant execute on function public.reset_group_season(uuid) to authenticated;

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

  select g.id
  into v_group_id
  from public.groups g
  where upper(g.code) = upper(p_code)
  limit 1;

  if v_group_id is null then
    return null;
  end if;

  insert into public.group_members (group_id, user_id, role, initial_points)
  values (v_group_id, v_user_id, 'member', 0)
  on conflict (group_id, user_id) do nothing;

  insert into public.member_scores (group_id, user_id, total_points, calculated_through, updated_at)
  values (v_group_id, v_user_id, 0, (current_date - interval '1 day')::date, now())
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

create or replace function public.set_group_member_initial_points(p_group_id uuid, p_user_id uuid, p_points int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_through date;
begin
  if p_points < 0 then
    raise exception 'Initial points must be >= 0';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can set member initial points';
  end if;

  update public.group_members
  set initial_points = p_points
  where group_id = p_group_id
    and user_id = p_user_id;

  if not found then
    raise exception 'Member not found';
  end if;

  v_through := (current_date - interval '1 day')::date;
  perform public.recalc_member_score(p_group_id, p_user_id, v_through);
end;
$$;

revoke all on function public.set_group_member_initial_points(uuid, uuid, int) from public;
grant execute on function public.set_group_member_initial_points(uuid, uuid, int) to authenticated;

create or replace function public.demote_group_owner_to_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can demote owners';
  end if;

  if exists (
    select 1
    from public.groups g
    where g.id = p_group_id
      and g.owner_id = p_user_id
  ) then
    raise exception 'Primary owner cannot be demoted';
  end if;

  update public.group_members
  set role = 'member'
  where group_id = p_group_id
    and user_id = p_user_id
    and role = 'owner';

  if not found then
    raise exception 'Owner member not found';
  end if;
end;
$$;

revoke all on function public.demote_group_owner_to_member(uuid, uuid) from public;
grant execute on function public.demote_group_owner_to_member(uuid, uuid) to authenticated;
