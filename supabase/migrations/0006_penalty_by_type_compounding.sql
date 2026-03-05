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
        -- Real attempts for this day/type if the user submitted.
        select s.attempts
        into v_today_attempts
        from public.submissions s
        where s.group_id = p_group_id
          and s.user_id = p_user_id
          and s.played_on = v_day
          and s.game_type_id = v_game_type.id
        limit 1;

        if v_today_attempts is not null then
          -- A real submission becomes the base for the next day.
          v_effective_by_type := jsonb_set(
            v_effective_by_type,
            array[v_game_type.id::text],
            to_jsonb(v_today_attempts),
            true
          );
        else
          -- Missing type: penalty is previous effective value + 1.
          -- Previous effective value can come from:
          -- 1) a prior day submission, or
          -- 2) a prior day penalty (already stored in the map).
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

          -- Penalty becomes this day's effective value for next day compounding.
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
