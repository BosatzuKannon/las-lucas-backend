-- Habilitar Postgres Realtime para la tabla de rooms (Supabase).
-- Estos comandos NO son transaccionales y deben ejecutarse como superusuario postgres
-- (p. ej. desde el SQL Editor de Supabase). No se incluyen en la migración prisma normal
-- porque ALTER PUBLICATION no se puede ejecutar dentro de una transacción.

ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER TABLE public.rooms REPLICA IDENTITY FULL;
