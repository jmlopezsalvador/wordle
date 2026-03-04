# Wordle Friends MVP

MVP mobile-first para gestionar puntuaciones de `Wordle` y `Frase del dia` entre amigos.

## Stack

- Next.js 15 (App Router) + TypeScript
- Tailwind CSS
- Supabase (Auth con Google + Postgres + RLS)

## Variables de entorno

Copiar `.env.example` a `.env.local` y completar:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (opcional para futuras tareas admin)
- `NEXT_PUBLIC_APP_URL` (ej. `http://localhost:3000`)

## Base de datos

1. Crear proyecto en Supabase.
2. Ejecutar `supabase/migrations/0001_init.sql`.
3. Verificar que existen los tipos de juego en `public.game_types` (o ejecutar `supabase/seed.sql`).
4. En Auth > Providers, activar Google.
5. Configurar redirect URL:
   - `http://localhost:3000/auth/callback`
   - URL de producción equivalente.

## Desarrollo

```bash
npm install
npm run dev
```

## Funcionalidad MVP implementada

- Login con Google.
- Crear grupo y unirse por código.
- Pegar texto de compartir de Wordle/Frase y parsearlo con RegEx.
- Guardar intentos y cuadrícula emoji por día.
- Feed por grupo con cuadrículas.
- Leaderboard acumulado (menor puntuación gana), con penalización por no jugar:
  - Si no hay resultado para un juego en un día: `max_attempts + 2`.
