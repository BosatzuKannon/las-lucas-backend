import { IsBoolean, IsOptional } from 'class-validator';

export class JoinTournamentDto {
  @IsOptional()
  @IsBoolean()
  buyExtraLife?: boolean;
}
