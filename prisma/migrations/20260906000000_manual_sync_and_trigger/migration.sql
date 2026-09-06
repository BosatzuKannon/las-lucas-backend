-- 1. Sincronizar columnas faltantes en rooms
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS current_players INT DEFAULT 0;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS max_players INT DEFAULT 50;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS normal_question_count INT DEFAULT 15;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS normal_question_duration INT DEFAULT 7;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS survival_question_duration INT DEFAULT 4;

-- 2. Sincronizar columnas faltantes en users
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;

-- 3. Crear el puente de Autenticación (Trigger)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, google_id, email, name, avatar_url, updated_at)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'sub', new.raw_user_meta_data->>'provider_id', new.id::text),
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Usuario'),
    new.raw_user_meta_data->>'avatar_url',
    now()
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Conectar el Trigger a Supabase Auth
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();