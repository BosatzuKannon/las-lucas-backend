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
export const SURVIVAL_ANNOUNCEMENT_MS = 5_000;
export const DEFAULT_QUESTION_DURATION_MS = 7_000;
export const DEFAULT_SURVIVAL_DURATION_S = 4;

export interface ActiveQuestionState {
  roomId: string;
  questionId: string;
  text: string;
  options: string[];
  correctAnswer: string;
  endTime: number;
  isSurvival: boolean;
  answers: Map<string, string>;
  extraLifeByUser: Map<string, boolean>;
}

export interface QuestionStartedPayload {
  questionId: string;
  text: string;
  options: string[];
  endTime: number;
  /** true si la pregunta pertenece a la fase de supervivencia. */
  isSurvival: boolean;
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
        survivalQuestionDuration: true,
        survivalMode: true,
        questionCursor: true,
      },
    });

    if (!room || room.status !== RoomStatus.ACTIVE) {
      return null;
    }

    const question = questionId
      ? await this.prisma.question.findUnique({ where: { id: questionId } })
      : await this.pickNextQuestion(roomId, room);

    if (!question) {
      return null;
    }

    const participants = await this.prisma.roomParticipant.findMany({
      where: { roomId, isEliminated: false },
      select: { userId: true, hasPurchasedExtraLife: true },
    });

    const durationMs =
      (room.survivalMode
        ? room.survivalQuestionDuration > 0
          ? room.survivalQuestionDuration
          : DEFAULT_SURVIVAL_DURATION_S
        : room.normalQuestionDuration > 0
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
      isSurvival: room.survivalMode,
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
        isSurvival: room.survivalMode,
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
    // estado. Este conjunto define el total de jugadores en juego.
    const aliveAtStartUserIds = [...state.extraLifeByUser.keys()];

    // Número (1-based) de la pregunta que acaba de cerrar. El cursor se
    // incrementó persistiéndolo cuando se eligió la pregunta, así que el valor
    // en BD coincide con el número de la pregunta EN CURSO.
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { questionCursor: true },
    });
    const questionIndex = room?.questionCursor ?? 0;

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

    // MUERTE SÚBITA TOTAL: todos los que llegaron vivos fallaron (ninguno
    // acierta y ninguno tenía vida extra para salvarse). Regla de negocio:
    // nadie es eliminado y se repregunta en la siguiente ronda. Así el torneo
    // SIEMPRE culmina con 1 ganador único.
    const totalAlive = aliveAtStartUserIds.length;
    if (eliminatedUserIds.length > 0 && eliminatedUserIds.length === totalAlive) {
      this.logger.log(
        `Pregunta ${state.questionId} de sala ${roomId}: MUERTE SÚBITA (${totalAlive} fallaron) → nadie eliminado, se repite ronda`,
      );

      return {
        questionId: state.questionId,
        correctAnswer: state.correctAnswer,
        correctCount,
        aliveAtStart: totalAlive,
        aliveAtStartUserIds,
        survivors: totalAlive,
        eliminatedUserIds: [],
        usedExtraLifeUserIds: [],
      };
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
      aliveAtStart: totalAlive,
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
      isSurvival: state.isSurvival,
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

  // ------------------------------------------------------------------
  // Supervivencia (survival)
  // ------------------------------------------------------------------

  /**
   * Indica si la fase normal se agotó y se debe entrar en modo survival
   * (necesita modo survival + cursor ≥ normalQuestionCount).
   * No escribe nada; solo lee.
   */
  async shouldEnterSurvival(roomId: string): Promise<boolean> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: {
        status: true,
        survivalMode: true,
        questionCursor: true,
        normalQuestionCount: true,
      },
    });

    return (
      !!room &&
      room.status === RoomStatus.ACTIVE &&
      !room.survivalMode &&
      room.normalQuestionCount > 0 &&
      room.questionCursor >= room.normalQuestionCount
    );
  }

  /**
   * Activa `survivalMode` en la sala (claim atómico) y devuelve la duración
   * de respuesta para supervivencia en milisegundos. Si ya estaba activo o la
   * sala cambió de estado, devuelve `null`.
   */
  async enableSurvivalMode(
    roomId: string,
  ): Promise<{ durationMs: number } | null> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: {
        status: true,
        survivalMode: true,
        survivalQuestionDuration: true,
      },
    });

    if (!room || room.status !== RoomStatus.ACTIVE) {
      return null;
    }

    if (room.survivalMode) {
      // Ya fue activado (posible doble disparo). Devolver la duración igual.
      return {
        durationMs:
          (room.survivalQuestionDuration > 0
            ? room.survivalQuestionDuration
            : DEFAULT_SURVIVAL_DURATION_S) * 1000,
      };
    }

    const claimed = await this.prisma.room.updateMany({
      where: { id: roomId, status: RoomStatus.ACTIVE, survivalMode: false },
      data: { survivalMode: true },
    });

    if (claimed.count === 0) {
      return null;
    }

    this.logger.log(`Sala ${roomId}: modo survival activado`);

    return {
      durationMs:
        (room.survivalQuestionDuration > 0
          ? room.survivalQuestionDuration
          : DEFAULT_SURVIVAL_DURATION_S) * 1000,
    };
  }

  /**
   * IDs de todas las salas en ACTIVE (usado por la recuperación al reinicio).
   */
  async getActiveRoomIds(): Promise<string[]> {
    const rows = await this.prisma.room.findMany({
      where: { status: RoomStatus.ACTIVE },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------
  // Liquidación
  // ------------------------------------------------------------------

  /**
   * Liquida la sala de forma atómica (idempotente):
   *  1. Claim ACTIVE → FINISHED. Si ya fue liquidada, count===0 → no paga.
   *  2. Abona balance de los ganadores.
   *  3. Persiste position + prizeWon de TODOS.
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
    // `questionCursor`, `survivalMode` y deadlines viven en BD (sobreviven reinicios).
  }

  /**
   * Elige la siguiente pregunta desde la categoría seleccionada. El cursor se
   * incrementa y persiste al instante para que una caída del servidor no
   * repita la misma pregunta (vista como pregunta N+1 por el cliente que se
   * reconecta).
   *
   * Modo normal: avanza secuencial hasta `normalQuestionCount`.
   * Modo survival: recicla preguntas indefinidamente.
   */
  private async pickNextQuestion(
    roomId: string,
    room: {
      selectedCategoryId: string | null;
      normalQuestionCount: number;
      survivalMode: boolean;
      questionCursor: number;
    },
  ): Promise<Question | null> {
    const categoryId = room.selectedCategoryId;

    if (!categoryId) {
      return null;
    }

    // En modo normal, el cursor no puede superar el conteo de preguntas normales
    // (el gateway primero activa survival; si aún no lo hizo, regresamos null).
    if (!room.survivalMode && room.questionCursor >= room.normalQuestionCount) {
      return null;
    }

    const questions = await this.prisma.question.findMany({
      where: { categoryId },
      orderBy: [{ difficulty: 'asc' }, { id: 'asc' }],
    });

    if (questions.length === 0) {
      return null;
    }

    const index = room.survivalMode
      ? room.questionCursor % questions.length
      : Math.min(room.questionCursor, questions.length - 1);

    const question = questions[index];

    if (!question) {
      return null;
    }

    // Incrementa el cursor y lo persiste. Con `updateMany` con guardia de
    // estado (status = ACTIVE) evita corrupción si la sala ya terminó.
    await this.prisma.room.updateMany({
      where: { id: roomId, status: RoomStatus.ACTIVE },
      data: { questionCursor: { increment: 1 } },
    });

    return question;
  }
}
