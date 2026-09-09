import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RoomStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GameplayGateway } from '../modules/gameplay/gameplay.gateway';
import { DEFAULT_TIMEZONE } from '../config/timezone';

/** Ventana de espera de la sala de espera (10 minutos). */
const WAITING_WINDOW_MS = 10 * 60 * 1000;

/** Duración de la fase de votación de categoría (45 segundos). */
const VOTING_WINDOW_MS = 45 * 1000;

/**
 * Buffer de conexión al pasar una sala a ACTIVE: tiempo que se espera antes de
 * disparar la primera pregunta para que los clientes React Native terminen de
 * montar GameplayScreen y conecten su WebSocket al namespace `/gameplay`.
 */
const GAME_START_CONNECTION_BUFFER_MS = 5_000;

/** Pausa asíncrona que no bloquea el event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        const votingDeadline = new Date(Date.now() + VOTING_WINDOW_MS);
        updatedRoom = await tx.room.update({
          where: { id: roomId },
          data: {
            status: RoomStatus.VOTING,
            startTime: votingDeadline,
          },
        });
        this.logger.log(
          `Sala ${roomId} WAITING → VOTING (llenada por inscripción, cierre de votación ${formatBogota(votingDeadline)})`,
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

  @Interval(30_000)
  async processRoomLifecycle() {
    const now = new Date();

    const openingTime = new Date(now.getTime() + WAITING_WINDOW_MS);

    const { count: scheduledToWaiting } = await this.prisma.room.updateMany({
      where: {
        status: RoomStatus.SCHEDULED,
        startTime: { lte: openingTime },
      },
      data: {
        status: RoomStatus.WAITING,
        startTime: openingTime,
      },
    });

    if (scheduledToWaiting > 0) {
      this.logger.log(
        `${scheduledToWaiting} sala(s) abiertas → WAITING, ventana garantizada de 10 min desde ${formatBogota(
          openingTime,
        )}`,
      );
    }

    const waitingRooms = await this.prisma.room.findMany({
      where: { status: RoomStatus.WAITING },
    });

    for (const room of waitingRooms) {
      if (room.currentPlayers >= room.maxPlayers) {
        const votingDeadline = new Date(Date.now() + VOTING_WINDOW_MS);
        const { count } = await this.prisma.room.updateMany({
          where: { id: room.id, status: RoomStatus.WAITING },
          data: {
            status: RoomStatus.VOTING,
            startTime: votingDeadline,
          },
        });
        if (count > 0) {
          this.logger.log(
            `Sala ${room.id} WAITING → VOTING (llena) (cierre ${formatBogota(votingDeadline)})`,
          );
        }
      } else if (room.startTime <= now) {
        await this.cancelAndRefund(room.id);
      }
    }
  }

  /**
   * Worker que cierra la fase de votación de todas las salas en VOTING cuyo
   * tiempo de cierre (startTime) ya pasó.
   *
   * Desempate por votos:
   *  - 0 votos → selección aleatoria entre categorías activas.
   *  - 1er lugar empatado → gana la categoría cuyo último voto fue más
   *    temprano (MIN(votePerCategory.MAX(votedAt))).
   */
  @Interval(5_000)
  async processVotingRooms() {
    const now = new Date();

    const votingRooms = await this.prisma.room.findMany({
      where: {
        status: RoomStatus.VOTING,
        startTime: { lte: now },
      },
      select: {
        id: true,
        startTime: true,
      },
    });

    if (votingRooms.length === 0) {
      return;
    }

    this.logger.log(
      `Cerrando votación de ${votingRooms.length} sala(s)… (${formatBogota(now)})`,
    );

    for (const room of votingRooms) {
      const participants = await this.prisma.roomParticipant.findMany({
        where: {
          roomId: room.id,
          votedCategoryId: { not: null },
        },
        select: {
          votedCategoryId: true,
          votedAt: true,
        },
      });

      let selectedCategoryId: string | null = null;

      if (participants.length === 0) {
        // 0 votos → categoría activa aleatoria.
        const activeCategories = await this.prisma.category.findMany({
          where: { isActive: true },
          select: { id: true },
        });

        if (activeCategories.length > 0) {
          selectedCategoryId =
            activeCategories[
              Math.floor(Math.random() * activeCategories.length)
            ].id;
        } else {
          // Fallback: cualquier categoría.
          const anyCategory = await this.prisma.category.findFirst({
            select: { id: true },
          });
          selectedCategoryId = anyCategory?.id ?? null;
        }

        this.logger.log(
          `Sala ${room.id}: 0 votos → categoría aleatoria: ${selectedCategoryId ?? 'N/A'}`,
        );
      } else {
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

        // Máxima cantidad de votos.
        let maxCount = 0;
        for (const n of counts.values()) {
          if (n > maxCount) maxCount = n;
        }

        // Categorías empatadas en primer lugar.
        const leaders = [...counts.entries()]
          .filter(([, n]) => n === maxCount)
          .map(([catId]) => catId);

        // Desempate: MIN(MAX(votedAt)) → el que tiene el último voto más temprano.
        let bestCat = leaders[0];
        let bestLastVote = lastVotedAt.get(bestCat) ?? Infinity;

        for (const catId of leaders.slice(1)) {
          const t = lastVotedAt.get(catId) ?? Infinity;
          if (t < bestLastVote) {
            bestCat = catId;
            bestLastVote = t;
          }
        }

        selectedCategoryId = bestCat;
        this.logger.log(
          `Sala ${room.id}: ${participants.length} voto(s) → categoría ganadora: ${selectedCategoryId} (${maxCount} voto(s))`,
        );
      }

      // Cerrar la votación y activar la partida (guarda selectedCategoryId).
      const { count } = await this.prisma.room.updateMany({
        where: { id: room.id, status: RoomStatus.VOTING },
        data: {
          status: RoomStatus.ACTIVE,
          selectedCategoryId,
        },
      });

      if (count > 0) {
        this.logger.log(
          `Sala ${room.id} VOTING → ACTIVE (categoría: ${selectedCategoryId ?? 'N/A'})`,
        );

        // Buffer de conexión: da tiempo a los clientes para montar la pantalla
        // y conectar su WebSocket antes de la primera pregunta. La sala ya está
        // en ACTIVE, así que el cron no la vuelve a procesar durante la espera.
        const startTime = Date.now() + GAME_START_CONNECTION_BUFFER_MS;
        this.gameplayGateway.startGameCountdown(room.id, startTime);
        await delay(GAME_START_CONNECTION_BUFFER_MS);

        const started = await this.gameplayGateway.startQuestion(room.id);

        if (!started) {
          await this.gameplayGateway.finishGameWithAlive(room.id);
        }
      }
    }
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
