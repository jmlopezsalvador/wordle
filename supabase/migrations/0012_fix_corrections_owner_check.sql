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
  )
  and not exists (
    select 1
    from public.groups g
    where g.id = p_group_id
      and g.owner_id = auth.uid()
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
  )
  and not exists (
    select 1
    from public.groups g
    where g.id = p_group_id
      and g.owner_id = auth.uid()
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
