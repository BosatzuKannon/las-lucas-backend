import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decode, verify } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import type { AuthUser } from '../auth/jwt-auth.guard';

/**
 * Valida los JWT del cliente de la MISMA forma que la API REST (`JwtStrategy`,
 * que usa el JWKS de Supabase con algoritmos RS256/ES256).
 *
 * MOTIVO: el `accessToken` del app es un token emitido por Supabase Auth
 * (firmado RS256/ES256). El gateway NO debe usar `JwtService` (`@nestjs/jwt`,
 * HS256 con `JWT_SECRET`): verificar un token RS256 como HS256 lanza
 * `invalid signature`, y el antiguo `catch` vacío en `handleConnection`
 * desconectaba silenciosamente el socket justo tras el handshake
 * (`io server disconnect`).
 */
@Injectable()
export class SocketAuthService {
  private readonly logger = new Logger(SocketAuthService.name);
  private readonly jwksClient: JwksClient;

  constructor(configService: ConfigService) {
    const supabaseUrl = configService.get<string>('SUPABASE_URL');

    this.jwksClient = new JwksClient({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    });
  }

  /**
   * Devuelve el usuario autenticado o `null` si el token no es válido,
   * está malformado o fue firmado por una clave distinta del JWKS.
   */
  async verifyToken(token: string): Promise<AuthUser | null> {
    const decoded = decode(token, { complete: true });

    if (!decoded || typeof decoded.payload !== 'object') {
      return null;
    }

    const kid = decoded.header.kid;

    if (!kid) {
      return null;
    }

    try {
      const signingKey = await this.jwksClient.getSigningKey(kid);
      const payload = verify(token, signingKey.getPublicKey(), {
        algorithms: ['RS256', 'ES256'],
      }) as AuthUser;

      return {
        sub: String(payload.sub ?? ''),
        email: payload.email,
      };
    } catch (error) {
      this.logger.warn(
        `Token rechazado: ${error instanceof Error ? error.message : 'desconocido'}`,
      );
      return null;
    }
  }
}
