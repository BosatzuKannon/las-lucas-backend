import { Module } from '@nestjs/common';
import { AuthModule } from '../modules/auth/auth.module';
import { GameplayModule } from '../modules/gameplay/gameplay.module';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  imports: [AuthModule, GameplayModule],
  controllers: [TournamentsController],
  providers: [TournamentsService],
  exports: [TournamentsService],
})
export class TournamentsModule {}
