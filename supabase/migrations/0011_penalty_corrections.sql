create table if not exists public.group_member_day_corrections (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  played_on date not null,
  game_type_id int not null references public.game_types(id) on delete restrict,
  effective_attempts int not null check (effective_attempts >= 0),
  reason text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id, played_on, game_type_id)
);

create index if not exists idx_group_member_day_corrections_lookup
  on public.group_member_day_corrections(group_id, user_id, played_on);

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
  v_correction_attempts int;
  v_submission_attempts int;
  v_source_attempts int;
  v_prev_effective int;
  v_penalty int;
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

  v_total := coalesce(v_initial_points, 0);

  if v_through >= v_joined_on then
    v_day := v_joined_on;

    while v_day <= v_through loop
      for v_game_type in
        select gt.id, gt.max_attempts
        from public.game_types gt
        where gt.active = true
      loop
        v_source_attempts := null;

        select c.effective_attempts
        into v_correction_attempts
        from public.group_member_day_corrections c
        where c.group_id = p_group_id
          and c.user_id = p_user_id
          and c.played_on = v_day
          and c.game_type_id = v_game_type.id
        limit 1;

        if v_correction_attempts is not null then
          v_source_attempts := v_correction_attempts;
        else
          select s.attempts
          into v_submission_attempts
          from public.submissions s
          where s.group_id = p_group_id
            and s.user_id = p_user_id
            and s.played_on = v_day
            and s.game_type_id = v_game_type.id
          limit 1;

          if v_submission_attempts is not null then
            v_source_attempts := v_submission_attempts;
          end if;
        end if;

        if v_source_attempts is not null then
          v_total := v_total + v_source_attempts;
          v_effective_by_type := jsonb_set(
            v_effective_by_type,
            array[v_game_type.id::text],
            to_jsonb(v_source_attempts),
            true
          );
        elsif v_penalties_enabled then
          v_prev_effective := null;

          if v_effective_by_type ? (v_game_type.id::text) then
            v_prev_effective := (v_effective_by_type ->> (v_game_type.id::text))::int;
          else
            select src.attempts
            into v_prev_effective
            from (
              select s.played_on, s.attempts
              from public.submissions s
              where s.group_id = p_group_id
                and s.user_id = p_user_id
                and s.game_type_id = v_game_type.id
                and s.played_on < v_day
              union all
              select c.played_on, c.effective_attempts as attempts
              from public.group_member_day_corrections c
              where c.group_id = p_group_id
                and c.user_id = p_user_id
                and c.game_type_id = v_game_type.id
                and c.played_on < v_day
            ) src
            order by src.played_on desc
            limit 1;
          end if;

          v_penalty := coalesce(v_prev_effective, v_game_type.max_attempts) + 1;
          v_penalty_total := v_penalty_total + v_penalty;
          v_total := v_total + v_penalty;
          v_effective_by_type := jsonb_set(
            v_effective_by_type,
            array[v_game_type.id::text],
            to_jsonb(v_penalty),
            true
          );
        end if;
      end loop;

      v_day := v_day + 1;
    end loop;
  end if;

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

create or replace function public.set_group_member_day_correction(
  p_group_id uuid,
  p_user_id uuid,
  p_played_on date,
  p_game_type_id int,
  p_effective_attempts int,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_through date;
begin
  if p_effective_attempts < 0 then
    raise exception 'Effective attempts must be >= 0';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can set corrections';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
  ) then
    raise exception 'Member not found in group';
  end if;

  if not exists (
    select 1
    from public.game_types gt
    where gt.id = p_game_type_id
      and gt.active = true
  ) then
    raise exception 'Game type not active';
  end if;

  if p_played_on > public.current_active_day_madrid() then
    raise exception 'Cannot correct future day';
  end if;

  insert into public.group_member_day_corrections (
    group_id, user_id, played_on, game_type_id, effective_attempts, reason, created_by, updated_at
  )
  values (
    p_group_id, p_user_id, p_played_on, p_game_type_id, p_effective_attempts, nullif(trim(coalesce(p_reason, '')), ''), auth.uid(), now()
  )
  on conflict (group_id, user_id, played_on, game_type_id)
  do update set
    effective_attempts = excluded.effective_attempts,
    reason = excluded.reason,
    created_by = auth.uid(),
    updated_at = now();

  v_through := public.current_active_day_madrid() - 1;
  perform public.recalc_member_score(p_group_id, p_user_id, v_through);
end;
$function$;

revoke all on function public.set_group_member_day_correction(uuid, uuid, date, int, int, text) from public;
grant execute on function public.set_group_member_day_correction(uuid, uuid, date, int, int, text) to authenticated;

create or replace function public.clear_group_member_day_correction(
  p_group_id uuid,
  p_user_id uuid,
  p_played_on date,
  p_game_type_id int
)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_through date;
begin
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.role = 'owner'
  ) then
    raise exception 'Only owners can clear corrections';
  end if;

  delete from public.group_member_day_corrections
  where group_id = p_group_id
    and user_id = p_user_id
    and played_on = p_played_on
    and game_type_id = p_game_type_id;

  v_through := public.current_active_day_madrid() - 1;
  perform public.recalc_member_score(p_group_id, p_user_id, v_through);
end;
$function$;

revoke all on function public.clear_group_member_day_correction(uuid, uuid, date, int) from public;
grant execute on function public.clear_group_member_day_correction(uuid, uuid, date, int) to authenticated;

