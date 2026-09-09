import { Module } from '@nestjs/common';
import { GameplayGateway } from './gameplay.gateway';
import { GameplayService } from './gameplay.service';
import { SocketAuthService } from './socket-auth.service';

@Module({
  providers: [GameplayGateway, GameplayService, SocketAuthService],
  exports: [GameplayGateway, GameplayService],
})
export class GameplayModule {}
