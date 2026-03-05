-- Cleanup migration for duplicated/inconsistent function definitions left in 0002_phase2.sql
-- This migration sets the canonical versions used by the app.

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
  values (
    v_group_id,
    v_user_id,
    coalesce(v_start_points, 0),
    (current_date - interval '1 day')::date,
    now()
  )
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
        select exists (
          select 1
          from public.submissions s
          where s.group_id = p_group_id
            and s.user_id = p_user_id
            and s.played_on = v_day
            and s.game_type_id = v_game_type.id
        ) into v_has_submission;

        if not v_has_submission then
          select s.attempts
          into v_prev_attempts
          from public.submissions s
          where s.group_id = p_group_id
            and s.user_id = p_user_id
            and s.game_type_id = v_game_type.id
            and s.played_on < v_day
          order by s.played_on desc
          limit 1;

          v_penalty_total := v_penalty_total + (coalesce(v_prev_attempts, v_game_type.max_attempts) + 1);
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

  v_through := (current_date - interval '1 day')::date;

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
