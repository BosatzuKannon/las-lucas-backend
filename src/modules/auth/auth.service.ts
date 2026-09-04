import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../prisma/prisma.service';
import { GoogleSignInDto } from './dto/google-sign-in.dto';

interface GooglePayload {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    status: string;
    balanceLucas: number;
  };
}

@Injectable()
export class AuthService {
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.googleClient = new OAuth2Client(
      this.configService.get<string>('GOOGLE_CLIENT_ID'),
    );
  }

  async signInWithGoogle(dto: GoogleSignInDto): Promise<AuthResponse> {
    const payload = await this.verifyGoogleToken(dto.idToken);

    const user = await this.prisma.user.upsert({
      where: { googleId: payload.sub },
      update: {
        email: payload.email,
        name: payload.name,
        avatarUrl: payload.picture ?? null,
      },
      create: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        avatarUrl: payload.picture ?? null,
        preference: {
          create: {},
        },
      },
      include: {
        preference: true,
      },
    });

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        status: user.status,
        balanceLucas: user.balanceLucas,
      },
    };
  }

  private async verifyGoogleToken(idToken: string): Promise<GooglePayload> {
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.configService.get<string>('GOOGLE_CLIENT_ID'),
      });

      const payload = ticket.getPayload();

      if (!payload || !payload.sub || !payload.email || !payload.name) {
        throw new UnauthorizedException(
          'Token de Google inválido: payload incompleto',
        );
      }

      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
      };
    } catch {
      throw new UnauthorizedException('Token de Google inválido o expirado');
    }
  }
}
