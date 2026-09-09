import { Injectable, Logger } from '@nestjs/common';
import {
  Question,
  RoomStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const LATENCY_MARGIN_MS = 500;
export const QUESTION_RESULTS_GRACE_MS = 5_000;
export const DEFAULT_QUESTION_DURATION_MS = 7_000;

export interface ActiveQuestionState {
  roomId: string;
  questionId: string;
  text: string;
  options: string[];
  correctAnswer: string;
  endTime: number;
  answers: Map<string, string>;
  extraLifeByUser: Map<string, boolean>;
}

export interface QuestionStartedPayload {
  questionId: string;
  text: string;
  options: string[];
  endTime: number;
}

export interface QuestionStarted {
  questionId: string;
  payload: QuestionStartedPayload;
  correctAnswer: string;
  endTime: number;
  finishAt: number;
}

export interface QuestionResultsPayload {
  questionId: string;
  correctAnswer: string;
  correctCount: number;
  aliveAtStart: number;
  /** userIds de los jugadores que llegaron vivos a esta pregunta (clave para
   * la muerte súbita total: el pozo se reparte entre ellos). */
  aliveAtStartUserIds: string[];
  survivors: number;
  eliminatedUserIds: string[];
  usedExtraLifeUserIds: string[];
}

export type SubmitAnswerRejection =
  | 'NOT_AUTHENTICATED'
  | 'NO_ACTIVE_QUESTION'
  | 'QUESTION_NOT_ACTIVE'
  | 'NOT_PARTICIPANT'
  | 'ALREADY_ANSWERED'
  | 'TIME_EXPIRED';

export type SubmitAnswerResult =
  { accepted: true } | { accepted: false; reason: SubmitAnswerRejection };

/** Estado final de un participante al liquidar la sala. */
export interface FinalStanding {
  userId: string;
  name: string;
  avatarUrl: string | null;
  position: number;
  prizeWon: number;
  isEliminated: boolean;
}

/** Resultado completo de la liquidación de una sala. */
export interface SettlementResult {
  roomId: string;
  prizePool: number;
  survivors: number;
  winners: FinalStanding[];
  participants: FinalStanding[];
}

@Injectable()
export class GameplayService {
  private readonly logger = new Logger(GameplayService.name);

  private readonly activeQuestions = new Map<string, ActiveQuestionState>();
  private readonly questionCursor = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async startQuestion(
    roomId: string,
    questionId?: string,
  ): Promise<QuestionStarted | null> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: {
        status: true,
        selectedCategoryId: true,
        normalQuestionCount: true,
        normalQuestionDuration: true,
      },
    });

    if (!room || room.status !== RoomStatus.ACTIVE) {
      return null;
    }

    const question = questionId
      ? await this.prisma.question.findUnique({ where: { id: questionId } })
      : await this.pickNextQuestion(
          roomId,
          room.selectedCategoryId,
          room.normalQuestionCount,
        );

    if (!question) {
      return null;
    }

    const participants = await this.prisma.roomParticipant.findMany({
      where: { roomId, isEliminated: false },
      select: { userId: true, hasPurchasedExtraLife: true },
    });

    const durationMs =
      (room.normalQuestionDuration > 0
        ? room.normalQuestionDuration
        : DEFAULT_QUESTION_DURATION_MS / 1000) * 1000;
    const endTime = Date.now() + durationMs;
    const options = question.options as unknown as string[];

    this.activeQuestions.set(roomId, {
      roomId,
      questionId: question.id,
      text: question.text,
      options,
      correctAnswer: question.correctAnswer,
      endTime,
      answers: new Map(),
      extraLifeByUser: new Map(
        participants.map((p) => [p.userId, p.hasPurchasedExtraLife] as const),
      ),
    });

    return {
      questionId: question.id,
      payload: {
        questionId: question.id,
        text: question.text,
        options,
        endTime,
      },
      correctAnswer: question.correctAnswer,
      endTime,
      finishAt: endTime + LATENCY_MARGIN_MS,
    };
  }

  submitAnswer(
    roomId: string,
    questionId: string,
    userId: string,
    answer: string,
  ): SubmitAnswerResult {
    const state = this.activeQuestions.get(roomId);

    if (!state) {
      return { accepted: false, reason: 'NO_ACTIVE_QUESTION' };
    }

    if (state.questionId !== questionId) {
      return { accepted: false, reason: 'QUESTION_NOT_ACTIVE' };
    }

    if (!state.extraLifeByUser.has(userId)) {
      return { accepted: false, reason: 'NOT_PARTICIPANT' };
    }

    if (state.answers.has(userId)) {
      return { accepted: false, reason: 'ALREADY_ANSWERED' };
    }

    if (Date.now() > state.endTime + LATENCY_MARGIN_MS) {
      return { accepted: false, reason: 'TIME_EXPIRED' };
    }

    state.answers.set(userId, answer.trim());
    return { accepted: true };
  }

  async finalizeQuestion(
    roomId: string,
    questionId: string,
  ): Promise<QuestionResultsPayload | null> {
    const state = this.activeQuestions.get(roomId);

    if (!state || state.questionId !== questionId) {
      return null;
    }

    // Conjunto "llegados vivos a esta pregunta": se captura ANTES de borrar el
    // estado (Excepción 1 → muerte súbita total).
    const aliveAtStartUserIds = [...state.extraLifeByUser.keys()];
    // Número (1-based) de la pregunta que acaba de cerrar.
    const questionIndex = this.questionCursor.get(roomId) ?? 0;

    this.activeQuestions.delete(roomId);

    const eliminatedUserIds: string[] = [];
    const usedExtraLifeUserIds: string[] = [];
    let correctCount = 0;

    for (const [userId, hasExtraLife] of state.extraLifeByUser) {
      const submitted = state.answers.get(userId);

      if (submitted === state.correctAnswer.trim()) {
        correctCount += 1;
        continue;
      }

      if (hasExtraLife) {
        usedExtraLifeUserIds.push(userId);
      } else {
        eliminatedUserIds.push(userId);
      }
    }

    const survivors = await this.prisma.$transaction(async (tx) => {
      if (eliminatedUserIds.length > 0) {
        await tx.roomParticipant.updateMany({
          where: { roomId, userId: { in: eliminatedUserIds } },
          data: { isEliminated: true, eliminatedAtQuestion: questionIndex },
        });
      }

      if (usedExtraLifeUserIds.length > 0) {
        await tx.roomParticipant.updateMany({
          where: { roomId, userId: { in: usedExtraLifeUserIds } },
          data: { hasPurchasedExtraLife: false },
        });
      }

      return tx.roomParticipant.count({
        where: { roomId, isEliminated: false },
      });
    });

    this.logger.log(
      `Pregunta ${state.questionId} de sala ${roomId} finalizada: ${correctCount} correctas, ${eliminatedUserIds.length} eliminado(s), ${usedExtraLifeUserIds.length} usaron vida extra, ${survivors} superviviente(s)`,
    );

    return {
      questionId: state.questionId,
      correctAnswer: state.correctAnswer,
      correctCount,
      aliveAtStart: state.extraLifeByUser.size,
      aliveAtStartUserIds,
      survivors,
      eliminatedUserIds,
      usedExtraLifeUserIds,
    };
  }

  getActiveQuestion(roomId: string): QuestionStartedPayload | null {
    const state = this.activeQuestions.get(roomId);

    if (!state) {
      return null;
    }

    return {
      questionId: state.questionId,
      text: state.text,
      options: state.options,
      endTime: state.endTime,
    };
  }

  async isParticipant(
    roomId: string,
    userId: string,
    email?: string,
  ): Promise<boolean> {
    const userIds = await this.resolveParticipantUserIds(userId, email);

    const count = await this.prisma.roomParticipant.count({
      where: { roomId, userId: { in: userIds } },
    });

    return count > 0;
  }

  /**
   * El `sub` del JWT de Supabase puede diferir del `id` de Prisma del usuario
   * según el flujo con el que se registró la cuenta. Resuelve ambos
   * identificadores para que la validación de participación no dependa de la
   * convención de IDs de un flujo concreto.
   */
  private async resolveParticipantUserIds(
    userId: string,
    email?: string,
  ): Promise<string[]> {
    const ids = new Set<string>([userId]);

    if (email) {
      const user = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (user) {
        ids.add(user.id);
      }
    }

    return [...ids];
  }

  async getAliveParticipantIds(roomId: string): Promise<string[]> {
    const rows = await this.prisma.roomParticipant.findMany({
      where: { roomId, isEliminated: false },
      select: { userId: true },
    });

    return rows.map((r) => r.userId);
  }

  /**
   * Liquida la sala de forma atómica (Excepción 3):
   *  1. Claim de idempotencia ACTIVE→FINISHED; si otra ejecución ya liquidó,
   *     count === 0 → no se paga nada (nunca dos veces, ni tras reinicio).
   *  2. Abona balanceLucas de los ganadores.
   *  3. Crea una Transaction PRIZE/COMPLETED por ganador con reference única
   *     por usuario + skipDuplicates (candado extra anti duplicados).
   *  4. Persiste position + prizeWon de TODOS los participantes.
   * Las posiciones y montos se calculan ANTES, en memoria (`buildSettlement`).
   */
  async settleRoom(
    roomId: string,
    winnerIds: string[],
    survivors: number,
  ): Promise<SettlementResult | null> {
    const spec = await this.buildSettlement(roomId, winnerIds, survivors);

    if (!spec) {
      return null;
    }

    const settled = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.room.updateMany({
        where: { id: roomId, status: RoomStatus.ACTIVE },
        data: { status: RoomStatus.FINISHED },
      });

      if (claimed.count === 0) {
        return null;
      }

      if (spec.winners.length > 0) {
        await tx.transaction.createMany({
          data: spec.winners.map((w) => ({
            userId: w.userId,
            amount: w.prizeWon,
            transactionType: TransactionType.PRIZE,
            status: TransactionStatus.COMPLETED,
            reference: `prize:${roomId}:${w.userId}`,
          })),
          skipDuplicates: true,
        });

        for (const winner of spec.winners) {
          await tx.user.updateMany({
            where: { id: winner.userId },
            data: { balanceLucas: { increment: winner.prizeWon } },
          });
        }
      }

      for (const p of spec.participants) {
        await tx.roomParticipant.update({
          where: { roomId_userId: { roomId, userId: p.userId } },
          data: { position: p.position, prizeWon: p.prizeWon },
        });
      }

      return spec;
    });

    if (settled) {
      this.disposeRoom(roomId);
      this.logger.log(
        `Sala ${roomId} liquidada: ${settled.winners.length} ganador(es), pozo ${settled.prizePool}, ${settled.survivors} superviviente(s)`,
      );
    }

    return settled;
  }

  /**
   * Construye EN MEMORIA el estado final completo (ganadores, montos exactos,
   * posiciones de competición) a partir de la BD. No escribe nada.
   *
   * Reparto del pozo: centavos exactos; el remanente (0..0.99) se asigna al
   * primer ganador en orden determinista para que Σ premios == prizePool.
   * Posiciones: ranking de competición → position = 1 + nº de jugadores con
   * supervivencia estrictamente mayor (los ganadores empatan en la posición 1).
   */
  private async buildSettlement(
    roomId: string,
    winnerIds: string[],
    survivors: number,
  ): Promise<SettlementResult | null> {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });

    if (!room || room.status !== RoomStatus.ACTIVE) {
      return null;
    }

    const participants = await this.prisma.roomParticipant.findMany({
      where: { roomId },
      select: {
        userId: true,
        isEliminated: true,
        eliminatedAtQuestion: true,
        userName: true,
        userAvatarUrl: true,
      },
    });

    if (participants.length === 0) {
      return null;
    }

    const winnerSet = new Set(winnerIds);

    const eliminatedRanks = participants
      .filter((p) => p.isEliminated)
      .map((p) => p.eliminatedAtQuestion ?? 0);
    const maxEliminatedRank =
      eliminatedRanks.length > 0 ? Math.max(...eliminatedRanks) : 0;

    // Ranking de supervivencia: los ganadores quedan estrictamente por encima
    // de cualquier eliminado (sobreviven "una ronda más" que el último caído).
    const ranked = participants.map((p) => {
      const isWinner = winnerSet.has(p.userId);

      return {
        participant: p,
        isWinner,
        rank: isWinner ? maxEliminatedRank + 1 : (p.eliminatedAtQuestion ?? 0),
      };
    });

    const sortedWinners = ranked
      .filter((r) => r.isWinner)
      .map((r) => r.participant.userId)
      .sort();

    const prizePool = room.prizePool;
    const winnerCount = sortedWinners.length;
    const baseAward =
      winnerCount > 0 ? Math.floor((prizePool / winnerCount) * 100) / 100 : 0;
    const distributed = baseAward * winnerCount;
    const remainder = Math.max(
      0,
      Math.round((prizePool - distributed) * 100) / 100,
    );

    const prizes = new Map<string, number>();
    for (const userId of sortedWinners) {
      prizes.set(userId, baseAward);
    }
    if (sortedWinners.length > 0) {
      const first = sortedWinners[0];
      prizes.set(
        first,
        Math.round((prizes.get(first)! + remainder) * 100) / 100,
      );
    }

    const participantsList = ranked.map(({ participant: p, rank }) => {
      const position = 1 + ranked.filter((r) => r.rank > rank).length;

      return {
        userId: p.userId,
        name: p.userName,
        avatarUrl: p.userAvatarUrl,
        position,
        prizeWon: prizes.get(p.userId) ?? 0,
        isEliminated: p.isEliminated,
      };
    });

    const winners = participantsList
      .filter((s) => prizes.has(s.userId))
      .sort((a, b) => a.userId.localeCompare(b.userId));

    return {
      roomId,
      prizePool,
      survivors,
      winners,
      participants: participantsList,
    };
  }

  disposeRoom(roomId: string): void {
    this.activeQuestions.delete(roomId);
    this.questionCursor.delete(roomId);
  }

  private async pickNextQuestion(
    roomId: string,
    categoryId: string | null,
    totalQuestions: number,
  ): Promise<Question | null> {
    const cursor = this.questionCursor.get(roomId) ?? 0;

    if (totalQuestions > 0 && cursor >= totalQuestions) {
      return null;
    }

    this.questionCursor.set(roomId, cursor + 1);

    if (!categoryId) {
      return null;
    }

    const question = await this.prisma.question.findFirst({
      where: { categoryId },
      orderBy: [{ difficulty: 'asc' }, { id: 'asc' }],
      skip: cursor,
    });

    if (question) {
      return question;
    }

    return this.prisma.question.findFirst({ where: { categoryId } });
  }
}
