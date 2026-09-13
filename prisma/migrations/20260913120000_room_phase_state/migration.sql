-- AlterTable
-- Deadlines de fase calculados + avance de preguntas persistido.
-- `start_time` permanece inmutable (es la hora programada del torneo).
ALTER TABLE "rooms" ADD COLUMN "waiting_closes_at" TIMESTAMP(3),
ADD COLUMN "voting_closes_at" TIMESTAMP(3),
ADD COLUMN "question_cursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "survival_mode" BOOLEAN NOT NULL DEFAULT false;