import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  RoomStatus,
  TournamentType,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GameplayGateway } from '../modules/gameplay/gameplay.gateway';
import { DEFAULT_TIMEZONE } from '../config/timezone';
import {
  GetHistoryGlobalDto,
  GetHistoryMeDto,
  GetHistoryStatsDto,
  GetLeaderboardDto,
} from './dto/history.dto';

/** Ventana de espera de la sala de espera (10 minutos). */
const WAITING_WINDOW_MS = 10 * 60 * 1000;

/** Duración de la fase de votación de categoría (45 segundos). */
const VOTING_WINDOW_MS = 45 * 1000;

/** Buffer de conexión al pasar una sala a ACTIVE: la primera pregunta se
 * dispara a los 5 s para que los clientes React Native terminen de montar
 * GameplayScreen y conecten su WebSocket al namespace `/gameplay`. */
const GAME_START_CONNECTION_BUFFER_MS = 5_000;

/** Umbrales de totalWon (Lucas acumuladas) para el nivel competitivo. */
const TIER_BRONCE_MAX = 24_999;
const TIER_PLATA_MAX = 99_999;
const TIER_ORO_MAX = 299_999;
const TIER_PLATINO_MAX = 999_999;

/** Tope del historial global. */
const HISTORY_GLOBAL_LIMIT = 20;

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameplayGateway: GameplayGateway,
  ) {}

  // -----------------------------------------------------------------------
  // Lecturas
  // -----------------------------------------------------------------------

  getOpenRooms() {
    return this.prisma.room.findMany({
      where: {
        status: { in: [RoomStatus.SCHEDULED, RoomStatus.WAITING] },
      },
      orderBy: [{ status: 'desc' }, { startTime: 'asc' }],
    });
  }

  async getWaitingRoom(roomId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, name: true, avatarUrl: true },
            },
          },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Sala de torneo no encontrada');
    }

    return room;
  }

  // -----------------------------------------------------------------------
  // Historial (Fase 2 — Gamificación: Ranking de Temporadas)
  // -----------------------------------------------------------------------

  /**
   * Resumen Competitivo del usuario: torneos jugados, podios (top 3), total
   * ganado y nivel derivado. Solo cuenta torneos cerrados (FINISHED/CANCELLED).
   */
  async getHistoryStats(userId: string): Promise<GetHistoryStatsDto> {
    const participations = await this.prisma.roomParticipant.findMany({
      where: {
        userId,
        room: {
          status: { in: [RoomStatus.FINISHED, RoomStatus.CANCELLED] },
        },
      },
      select: {
        prizeWon: true,
        position: true,
        room: { select: { status: true } },
      },
    });

    const tournamentsPlayed = participations.length;
    const podiums = participations.filter(
      (p) =>
        p.room.status === RoomStatus.FINISHED &&
        p.position !== null &&
        p.position <= 3,
    ).length;
    const totalWon = round2(
      participations.reduce((sum, p) => sum + p.prizeWon, 0),
    );

    return {
      tournamentsPlayed,
      podiums,
      totalWon,
      tier: computeTier(totalWon),
    };
  }

  /**
   * Últimos 20 torneos cerrados (FINISHED o CANCELLED). Los FINISHED incluyen
   * el podio Top 4 (posición, usuario, puntos, premio) + pozo total y aforo.
   */
  async getHistoryGlobal(): Promise<GetHistoryGlobalDto> {
    const rooms = await this.prisma.room.findMany({
      where: {
        status: { in: [RoomStatus.FINISHED, RoomStatus.CANCELLED] },
      },
      orderBy: { startTime: 'desc' },
      take: HISTORY_GLOBAL_LIMIT,
      include: {
        participants: {
          where: { position: { not: null } },
          orderBy: [{ position: 'asc' }, { prizeWon: 'desc' }, { userId: 'asc' }],
          take: 4,
        },
      },
    });

    return {
      tournaments: rooms.map((room) => {
        const finished = room.status === RoomStatus.FINISHED;

        return {
          roomId: room.id,
          displayName: tournamentDisplayName(room.tournamentType),
          tournamentType: room.tournamentType,
          status: room.status,
          startDate: room.startTime.toISOString(),
          prizePool: room.prizePool,
          capacity: room.maxPlayers,
          currentPlayers: room.currentPlayers,
          podium: finished
            ? room.participants.map((p) => ({
                position: p.position!,
                userName: p.userName,
                score: p.score,
                prizeWon: p.prizeWon,
              }))
            : null,
          fullyRefunded: !finished,
          referenceId: room.id,
        };
      }),
    };
  }

  /**
   * Historial de los torneos cerrados donde participó el usuario, destacando
   * su posición, sus puntos en la sala y el estado del torneo.
   */
  async getHistoryMe(userId: string): Promise<GetHistoryMeDto> {
    const participations = await this.prisma.roomParticipant.findMany({
      where: {
        userId,
        room: {
          status: { in: [RoomStatus.FINISHED, RoomStatus.CANCELLED] },
        },
      },
      orderBy: { room: { startTime: 'desc' } },
      include: { room: true },
    });

    return {
      tournaments: participations.map((p) => ({
        roomId: p.roomId,
        displayName: tournamentDisplayName(p.room.tournamentType),
        tournamentType: p.room.tournamentType,
        status: p.room.status,
        startDate: p.room.startTime.toISOString(),
        prizePool: p.room.prizePool,
        capacity: p.room.maxPlayers,
        currentPlayers: p.room.currentPlayers,
        myPosition: p.position,
        myScore: p.score,
        myPrizeWon: p.prizeWon,
        fullyRefunded: p.room.status === RoomStatus.CANCELLED,
        referenceId: p.roomId,
      })),
    };
  }

  /**
   * Tabla completa de ganadores de un torneo FINISHED (todas las posiciones,
   * sin el tope `take: 4` del podio). Se consulta bajo demanda al abrir el
   * modal "Ver tabla completa" del historial.
   */
  async getLeaderboard(roomId: string): Promise<GetLeaderboardDto> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: {
        status: true,
        tournamentType: true,
        prizePool: true,
        startTime: true,
      },
    });

    if (!room) {
      throw new NotFoundException('Sala de torneo no encontrada');
    }

    if (room.status !== RoomStatus.FINISHED) {
      throw new BadRequestException(
        'La tabla completa solo está disponible para torneos finalizados',
      );
    }

    const entries = await this.prisma.roomParticipant.findMany({
      where: { roomId, position: { not: null } },
      orderBy: [{ position: 'asc' }, { prizeWon: 'desc' }, { userId: 'asc' }],
    });

    return {
      roomId,
      displayName: tournamentDisplayName(room.tournamentType),
      prizePool: room.prizePool,
      startDate: room.startTime.toISOString(),
      totalPlayers: entries.length,
      entries: entries.map((p) => ({
        userId: p.userId,
        position: p.position!,
        userName: p.userName,
        score: p.score,
        prizeWon: p.prizeWon,
      })),
    };
  }

  // -----------------------------------------------------------------------
  // Inscripción
  // -----------------------------------------------------------------------

  async joinTournament(userId: string, roomId: string, buyExtraLife: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
      });

      if (!room) {
        throw new NotFoundException('Sala de torneo no encontrada');
      }

      if (room.status !== RoomStatus.WAITING) {
        throw new BadRequestException(
          'El torneo aún no ha iniciado. Espera a que se abra la sala de espera.',
        );
      }

      if (room.currentPlayers >= room.maxPlayers) {
        throw new BadRequestException('La sala ya está llena');
      }

      const existingParticipant = await tx.roomParticipant.findUnique({
        where: {
          roomId_userId: { roomId, userId },
        },
      });

      if (existingParticipant) {
        throw new BadRequestException(
          'Ya estás inscrito en esta sala de torneo',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundException('Usuario no encontrado');
      }

      const totalCost = room.entryFee + (buyExtraLife ? room.extraLifeFee : 0);

      if (user.balanceLucas < totalCost) {
        throw new BadRequestException(
          'Saldo insuficiente para inscribirse al torneo',
        );
      }

      await tx.user.update({
        where: { id: userId },
        data: { balanceLucas: { decrement: totalCost } },
      });

      await tx.transaction.create({
        data: {
          userId,
          amount: -totalCost,
          transactionType: TransactionType.ENTRY_FEE,
          status: TransactionStatus.COMPLETED,
        },
      });

      await tx.roomParticipant.create({
        data: {
          roomId,
          userId,
          hasPurchasedExtraLife: buyExtraLife,
          userName: user.name,
          userAvatarUrl: user.avatarUrl,
        },
      });

      let updatedRoom = await tx.room.update({
        where: { id: roomId },
        data: { currentPlayers: { increment: 1 } },
      });

      // Si se completa la sala, pasar directamente a la fase VOTING (no ACTIVE).
      if (updatedRoom.currentPlayers >= updatedRoom.maxPlayers) {
        const votingClosesAt = new Date(Date.now() + VOTING_WINDOW_MS);
        updatedRoom = await tx.room.update({
          where: { id: roomId },
          data: {
            status: RoomStatus.VOTING,
            votingClosesAt,
          },
        });
        this.logger.log(
          `Sala ${roomId} WAITING → VOTING (llenada por inscripción, cierre de votación ${formatBogota(votingClosesAt)})`,
        );
      }

      return updatedRoom;
    });
  }

  // -----------------------------------------------------------------------
  // Votación
  // -----------------------------------------------------------------------

  async voteForRoom(userId: string, roomId: string, categoryId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });

    if (!room) {
      throw new NotFoundException('Sala de torneo no encontrada');
    }

    if (room.status !== RoomStatus.VOTING) {
      throw new BadRequestException(
        'La votación de categorías no está abierta para esta sala',
      );
    }

    const votingDeadline = room.votingClosesAt;

    if (!votingDeadline || votingDeadline.getTime() <= Date.now()) {
      throw new BadRequestException(
        'La votación de categorías ya cerró para esta sala',
      );
    }

    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });

    if (!category) {
      throw new BadRequestException('Categoría no encontrada');
    }

    if (!category.isActive) {
      throw new BadRequestException('Esta categoría no está disponible');
    }

    const participant = await this.prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });

    if (!participant) {
      throw new BadRequestException('No estás inscrito en esta sala');
    }

    if (participant.votedCategoryId) {
      throw new BadRequestException('Ya has votado en esta sala');
    }

    const updatedParticipant = await this.prisma.roomParticipant.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        votedCategoryId: categoryId,
        votedAt: new Date(),
      },
    });

    this.logger.log(
      `Voto registrado: sala ${roomId} usuario ${userId} → categoría ${categoryId}`,
    );

    return updatedParticipant;
  }

  // -----------------------------------------------------------------------
  // Cron / Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Motor de fases (1 tick/segundo). Trabaja SIEMPRE con deadlines calculados
   * (`waitingClosesAt` / `votingClosesAt`); NUNCA reescribe `startTime`
   * (la hora programada es inamovible, sensa a retrasos del tick).
   */
  @Interval(1_000)
  async processRoomLifecycle() {
    const now = new Date();

    await this.openScheduledRooms(now);
    await this.processWaitingRooms(now);
    await this.processVotingRooms(now);
  }

  /** SCHEDULED → WAITING exactamente cuando `startTime` se cumple (nunca antes). */
  private async openScheduledRooms(now: Date) {
    const due = await this.prisma.room.findMany({
      where: {
        status: RoomStatus.SCHEDULED,
        startTime: { lte: now },
      },
      select: { id: true, startTime: true },
    });

    for (const room of due) {
      const waitingClosesAt = new Date(
        room.startTime.getTime() + WAITING_WINDOW_MS,
      );

      const { count } = await this.prisma.room.updateMany({
        where: { id: room.id, status: RoomStatus.SCHEDULED },
        data: {
          status: RoomStatus.WAITING,
          waitingClosesAt,
        },
      });

      if (count > 0) {
        this.logger.log(
          `Sala ${room.id} SCHEDULED → WAITING (apertura ${formatBogota(room.startTime)}, cierre de espera ${formatBogota(waitingClosesAt)})`,
        );
      }
    }
  }

  /** WAITING: llena → VOTING (deadline = ahora + 45 s); vencida → CANCELLED + reembolso. */
  private async processWaitingRooms(now: Date) {
    const waitingRooms = await this.prisma.room.findMany({
      where: { status: RoomStatus.WAITING },
    });

    for (const room of waitingRooms) {
      if (room.currentPlayers >= room.maxPlayers) {
        const votingClosesAt = new Date(Date.now() + VOTING_WINDOW_MS);

        const { count } = await this.prisma.room.updateMany({
          where: { id: room.id, status: RoomStatus.WAITING },
          data: {
            status: RoomStatus.VOTING,
            votingClosesAt,
          },
        });

        if (count > 0) {
          this.logger.log(
            `Sala ${room.id} WAITING → VOTING (llena, cierre ${formatBogota(votingClosesAt)})`,
          );
        }

        continue;
      }

      const deadline =
        room.waitingClosesAt ??
        new Date(room.startTime.getTime() + WAITING_WINDOW_MS);

      if (deadline <= now) {
        await this.cancelAndRefund(room.id);
      }
    }
  }

  /**
   * VOTING → ACTIVE una vez vencido `votingClosesAt`: elige la categoría
   * ganadora, activa la partida y lanza el countdown de 5 s + primera
   * pregunta. La primera pregunta se dispara con un timer interno del gateway
   * (no bloquea este cron).
   */
  private async processVotingRooms(now: Date) {
    const due = await this.prisma.room.findMany({
      where: {
        status: RoomStatus.VOTING,
        votingClosesAt: { lte: now },
      },
      select: { id: true },
    });

    for (const room of due) {
      await this.closeVotingAndStartGame(room.id);
    }
  }

  /** Resuelve la votación, cambia a ACTIVE y dispara el countdown. */
  private async closeVotingAndStartGame(roomId: string) {
    const selectedCategoryId = await this.selectWinningCategory(roomId);

    const { count } = await this.prisma.room.updateMany({
      where: { id: roomId, status: RoomStatus.VOTING },
      data: {
        status: RoomStatus.ACTIVE,
        selectedCategoryId,
        votingClosesAt: null,
      },
    });

    if (count === 0) {
      return; // ya fue procesada (otro tick / inscripción simultánea).
    }

    this.logger.log(
      `Sala ${roomId} VOTING → ACTIVE (categoría: ${selectedCategoryId ?? 'N/A'})`,
    );

    // Buffer de conexión (5 s): la sala ya está ACTIVE y el cron no la vuelve
    // a procesar. El gateway dispara la 1ª pregunta a los 5 s.
    const startTime = Date.now() + GAME_START_CONNECTION_BUFFER_MS;
    this.gameplayGateway.startGameCountdown(roomId, startTime);
  }

  /** Elige la categoría ganadora de la votación de una sala (candado por sala). */
  private async selectWinningCategory(roomId: string): Promise<string | null> {
    const participants = await this.prisma.roomParticipant.findMany({
      where: {
        roomId,
        votedCategoryId: { not: null },
      },
      select: {
        votedCategoryId: true,
        votedAt: true,
      },
    });

    if (participants.length === 0) {
      // 0 votos → categoría activa aleatoria.
      const activeCategories = await this.prisma.category.findMany({
        where: { isActive: true },
        select: { id: true },
      });

      if (activeCategories.length > 0) {
        return activeCategories[
          Math.floor(Math.random() * activeCategories.length)
        ].id;
      }

      const anyCategory = await this.prisma.category.findFirst({
        select: { id: true },
      });

      return anyCategory?.id ?? null;
    }

    // Contar votos por categoría.
    const counts = new Map<string, number>();
    const lastVotedAt = new Map<string, number>();

    for (const p of participants) {
      const catId = p.votedCategoryId!;
      counts.set(catId, (counts.get(catId) ?? 0) + 1);

      const t = p.votedAt?.getTime() ?? 0;
      const prev = lastVotedAt.get(catId) ?? 0;
      if (t > prev) lastVotedAt.set(catId, t);
    }

    let maxCount = 0;
    for (const n of counts.values()) {
      if (n > maxCount) maxCount = n;
    }

    const leaders = [...counts.entries()]
      .filter(([, n]) => n === maxCount)
      .map(([catId]) => catId);

    // Desempate: MIN(MAX(votedAt)) → el último voto más temprano.
    let bestCat = leaders[0];
    let bestLastVote = lastVotedAt.get(bestCat) ?? Infinity;

    for (const catId of leaders.slice(1)) {
      const t = lastVotedAt.get(catId) ?? Infinity;
      if (t < bestLastVote) {
        bestCat = catId;
        bestLastVote = t;
      }
    }

    return bestCat;
  }

  // -----------------------------------------------------------------------
  // Cancelación / Reembolso
  // -----------------------------------------------------------------------

  async cancelAndRefund(roomId: string) {
    await this.prisma.$transaction(async (tx) => {
      const raceGuard = await tx.room.updateMany({
        where: { id: roomId, status: RoomStatus.WAITING },
        data: { status: RoomStatus.CANCELLED },
      });

      if (raceGuard.count === 0) {
        return;
      }

      const participants = await tx.roomParticipant.findMany({
        where: { roomId },
        include: {
          user: {
            select: { id: true, balanceLucas: true },
          },
        },
      });

      const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } });

      for (const p of participants) {
        const refundAmount =
          room.entryFee + (p.hasPurchasedExtraLife ? room.extraLifeFee : 0);

        await tx.user.update({
          where: { id: p.userId },
          data: { balanceLucas: { increment: refundAmount } },
        });

        await tx.transaction.create({
          data: {
            userId: p.userId,
            amount: refundAmount,
            transactionType: TransactionType.REFUND,
            status: TransactionStatus.COMPLETED,
          },
        });
      }

      this.logger.log(
        `Sala ${roomId} WAITING → CANCELLED (${participants.length} reembolsos)`,
      );
    });
  }
}

function formatBogota(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/** Redondeo de moneda (centavos exactos). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Nivel competitivo por total acumulado de premios. */
function computeTier(totalWon: number): string {
  if (totalWon > TIER_PLATINO_MAX) return 'Nivel Diamante';
  if (totalWon > TIER_ORO_MAX) return 'Nivel Platino';
  if (totalWon > TIER_PLATA_MAX) return 'Nivel Oro';
  if (totalWon > TIER_BRONCE_MAX) return 'Nivel Plata';
  return 'Nivel Bronce';
}

/** Título de torneo derivado del tipo (mockup: título a la izquierda). */
function tournamentDisplayName(type: TournamentType): string {
  switch (type) {
    case TournamentType.DAILY:
      return 'Torneo Diario';
    case TournamentType.WEEKLY:
      return 'Torneo Semanal';
    case TournamentType.BIWEEKLY:
      return 'Torneo Quincenal';
    case TournamentType.CUSTOM_DATE:
      return 'Torneo Especial';
    default:
      return 'Torneo';
  }
}
