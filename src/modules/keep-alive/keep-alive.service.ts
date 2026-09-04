import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class KeepAliveService {
  private readonly logger = new Logger(KeepAliveService.name);

  constructor(private readonly configService: ConfigService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async pingSelf(): Promise<void> {
    const url = this.buildHealthUrl();

    try {
      const response = await fetch(url, { method: 'GET' });
      this.logger.log(`Keep-alive ping a ${url} → HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn(
        `Keep-alive ping a ${url} falló: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private buildHealthUrl(): string {
    const publicUrl = (
      this.configService.get<string>('PUBLIC_URL') ?? ''
    ).replace(/\/+$/, '');

    if (publicUrl) {
      return `${publicUrl}/health`;
    }

    const port = this.configService.get<string>('PORT') ?? '3000';
    return `http://localhost:${port}/health`;
  }
}
