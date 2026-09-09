-- AlterTable
ALTER TABLE "room_participants" ADD COLUMN     "eliminated_at_question" INTEGER,
ADD COLUMN     "position" INTEGER,
ADD COLUMN     "prize_won" DOUBLE PRECISION NOT NULL DEFAULT 0,
ALTER COLUMN "user_name" DROP DEFAULT;
