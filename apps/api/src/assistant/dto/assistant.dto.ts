import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_QUESTION_LENGTH } from '../application/chat-engine';

export class AskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_QUESTION_LENGTH)
  text!: string;

  /** The project the page shows, as context for the model; never a path. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{22}$/)
  projectId?: string;

  @IsOptional()
  @IsIn(['de-CH', 'en'])
  locale?: 'de-CH' | 'en';
}
