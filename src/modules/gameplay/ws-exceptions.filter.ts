import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * Captura excepciones no controladas en los handlers de mensajes del
 * namespace `/gameplay`. Por defecto, NestJS emite un evento `exception` que
 * el cliente NO escucha y nunca invoca el ack, dejando al frontend esperando
 * hasta su timeout. Este filtro acusa el error al socket emisor (cuando hay
 * callback de ack) y, si no lo hay, emite `exception` como fallback.
 */
@Catch()
export class WsGameplayExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('WsGameplay');
  private readonly defaultMessage = 'Error interno del servidor de la partida';

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToWs();
    const client = ctx.getClient<Socket>();
    const data: unknown = ctx.getData();
    const message = this.extractMessage(exception);

    this.logger.error(
      `Excepción en websocket: ${JSON.stringify(data)} → ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    const args = host.getArgs();
    const ack =
      typeof args[args.length - 1] === 'function'
        ? (args[args.length - 1] as (response: unknown) => void)
        : undefined;

    if (ack) {
      ack({ event: 'exception', data: { ok: false, message } });
      return;
    }

    client.emit('exception', { message });
  }

  private extractMessage(exception: unknown): string {
    if (exception instanceof WsException) {
      const error = exception.getError();

      if (typeof error === 'string') {
        return error;
      }

      if (error && typeof error === 'object' && 'message' in error) {
        const raw = (error as { message?: unknown }).message;
        if (typeof raw === 'string' && raw.length > 0) {
          return raw;
        }
      }
    }

    if (exception instanceof Error && exception.message?.length > 0) {
      return exception.message;
    }

    return this.defaultMessage;
  }
}
