import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";

// The FleetDocument aggregate module (ADR-0049 F2): fleet papers attached to
// vehicles / drivers / customers, stored through the shared ObjectStorage
// seam — the seam's THIRD consumer (after invoices and agent attachments),
// exactly the promotion path ADR-0039 c7 pre-authorized. DocumentsService is
// exported for F3's renewal flow (the vehicles module validates a linked
// document through this public interface, never through the table).
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
