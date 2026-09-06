import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsString } from 'class-validator';

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsJWT({ message: 'refreshToken must be a JWT' })
  refreshToken!: string;
}
