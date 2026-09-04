import { IsString, IsNotEmpty } from 'class-validator';

export class GoogleSignInDto {
  @IsString()
  @IsNotEmpty()
  idToken!: string;
}
