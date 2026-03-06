create table if not exists public.telegram_link_tokens (
  token text primary key,
  app_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists idx_telegram_link_tokens_user on public.telegram_link_tokens(app_user_id);
create index if not exists idx_telegram_link_tokens_expires on public.telegram_link_tokens(expires_at);

create table if not exists public.telegram_user_links (
  telegram_user_id bigint primary key,
  app_user_id uuid not null unique references public.profiles(id) on delete cascade,
  telegram_username text,
  first_name text,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_telegram_user_links_app_user on public.telegram_user_links(app_user_id);

create table if not exists public.telegram_group_reminders (
  telegram_user_id bigint not null references public.telegram_user_links(telegram_user_id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  enabled boolean not null default true,
  hour_local smallint not null default 21,
  minute_local smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (telegram_user_id, group_id),
  constraint telegram_group_reminders_hour_check check (hour_local between 0 and 23),
  constraint telegram_group_reminders_minute_check check (minute_local between 0 and 59)
);

create index if not exists idx_telegram_group_reminders_time
  on public.telegram_group_reminders(enabled, hour_local, minute_local);
