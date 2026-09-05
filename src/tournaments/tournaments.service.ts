import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RoomStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_TIMEZONE } from '../config/timezone';

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  getWaitingRooms() {
    return this.prisma.room.findMany({
      where: { status: RoomStatus.WAITING },
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Cron interno: cada 30s promueve a ACTIVE las salas en WAITING cuyo
   * startTime (timestamptz, instante UTC) ya fue alcanzado por la hora
   * actual de Colombia. La burbuja del servidor corre en America/Bogota
   * (configurado en src/config/timezone.ts), por lo que la transición
   * dispara exactamente a la hora local programada.
   */
  @Interval(30_000)
  async activateStartedRooms() {
    const now = colombianNow();

    const { count } = await this.prisma.room.updateMany({
      where: {
        status: RoomStatus.WAITING,
        startTime: { lte: now },
      },
      data: {
        status: RoomStatus.ACTIVE,
      },
    });

    if (count > 0) {
      this.logger.log(
        `${count} sala(s) en WAITING pasaron a ACTIVE (hora Bogotá: ${formatBogota(now)})`,
      );
    }
  }

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
          'La sala ya no acepta inscripciones en este momento',
        );
      }

      if (room.currentPlayers >= room.maxPlayers) {
        throw new BadRequestException('La sala ya está llena');
      }

      const existingParticipant = await tx.roomParticipant.findUnique({
        where: {
          roomId_userId: {
            roomId,
            userId,
          },
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
        data: {
          balanceLucas: {
            decrement: totalCost,
          },
        },
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
        },
      });

      return tx.room.update({
        where: { id: roomId },
        data: {
          currentPlayers: {
            increment: 1,
          },
        },
      });
    });
  }
}

function colombianNow(): Date {
  return new Date();
}

function formatBogota(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}
