import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameplayGateway } from './gameplay.gateway';
import { GameplayService } from './gameplay.service';

@Module({
  imports: [AuthModule],
  providers: [GameplayGateway, GameplayService],
  exports: [GameplayGateway, GameplayService],
})
export class GameplayModule {}
