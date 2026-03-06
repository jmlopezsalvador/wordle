-- Day-boundary migration: active day changes at 06:00 Europe/Madrid.

create or replace function public.current_active_day_madrid()
returns date
language sql
stable
set search_path = public
as $function$
  select
    case
      when (now() at time zone 'Europe/Madrid')::time < time '06:00:00'
        then ((now() at time zone 'Europe/Madrid')::date - 1)
      else (now() at time zone 'Europe/Madrid')::date
    end;
$function$;

revoke all on function public.current_active_day_madrid() from public;
grant execute on function public.current_active_day_madrid() to authenticated;

create or replace function public.create_group(p_name text, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_user_id uuid;
  v_group_id uuid;
  v_last_closed_day date;
begin
  v_user_id := auth.uid();
  v_last_closed_day := public.current_active_day_madrid() - 1;

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
  values (v_group_id, v_user_id, 0, v_last_closed_day, now())
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$function$;

create or replace function public.join_group_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_user_id uuid;
  v_group_id uuid;
  v_start_points int := 0;
  v_last_closed_day date;
begin
  v_user_id := auth.uid();
  v_last_closed_day := public.current_active_day_madrid() - 1;

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
  values (v_group_id, v_user_id, coalesce(v_start_points, 0), v_last_closed_day, now())
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$function$;

revoke all on function public.join_group_by_code(text) from public;
grant execute on function public.join_group_by_code(text) to authenticated;

create or replace function public.recalc_member_score(p_group_id uuid, p_user_id uuid, p_through date default current_date)
returns int
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_joined_on date;
  v_initial_points int := 0;
  v_total int := 0;
  v_penalty_total int := 0;
  v_day date;
  v_through date;
  v_penalties_enabled boolean := true;
  v_game_type record;
  v_today_attempts int;
  v_prev_effective int;
  v_effective_by_type jsonb := '{}'::jsonb;
  v_last_closed_day date;
begin
  v_last_closed_day := public.current_active_day_madrid() - 1;
  v_through := least(coalesce(p_through, public.current_active_day_madrid()), v_last_closed_day);

  select gm.joined_at::date, gm.initial_points
  into v_joined_on, v_initial_points
  from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_user_id;

  if v_joined_on is null then
    raise exception 'Member not found in group';
  end if;

  select grp.penalties_enabled
  into v_penalties_enabled
  from public.groups grp
  where grp.id = p_group_id;

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
      for v_game_type in
        select gt.id, gt.max_attempts
        from public.game_types gt
        where gt.active = true
      loop
        select s.attempts
        into v_today_attempts
        from public.submissions s
        where s.group_id = p_group_id
          and s.user_id = p_user_id
          and s.played_on = v_day
          and s.game_type_id = v_game_type.id
        limit 1;

        if v_today_attempts is not null then
          v_effective_by_type := jsonb_set(
            v_effective_by_type,
            array[v_game_type.id::text],
            to_jsonb(v_today_attempts),
            true
          );
        else
          v_prev_effective := null;

          if v_effective_by_type ? (v_game_type.id::text) then
            v_prev_effective := (v_effective_by_type ->> (v_game_type.id::text))::int;
          else
            select s.attempts
            into v_prev_effective
            from public.submissions s
            where s.group_id = p_group_id
              and s.user_id = p_user_id
              and s.game_type_id = v_game_type.id
              and s.played_on < v_day
            order by s.played_on desc
            limit 1;
          end if;

          v_today_attempts := coalesce(v_prev_effective, v_game_type.max_attempts) + 1;
          v_penalty_total := v_penalty_total + v_today_attempts;

          v_effective_by_type := jsonb_set(
            v_effective_by_type,
            array[v_game_type.id::text],
            to_jsonb(v_today_attempts),
            true
          );
        end if;
      end loop;

      v_day := v_day + 1;
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
$function$;

revoke all on function public.recalc_member_score(uuid, uuid, date) from public;
grant execute on function public.recalc_member_score(uuid, uuid, date) to authenticated;

create or replace function public.recalc_group_if_needed(p_group_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
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

  v_target_day := public.current_active_day_madrid() - 1;

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
$function$;

revoke all on function public.recalc_group_if_needed(uuid) from public;
grant execute on function public.recalc_group_if_needed(uuid) to authenticated;

create or replace function public.set_group_member_initial_points(p_group_id uuid, p_user_id uuid, p_points integer)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_through date;
  v_actor_id uuid;
  v_group_exists boolean;
  v_is_owner boolean;
  v_target_member_exists boolean;
begin
  v_actor_id := auth.uid();

  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_points < 0 then
    raise exception 'Initial points must be >= 0';
  end if;

  select exists (
    select 1
    from public.groups g
    where g.id = p_group_id
  ) into v_group_exists;

  if not v_group_exists then
    raise exception 'Group not found: %', p_group_id;
  end if;

  select (
    exists (
      select 1
      from public.group_members gm
      where gm.group_id = p_group_id
        and gm.user_id = v_actor_id
        and gm.role = 'owner'
    )
    or exists (
      select 1
      from public.groups g
      where g.id = p_group_id
        and g.owner_id = v_actor_id
    )
  ) into v_is_owner;

  if not v_is_owner then
    raise exception 'Only owners can set member initial points (actor=% group=%)', v_actor_id, p_group_id;
  end if;

  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
  ) into v_target_member_exists;

  if not v_target_member_exists then
    raise exception 'Member not found in group (group=% user=%)', p_group_id, p_user_id;
  end if;

  update public.group_members
  set initial_points = p_points
  where group_id = p_group_id
    and user_id = p_user_id;

  v_through := public.current_active_day_madrid() - 1;

  begin
    perform public.recalc_member_score(p_group_id, p_user_id, v_through);
  exception
    when others then
      raise exception 'recalc_member_score failed: %', sqlerrm;
  end;
end;
$function$;

revoke all on function public.set_group_member_initial_points(uuid, uuid, integer) from public;
grant execute on function public.set_group_member_initial_points(uuid, uuid, integer) to authenticated;

create or replace function public.reset_group_season(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_last_closed_day date := public.current_active_day_madrid() - 1;
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
  select gm.group_id, gm.user_id, 0, v_last_closed_day, now()
  from public.group_members gm
  where gm.group_id = p_group_id
  on conflict (group_id, user_id)
  do update set
    total_points = 0,
    calculated_through = excluded.calculated_through,
    updated_at = now();

  update public.groups
  set last_group_recalc_on = v_last_closed_day
  where id = p_group_id;
end;
$function$;

revoke all on function public.reset_group_season(uuid) from public;
grant execute on function public.reset_group_season(uuid) to authenticated;
