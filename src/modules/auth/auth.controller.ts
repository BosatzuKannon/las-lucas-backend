import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleSignInDto } from './dto/google-sign-in.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  async signInWithGoogle(@Body() dto: GoogleSignInDto) {
    return this.authService.signInWithGoogle(dto);
  }
}
