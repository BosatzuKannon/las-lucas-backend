import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SubmitAnswerDto {
  @IsString()
  @IsNotEmpty()
  roomId: string;

  @IsString()
  @IsNotEmpty()
  questionId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  answer: string;
}
