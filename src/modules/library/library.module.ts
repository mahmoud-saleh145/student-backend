import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/devices.module';
import { WalletModule } from '../wallet/wallet.module';

import { LibraryDocumentsService } from './library-documents.service';
import { LibraryPurchaseService } from './library-purchase.service';
import { LibraryAdminController, LibraryController } from './library.controller';
import { LibraryService } from './library.service';

/**
 * The Library: documents sold for wallet credits.
 *
 * `WalletModule` is imported because this is the one subsystem that spends
 * credits. Courses do not appear anywhere in this module, and that absence is
 * the design: the two financial systems are separate, and a course must never
 * be able to reach the wallet through here.
 *
 * `DevicesModule` gives the document path the same device binding that already
 * guards protected course attachments. `StorageModule` and `SecurityModule` are
 * `@Global`, so signing and security events arrive without an import.
 */
@Module({
  imports: [WalletModule, DevicesModule],
  controllers: [LibraryController, LibraryAdminController],
  providers: [LibraryService, LibraryPurchaseService, LibraryDocumentsService],
  exports: [LibraryService, LibraryPurchaseService, LibraryDocumentsService],
})
export class LibraryModule {}
