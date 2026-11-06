import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { DevicesModule } from '../devices/devices.module';
import { WalletModule } from '../wallet/wallet.module';

import { LibraryDocumentsService } from './library-documents.service';
import { LibraryEligibilityService } from './library-eligibility.service';
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
  // `CatalogModule` resolves which year/level ladder governs a faculty or
  // department, for audience validation. It imports nothing, so no cycle.
  imports: [WalletModule, DevicesModule, CatalogModule],
  controllers: [LibraryController, LibraryAdminController],
  providers: [
    LibraryService,
    LibraryPurchaseService,
    LibraryDocumentsService,
    LibraryEligibilityService,
  ],
  exports: [LibraryService, LibraryPurchaseService, LibraryDocumentsService],
})
export class LibraryModule {}
