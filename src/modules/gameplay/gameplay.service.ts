import { Injectable, Logger } from '@nestjs/common';
import { Question, RoomStatus } from '@prisma/client';
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
  survivors: number;
  eliminatedUserIds: string[];
  usedExtraLifeUserIds: string[];
}

export type SubmitAnswerRejection =
  | 'NO_ACTIVE_QUESTION'
  | 'QUESTION_NOT_ACTIVE'
  | 'NOT_PARTICIPANT'
  | 'ALREADY_ANSWERED'
  | 'TIME_EXPIRED';

export type SubmitAnswerResult =
  { accepted: true } | { accepted: false; reason: SubmitAnswerRejection };

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
          data: { isEliminated: true },
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

  async isParticipant(roomId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.roomParticipant.count({
      where: { roomId, userId },
    });

    return count > 0;
  }

  disposeRoom(roomId: string): void {
    this.activeQuestions.delete(roomId);
    this.questionCursor.delete(roomId);
  }

  async finishRoom(roomId: string): Promise<boolean> {
    const { count } = await this.prisma.room.updateMany({
      where: { id: roomId, status: RoomStatus.ACTIVE },
      data: { status: RoomStatus.FINISHED },
    });

    this.disposeRoom(roomId);

    return count > 0;
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
