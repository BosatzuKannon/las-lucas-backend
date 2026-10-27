import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  InvalidWebhookSignatureError,
  MercadoPagoConfig,
  Payment,
  Preference,
  WebhookSignatureValidator,
} from 'mercadopago';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

interface WebhookContext {
  type: string | undefined;
  dataId: string | undefined;
  xSignature: string | undefined;
  xRequestId: string | undefined;
}

@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly preference: Preference;
  private readonly payment: Payment;
  private readonly webhookSecret: string;
  private readonly publicUrl: string;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const accessToken = configService.get<string>('MERCADOPAGO_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('MERCADOPAGO_ACCESS_TOKEN is not configured');
    }
    this.webhookSecret =
      configService.get<string>('MERCADOPAGO_WEBHOOK_SECRET') ?? '';
    this.publicUrl = configService.get<string>('PUBLIC_URL') ?? '';
    const client = new MercadoPagoConfig({
      accessToken,
      options: { timeout: 15_000 },
    });
    this.preference = new Preference(client);
    this.payment = new Payment(client);
  }

  async createCheckout(userId: string, dto: CreateCheckoutDto) {
    const transaction = await this.prisma.transaction.create({
      data: {
        userId,
        amount: dto.amount,
        transactionType: 'RECHARGE',
        status: TransactionStatus.PENDING,
        reference: `MP-${randomUUID()}`,
      },
    });

    const baseUrl = this.baseUrl();
    const preference = await this.preference.create({
      body: {
        items: [
          {
            id: 'lucas_recharge',
            title: 'Recarga de Lucas',
            quantity: 1,
            unit_price: dto.amount,
            currency_id: 'COP',
          },
        ],
        external_reference: transaction.id,
        metadata: { transactionId: transaction.id, userId },
        back_urls: {
          success: `${baseUrl}/payments/result?status=approved`,
          pending: `${baseUrl}/payments/result?status=pending`,
          failure: `${baseUrl}/payments/result?status=failed`,
        },
        notification_url: `${baseUrl}/webhooks/mercadopago`,
        auto_return: 'approved',
      },
    });

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { externalTransactionId: preference.id },
    });

    const initPoint = preference.init_point ?? preference.sandbox_init_point;
    if (!initPoint) {
      throw new InternalServerErrorException(
        'Mercado Pago did not return an init_point',
      );
    }

    return {
      transactionId: transaction.id,
      preferenceId: preference.id,
      initPoint,
    };
  }

  async processWebhook(context: WebhookContext) {
    WebhookSignatureValidator.validate({
      xSignature: context.xSignature,
      xRequestId: context.xRequestId,
      dataId: context.dataId,
      secret: this.requireWebhookSecret(),
      toleranceSeconds: 600,
    });

    if (context.type !== 'payment' || !context.dataId) {
      return { received: true, processed: false };
    }

    return this.processPaymentNotification(context.dataId);
  }

  private requireWebhookSecret(): string {
    if (!this.webhookSecret) {
      throw new InternalServerErrorException(
        'MERCADOPAGO_WEBHOOK_SECRET is not configured',
      );
    }
    return this.webhookSecret;
  }

  private async processPaymentNotification(paymentId: string) {
    const payment = await this.payment.get({ id: paymentId });

    const transaction = await this.resolveTransaction(paymentId, payment);
    if (!transaction) {
      this.logger.warn(
        `Webhook payment ${paymentId}: no transaction found (external_reference=${String(payment.external_reference)})`,
      );
      return { received: true, processed: false };
    }

    const amount = transaction.amount;
    const paymentMethodExtra = {
      id: payment.id,
      statusDetail: payment.status_detail,
      operationType: payment.operation_type,
      paymentTypeId: payment.payment_type_id,
      installments: payment.installments,
      feeDetails: payment.fee_details ?? [],
      externalReference: payment.external_reference,
    };

    const isApproved = payment.status === 'approved';
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.transaction.updateMany({
        where: {
          id: transaction.id,
          status: TransactionStatus.PENDING,
        },
        data: {
          status: isApproved
            ? TransactionStatus.COMPLETED
            : TransactionStatus.FAILED,
          externalTransactionId: String(payment.id),
          paymentMethodType: payment.payment_type_id ?? null,
          paymentMethodExtra,
        },
      });

      if (updated.count === 0) {
        return { updated: false as const };
      }

      if (isApproved) {
        await tx.user.update({
          where: { id: transaction.userId },
          data: { balanceLucas: { increment: amount } },
        });
      }

      return { updated: true as const };
    });

    this.logger.log(
      `Webhook payment ${paymentId} (${payment.status}): transaction ${transaction.id} -> ${
        result.updated ? 'processed' : 'already settled'
      }`,
    );

    return { received: true, processed: result.updated };
  }

  private async resolveTransaction(
    paymentId: string,
    payment: Awaited<ReturnType<Payment['get']>>,
  ) {
    const externalReference =
      typeof payment.external_reference === 'string'
        ? payment.external_reference
        : undefined;

    if (externalReference) {
      const byRef = await this.prisma.transaction.findUnique({
        where: { id: externalReference },
      });
      if (byRef) return byRef;
    }

    const transactionId = (payment.metadata as Record<string, unknown> | null)
      ?.transactionId;
    if (typeof transactionId === 'string' && transactionId) {
      const byMetadata = await this.prisma.transaction.findUnique({
        where: { id: transactionId },
      });
      if (byMetadata) return byMetadata;
    }

    return this.prisma.transaction.findUnique({
      where: { externalTransactionId: paymentId },
    });
  }

  static isInvalidSignatureError(
    error: unknown,
  ): error is InvalidWebhookSignatureError {
    return error instanceof InvalidWebhookSignatureError;
  }

  private baseUrl(): string {
    if (!this.publicUrl) {
      throw new InternalServerErrorException(
        'PUBLIC_URL is not configured (required for Checkout Pro back_urls / notification_url)',
      );
    }
    return this.publicUrl;
  }
}
