-- Votación de categoría en vivo (fase VOTING).
-- Agrega el estado VOTING al enum RoomStatus, el voto del participante
-- (voted_category_id + voted_at para desempate) y la categoría ganadora de la sala.

-- AlterEnum: agregar VOTING al enum RoomStatus
ALTER TYPE "RoomStatus" ADD VALUE 'VOTING';

-- RoomParticipant: voto del usuario
ALTER TABLE "room_participants" ADD COLUMN "voted_category_id" TEXT;
ALTER TABLE "room_participants" ADD COLUMN "voted_at" TIMESTAMP(3);

-- Room: categoría seleccionada al cerrar la votación
ALTER TABLE "rooms" ADD COLUMN "selected_category_id" TEXT;