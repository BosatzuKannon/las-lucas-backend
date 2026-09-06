import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export interface AuthUser {
  sub: string;
  email?: string;
  aud?: string;
  role?: string;
  [key: string]: unknown;
}

export type AuthenticatedRequest = import('express').Request & {
  user: AuthUser;
};

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
