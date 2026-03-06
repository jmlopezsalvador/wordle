-- Ensure Telegram reminders are enabled by default for linked users.

-- Backfill existing memberships for linked users.
insert into public.telegram_group_reminders (telegram_user_id, group_id, enabled, hour_local, minute_local, updated_at)
select
  tul.telegram_user_id,
  gm.group_id,
  true,
  12,
  0,
  now()
from public.telegram_user_links tul
join public.group_members gm on gm.user_id = tul.app_user_id
on conflict (telegram_user_id, group_id)
do update set
  enabled = true,
  updated_at = now();

create or replace function public.ensure_telegram_reminder_on_group_member_insert()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $function$
declare
  v_telegram_user_id bigint;
begin
  select tul.telegram_user_id
  into v_telegram_user_id
  from public.telegram_user_links tul
  where tul.app_user_id = new.user_id
  limit 1;

  if v_telegram_user_id is null then
    return new;
  end if;

  insert into public.telegram_group_reminders (telegram_user_id, group_id, enabled, hour_local, minute_local, updated_at)
  values (v_telegram_user_id, new.group_id, true, 12, 0, now())
  on conflict (telegram_user_id, group_id)
  do update set
    enabled = true,
    updated_at = now();

  return new;
end;
$function$;

drop trigger if exists trg_group_members_enable_telegram_reminders on public.group_members;
create trigger trg_group_members_enable_telegram_reminders
after insert on public.group_members
for each row
execute function public.ensure_telegram_reminder_on_group_member_insert();

