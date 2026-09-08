import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { DefaultEventsMap, Server, Socket } from 'socket.io';
import type { AuthUser } from '../auth/jwt-auth.guard';
import {
  GameplayService,
  QUESTION_RESULTS_GRACE_MS,
  type QuestionStarted,
  type QuestionStartedPayload,
  type SubmitAnswerResult,
} from './gameplay.service';
import { JoinRoomDto } from './dto/join-room.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

export interface GameplaySocketData {
  user?: AuthUser;
  roomId?: string;
}

type GameplaySocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  GameplaySocketData
>;

@WebSocketGateway({
  namespace: '/gameplay',
  cors: true,
})
export class GameplayGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(GameplayGateway.name);
  private readonly finishTimers = new Map<string, NodeJS.Timeout>();
  private readonly nextQuestionTimers = new Map<string, NodeJS.Timeout>();

  /** Salas en ventana de inicio (`roomId` → timestamp de la 1ª pregunta). */
  private readonly startingGames = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly gameplayService: GameplayService,
    private readonly jwtService: JwtService,
  ) {}

  handleConnection(client: GameplaySocket): void {
    const token = this.extractToken(client);

    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      const claims = this.jwtService.verify<AuthUser>(token);
      client.data.user = { sub: claims.sub, email: claims.email };
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: GameplaySocket): void {
    client.data.roomId = undefined;
  }

  @SubscribeMessage('join_room')
  async joinRoom(
    @ConnectedSocket() client: GameplaySocket,
    @MessageBody() dto: JoinRoomDto,
  ) {
    const user = client.data.user!;

    if (!(await this.gameplayService.isParticipant(dto.roomId, user.sub))) {
      client.emit('error', { message: 'No eres participante de esta sala' });
      return;
    }

    await client.join(dto.roomId);
    client.data.roomId = dto.roomId;

    return {
      event: 'join_room',
      data: {
        ok: true,
        roomId: dto.roomId,
        activeQuestion: this.gameplayService.getActiveQuestion(dto.roomId),
        gameStarting: this.getGameStarting(dto.roomId),
      },
    };
  }

  @SubscribeMessage('submit_answer')
  submitAnswer(
    @ConnectedSocket() client: GameplaySocket,
    @MessageBody() dto: SubmitAnswerDto,
  ): { event: 'submit_answer'; data: SubmitAnswerResult } {
    const user = client.data.user!;
    const result = this.gameplayService.submitAnswer(
      dto.roomId,
      dto.questionId,
      user.sub,
      dto.answer,
    );

    return { event: 'submit_answer', data: result };
  }

  async startQuestion(
    roomId: string,
    questionId?: string,
  ): Promise<QuestionStartedPayload | null> {
    // Terminó la ventana de inicio: deja de reportarla en el ack de join_room.
    this.startingGames.delete(roomId);

    const started = await this.gameplayService.startQuestion(
      roomId,
      questionId,
    );

    if (!started) {
      return null;
    }

    this.broadcastQuestionStarted(roomId, started);

    return started.payload;
  }

  /**
   * Activa la ventana de inicio de la partida: anuncia a la sala y registra el
   * `startTime` (instante en que arranca la primera pregunta) para que los
   * clientes que conecten durante este lapso lo reciban vía el ack de
   * `join_room` y puedan mostrar su contador 5, 4, 3, 2, 1.
   */
  startGameCountdown(roomId: string, startTime: number): void {
    this.startingGames.set(roomId, startTime);
    this.server.to(roomId).emit('game_starting', { startTime });

    this.logger.log(
      `Sala ${roomId} en ventana de inicio (#1 pregunta a las ${startTime})`,
    );
  }

  /**
   * Devuelve el estado de inicio activo de una sala, o `null` si su ventana
   * ya venció (o nunca existió). Limpia la entrada vencida del mapa.
   */
  private getGameStarting(roomId: string): { startTime: number } | null {
    const startTime = this.startingGames.get(roomId);

    if (startTime === undefined || startTime <= Date.now()) {
      this.startingGames.delete(roomId);
      return null;
    }

    return { startTime };
  }

  async finishGame(roomId: string, survivors: number): Promise<void> {
    this.startingGames.delete(roomId);

    const finished = await this.gameplayService.finishRoom(roomId);

    if (!finished) {
      return;
    }

    this.server.to(roomId).emit('game_finished', { roomId, survivors });

    this.logger.log(
      `Sala ${roomId} terminada con ${survivors} superviviente(s)`,
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.finishTimers.values()) {
      clearTimeout(timer);
    }

    for (const timer of this.nextQuestionTimers.values()) {
      clearTimeout(timer);
    }

    this.finishTimers.clear();
    this.nextQuestionTimers.clear();
    this.startingGames.clear();
  }

  private scheduleFinish(
    roomId: string,
    questionId: string,
    finishAt: number,
  ): void {
    const previous = this.finishTimers.get(roomId);

    if (previous) {
      clearTimeout(previous);
    }

    const delay = Math.max(0, finishAt - Date.now());
    const timer = setTimeout(() => {
      this.finishTimers.delete(roomId);
      void this.finishQuestion(roomId, questionId);
    }, delay);

    this.finishTimers.set(roomId, timer);
  }

  private async finishQuestion(
    roomId: string,
    questionId: string,
  ): Promise<void> {
    const results = await this.gameplayService.finalizeQuestion(
      roomId,
      questionId,
    );

    if (!results) {
      return;
    }

    this.server.to(roomId).emit('question_results', results);

    this.logger.log(
      `Pregunta ${questionId} finalizada en sala ${roomId}: ${results.survivors} superviviente(s)`,
    );

    if (results.survivors === 0) {
      await this.finishGame(roomId, 0);
      return;
    }

    const graceTimer = setTimeout(() => {
      this.nextQuestionTimers.delete(roomId);
      void this.runNextQuestion(roomId, results.survivors);
    }, QUESTION_RESULTS_GRACE_MS);

    this.nextQuestionTimers.set(roomId, graceTimer);
  }

  private async runNextQuestion(
    roomId: string,
    lastSurvivors: number,
  ): Promise<void> {
    const started = await this.gameplayService.startQuestion(roomId);

    if (!started) {
      await this.finishGame(roomId, lastSurvivors);
      return;
    }

    this.broadcastQuestionStarted(roomId, started);
  }

  private broadcastQuestionStarted(
    roomId: string,
    started: QuestionStarted,
  ): void {
    this.scheduleFinish(roomId, started.questionId, started.finishAt);
    this.server.to(roomId).emit('question_started', started.payload);

    this.logger.log(
      `Pregunta ${started.questionId} iniciada en sala ${roomId} (endTime ${started.endTime})`,
    );
  }

  private extractToken(client: GameplaySocket): string | undefined {
    const authToken = client.handshake.auth?.token as string | undefined;

    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }

    const authorization = client.handshake.headers.authorization;

    if (typeof authorization === 'string') {
      const [scheme, token] = authorization.split(' ');

      if (scheme?.toLowerCase() === 'bearer' && token) {
        return token;
      }
    }

    return undefined;
  }
}
