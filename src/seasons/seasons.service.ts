import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SeasonStatus,
  TransactionStatus,
  TransactionType,
  UserStatus,
} from '@prisma/client';
import type { Season } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  GetSeasonCurrentDto,
  SeasonInfoDto,
  SeasonRankingEntryDto,
} from './dto/seasons.dto';

/** Tope de la tabla de jugadores del ranking. */
const RANKING_TOP_LIMIT = 50;

/** Duración de cada temporada (30 días, renovada por la liquidación). */
const SEASON_DURATION_DAYS = 30;

/** Premios base de cada temporada. */
const SEASON_FIRST_PLACE_PRIZE = 500_000;
const SEASON_SECOND_PLACE_PRIZE = 250_000;
const SEASON_THIRD_PLACE_PRIZE = 100_000;

const SEASON_PRIZES = [
  SEASON_FIRST_PLACE_PRIZE,
  SEASON_SECOND_PLACE_PRIZE,
  SEASON_THIRD_PLACE_PRIZE,
];

@Injectable()
export class SeasonsService {
  private readonly logger = new Logger(SeasonsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /seasons/current
   * Devuelve la temporada ACTIVE (con sus premios) y el Top 50 de jugadores
   * ordenados por globalPoints descendente (posiciones de competición).
   * Si no existe ninguna temporada activa (BD recién creada o nunca liquidada),
   * la crea al vuelo para mantener la invariante "siempre existe una ACTIVE".
   */
  async getSeasonCurrent(): Promise<GetSeasonCurrentDto> {
    const season = await this.ensureActiveSeason();
    const ranking = await this.buildRanking();

    return { season: toSeasonInfo(season), ranking };
  }

  /**
   * Cron Job (cada hora): revisa si alguna temporada ACTIVE superó su endDate.
   * Cada temporada vencida se liquida de forma atómica e idempotente:
   * 1. Claim FINISHED (race-guard, si viene con puntos > 0).
   * 2. Paga premios base al Top 3 (incrementa balanceLucas + Transaction PRIZE).
   * 3. Persiste los SeasonWinner con los puntos exactos de cierre.
   * 4. Resetea globalPoints de TODOS los usuarios a 0.
   * 5. Crea la siguiente temporada ACTIVE (30 días, mismos premios base).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkSeasonLiquidation(): Promise<void> {
    const expired = await this.prisma.season.findMany({
      where: {
        status: SeasonStatus.ACTIVE,
        endDate: { lte: new Date() },
      },
      orderBy: { endDate: 'asc' },
      select: { id: true },
    });

    for (const season of expired) {
      await this.liquidateSeason(season.id);
    }
  }

  private async liquidateSeason(seasonId: string): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      const raceGuard = await tx.season.updateMany({
        where: { id: seasonId, status: SeasonStatus.ACTIVE },
        data: { status: SeasonStatus.FINISHED },
      });

      if (raceGuard.count === 0) {
        return null;
      }

      const topUsers = await tx.user.findMany({
        where: { globalPoints: { gt: 0 }, status: UserStatus.ACTIVE },
        orderBy: [{ globalPoints: 'desc' }, { id: 'asc' }],
        take: 3,
        select: { id: true, globalPoints: true },
      });

      const winners = topUsers.map((user, index) => ({
        userId: user.id,
        position: index + 1,
        prizeWon: SEASON_PRIZES[index],
        pointsAtClose: user.globalPoints,
      }));

      if (winners.length > 0) {
        await tx.transaction.createMany({
          data: winners.map((w) => ({
            userId: w.userId,
            amount: w.prizeWon,
            transactionType: TransactionType.PRIZE,
            status: TransactionStatus.COMPLETED,
            reference: `season-prize:${seasonId}:${w.userId}`,
          })),
          skipDuplicates: true,
        });

        for (const w of winners) {
          await tx.user.updateMany({
            where: { id: w.userId },
            data: { balanceLucas: { increment: w.prizeWon } },
          });
        }
      }

      if (winners.length > 0) {
        await tx.seasonWinner.createMany({
          data: winners.map((w) => ({
            seasonId,
            userId: w.userId,
            position: w.position,
            prizeWon: w.prizeWon,
            pointsAtClose: w.pointsAtClose,
          })),
          skipDuplicates: true,
        });
      }

      await tx.user.updateMany({ data: { globalPoints: 0 } });

      const now = new Date();
      await tx.season.create({
        data: {
          startDate: now,
          endDate: addDays(now, SEASON_DURATION_DAYS),
          firstPlacePrize: SEASON_FIRST_PLACE_PRIZE,
          secondPlacePrize: SEASON_SECOND_PLACE_PRIZE,
          thirdPlacePrize: SEASON_THIRD_PLACE_PRIZE,
          status: SeasonStatus.ACTIVE,
        },
      });

      return { winnerCount: winners.length };
    });

    if (result) {
      this.logger.log(
        `Temporada ${seasonId} liquidada: ${result.winnerCount} ganador(es). Nueva temporada ACTIVE creada.`,
      );
    }
  }

  private async ensureActiveSeason(): Promise<Season> {
    const existing = await this.prisma.season.findFirst({
      where: { status: SeasonStatus.ACTIVE },
      orderBy: { startDate: 'desc' },
    });

    if (existing) {
      return existing;
    }

    const now = new Date();
    return this.prisma.season.create({
      data: {
        startDate: now,
        endDate: addDays(now, SEASON_DURATION_DAYS),
        firstPlacePrize: SEASON_FIRST_PLACE_PRIZE,
        secondPlacePrize: SEASON_SECOND_PLACE_PRIZE,
        thirdPlacePrize: SEASON_THIRD_PLACE_PRIZE,
        status: SeasonStatus.ACTIVE,
      },
    });
  }

  private async buildRanking(): Promise<SeasonRankingEntryDto[]> {
    const users = await this.prisma.user.findMany({
      where: { status: UserStatus.ACTIVE },
      orderBy: [{ globalPoints: 'desc' }, { id: 'asc' }],
      take: RANKING_TOP_LIMIT,
      select: { id: true, name: true, avatarUrl: true, globalPoints: true },
    });

    let lastPoints: number | null = null;
    let lastPosition = 0;

    return users.map((user, index) => {
      const position =
        user.globalPoints === lastPoints ? lastPosition : index + 1;
      lastPoints = user.globalPoints;
      lastPosition = position;

      return {
        userId: user.id,
        userName: user.name,
        avatarUrl: user.avatarUrl,
        position,
        globalPoints: user.globalPoints,
      };
    });
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toSeasonInfo(season: Season): SeasonInfoDto {
  return {
    id: season.id,
    startDate: season.startDate.toISOString(),
    endDate: season.endDate.toISOString(),
    status: season.status,
    firstPlacePrize: season.firstPlacePrize,
    secondPlacePrize: season.secondPlacePrize,
    thirdPlacePrize: season.thirdPlacePrize,
  };
}