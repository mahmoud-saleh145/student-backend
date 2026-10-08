import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { PasswordService } from '../auth/password.service';

import { ProfileController } from './profile.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [CatalogModule],
  controllers: [ProfileController, UsersController],
  // PasswordService is provided here as well as in AuthModule so UsersModule
  // can be imported by AuthModule without a circular dependency.
  providers: [UsersService, PasswordService],
  exports: [UsersService],
})
export class UsersModule {}
