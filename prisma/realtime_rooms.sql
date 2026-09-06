-- Habilitar Postgres Realtime para la tabla de rooms (Supabase).
-- Estos comandos NO son transaccionales y deben ejecutarse como superusuario postgres
-- (p. ej. desde el SQL Editor de Supabase). No se incluyen en la migración prisma normal
-- porque ALTER PUBLICATION no se puede ejecutar dentro de una transacción.

ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER TABLE public.rooms REPLICA IDENTITY FULL;


ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
ALTER TABLE public.users REPLICA IDENTITY FULL;


ALTER PUBLICATION supabase_realtime ADD TABLE public.room_participants;
ALTER TABLE public.room_participants REPLICA IDENTITY FULL;

-- 1. Limpiar políticas a medias para evitar errores de duplicidad
DROP POLICY IF EXISTS "Users can read own profile" ON public.users;
DROP POLICY IF EXISTS "Rooms are readable by everyone" ON public.rooms;
DROP POLICY IF EXISTS "Participants are readable by everyone" ON public.room_participants;

-- 2. Habilitar RLS en las tablas
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_participants ENABLE ROW LEVEL SECURITY;

-- 3. Crear políticas con el casteo correcto (::text)
CREATE POLICY "Users can read own profile" ON public.users FOR SELECT USING (auth.uid()::text = id);
CREATE POLICY "Rooms are readable by everyone" ON public.rooms FOR SELECT USING (true);
CREATE POLICY "Participants are readable by everyone" ON public.room_participants FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can read own profile" ON public.users;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own profile" ON public.users FOR SELECT USING (auth.uid()::text = id);