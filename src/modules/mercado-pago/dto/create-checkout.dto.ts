import { IsNumber, IsPositive, Max } from 'class-validator';

export class CreateCheckoutDto {
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;
}
