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

const WAITING_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  @Interval(30_000)
  async processRoomLifecycle() {
    const now = new Date();

    const { count: scheduledToWaiting } = await this.prisma.room.updateMany({
      where: {
        status: RoomStatus.SCHEDULED,
        startTime: { lte: new Date(now.getTime() + WAITING_WINDOW_MS) },
      },
      data: { status: RoomStatus.WAITING },
    });

    if (scheduledToWaiting > 0) {
      this.logger.log(
        `${scheduledToWaiting} sala(s) SCHEDULED → WAITING (${formatBogota(now)})`,
      );
    }

    const waitingExpired = await this.prisma.room.findMany({
      where: {
        status: RoomStatus.WAITING,
        startTime: { lte: now },
      },
    });

    for (const room of waitingExpired) {
      if (room.currentPlayers >= room.maxPlayers) {
        await this.prisma.room.update({
          where: { id: room.id },
          data: { status: RoomStatus.ACTIVE },
        });
        this.logger.log(
          `Sala ${room.id} WAITING → ACTIVE (llena) (${formatBogota(now)})`,
        );
      } else {
        await this.cancelAndRefund(room.id);
      }
    }
  }

  async cancelAndRefund(roomId: string) {
    await this.prisma.$transaction(async (tx) => {
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

      await tx.room.update({
        where: { id: roomId },
        data: { status: RoomStatus.CANCELLED },
      });

      this.logger.log(
        `Sala ${roomId} WAITING → CANCELLED (${participants.length} reembolsos)`,
      );
    });
  }

  async joinTournament(userId: string, roomId: string, buyExtraLife: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
      });

      if (!room) {
        throw new NotFoundException('Sala de torneo no encontrada');
      }

      if (
        room.status !== RoomStatus.SCHEDULED &&
        room.status !== RoomStatus.WAITING
      ) {
        throw new BadRequestException(
          'La sala ya no acepta inscripciones en este momento',
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
        },
      });

      const updatedRoom = await tx.room.update({
        where: { id: roomId },
        data: { currentPlayers: { increment: 1 } },
      });

      if (updatedRoom.currentPlayers >= updatedRoom.maxPlayers) {
        await tx.room.update({
          where: { id: roomId },
          data: { status: RoomStatus.ACTIVE },
        });
        this.logger.log(
          `Sala ${roomId} → ACTIVE (llenada por inscripción)`,
        );
      }

      return updatedRoom;
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
