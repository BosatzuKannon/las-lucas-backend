import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import type { GetSeasonCurrentDto } from './dto/seasons.dto';
import { SeasonsService } from './seasons.service';

@Controller('seasons')
export class SeasonsController {
  constructor(private readonly seasonsService: SeasonsService) {}

  @Get('current')
  @UseGuards(JwtAuthGuard)
  getSeasonCurrent(): Promise<GetSeasonCurrentDto> {
    return this.seasonsService.getSeasonCurrent();
  }
}