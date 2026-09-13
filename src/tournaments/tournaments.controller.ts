import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../modules/auth/jwt-auth.guard';
import { JoinTournamentDto } from './dto/join-tournament.dto';
import { VoteDto } from './dto/vote.dto';
import type {
  GetHistoryGlobalDto,
  GetHistoryMeDto,
  GetHistoryStatsDto,
} from './dto/history.dto';
import { TournamentsService } from './tournaments.service';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournamentsService: TournamentsService) {}

  @Get()
  getOpenRooms() {
    return this.tournamentsService.getOpenRooms();
  }

  // ---------- Historial (Fase 2: Ranking de Temporadas) ----------

  @Get('history/stats')
  @UseGuards(JwtAuthGuard)
  getHistoryStats(
    @Req() req: AuthenticatedRequest,
  ): Promise<GetHistoryStatsDto> {
    return this.tournamentsService.getHistoryStats(req.user.sub);
  }

  @Get('history/global')
  @UseGuards(JwtAuthGuard)
  getHistoryGlobal(): Promise<GetHistoryGlobalDto> {
    return this.tournamentsService.getHistoryGlobal();
  }

  @Get('history/me')
  @UseGuards(JwtAuthGuard)
  getHistoryMe(@Req() req: AuthenticatedRequest): Promise<GetHistoryMeDto> {
    return this.tournamentsService.getHistoryMe(req.user.sub);
  }

  @Get(':id/waiting-room')
  @UseGuards(JwtAuthGuard)
  getWaitingRoom(
    @Req() req: AuthenticatedRequest,
    @Param('id') roomId: string,
  ) {
    return this.tournamentsService.getWaitingRoom(roomId);
  }

  @Post(':id/join')
  @UseGuards(JwtAuthGuard)
  joinTournament(
    @Req() req: AuthenticatedRequest,
    @Param('id') roomId: string,
    @Body() dto: JoinTournamentDto,
  ) {
    return this.tournamentsService.joinTournament(
      req.user.sub,
      roomId,
      dto.buyExtraLife ?? false,
    );
  }

  @Post(':id/vote')
  @UseGuards(JwtAuthGuard)
  voteForRoom(
    @Req() req: AuthenticatedRequest,
    @Param('id') roomId: string,
    @Body() dto: VoteDto,
  ) {
    return this.tournamentsService.voteForRoom(
      req.user.sub,
      roomId,
      dto.categoryId,
    );
  }
}
