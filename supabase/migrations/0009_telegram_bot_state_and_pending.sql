create table if not exists public.telegram_user_state (
  telegram_user_id bigint primary key references public.telegram_user_links(telegram_user_id) on delete cascade,
  active_group_id uuid references public.groups(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_telegram_user_state_active_group on public.telegram_user_state(active_group_id);

create table if not exists public.telegram_pending_actions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.telegram_user_links(telegram_user_id) on delete cascade,
  app_user_id uuid not null references public.profiles(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint telegram_pending_actions_type_check check (action_type in ('submit','comment'))
);

create index if not exists idx_telegram_pending_actions_user on public.telegram_pending_actions(telegram_user_id, created_at desc);
create index if not exists idx_telegram_pending_actions_expires on public.telegram_pending_actions(expires_at);
