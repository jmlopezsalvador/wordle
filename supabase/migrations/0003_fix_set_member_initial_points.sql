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
