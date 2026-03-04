insert into public.game_types(key, label, max_attempts, active)
values
  ('wordle', 'Wordle', 6, true),
  ('frase_del_dia', 'Frase del dia', 6, true)
on conflict (key) do nothing;
