import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { MercadoPagoService } from './mercado-pago.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

@Controller()
export class MercadoPagoController {
  constructor(private readonly mercadoPagoService: MercadoPagoService) {}

  @Post('payments/checkout')
  @UseGuards(JwtAuthGuard)
  async createCheckout(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.mercadoPagoService.createCheckout(req.user.sub, dto);
  }

  @Post('webhooks/mercadopago')
  @HttpCode(200)
  async handleWebhook(
    @Query() query: Record<string, string>,
    @Headers('x-signature') xSignature: string | undefined,
    @Headers('x-request-id') xRequestId: string | undefined,
    // Body plano: el ValidationPipe global no valida Object sin decoradores.
    @Body() body: Record<string, unknown>,
  ) {
    const type =
      query['type'] ??
      query['topic'] ??
      this.asType(body?.['type']) ??
      this.asType(body?.['topic']);
    const dataId = query['data.id'] ?? this.asType(this.extractDataId(body));

    try {
      return await this.mercadoPagoService.processWebhook({
        type,
        dataId,
        xSignature,
        xRequestId,
      });
    } catch (error) {
      if (MercadoPagoService.isInvalidSignatureError(error)) {
        throw new UnauthorizedException('Invalid Mercado Pago signature');
      }
      throw error;
    }
  }

  private asType(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  private extractDataId(body: Record<string, unknown> | undefined): unknown {
    const data = body?.['data'] as { id?: unknown } | undefined;
    if (typeof data?.id === 'string' || typeof data?.id === 'number') {
      return data.id;
    }
    // Notificaciones legacy usan `resource` (topic + url) id en el último tramo.
    if (typeof body?.['resource'] === 'string') {
      const parts = body['resource'].split('/');
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    return undefined;
  }
}
