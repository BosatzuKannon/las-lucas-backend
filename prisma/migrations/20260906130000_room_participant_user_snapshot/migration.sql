-- Snapshot de presentación (name + avatar) en room_participants para que el
-- canal Realtime sea autosuficiente: el payload del INSERT/UPDATE ya trae
-- cómo renderizar el chip sin re-consultar el backend por cada inscripción.

ALTER TABLE "room_participants" ADD COLUMN "user_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "room_participants" ADD COLUMN "user_avatar_url" TEXT;

-- Backfill: poblar las participaciones existentes con los datos actuales de users.
UPDATE "room_participants" rp
SET "user_name" = u."name",
    "user_avatar_url" = u."avatar_url"
FROM "users" u
WHERE u."id" = rp."user_id";