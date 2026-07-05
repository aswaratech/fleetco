import { Module } from "@nestjs/common";

import { env } from "../../config/env";
import { MockObjectStorage } from "./mock.object-storage";
import { ObjectStorage } from "./object-storage";
import { R2ObjectStorage } from "./r2.object-storage";

// StorageModule — the shared object-storage seam (ADR-0044 V2, executing the
// promotion ADR-0039 c7 pre-authorized: "a MOVE, not a rewrite"). Owns the ONE
// ObjectStorage factory, moved verbatim from InvoicesModule: R2ObjectStorage
// when the operator-supplied R2_* creds are all present (production), the
// no-network MockObjectStorage everywhere they are absent (dev / test / CI) —
// the Mailer's ResendMailer/MockMailer split. The factory is keyed on the R2
// creds' presence, read through the typed env, never logged. Consumers import
// THIS module and inject the ObjectStorage abstract-class token; nothing
// outside modules/storage may import the S3 SDK.
@Module({
  providers: [
    {
      provide: ObjectStorage,
      useFactory: (): ObjectStorage =>
        env.R2_ENDPOINT !== undefined &&
        env.R2_ENDPOINT !== "" &&
        env.R2_ACCESS_KEY_ID !== undefined &&
        env.R2_ACCESS_KEY_ID !== "" &&
        env.R2_SECRET_ACCESS_KEY !== undefined &&
        env.R2_SECRET_ACCESS_KEY !== "" &&
        env.R2_BUCKET !== undefined &&
        env.R2_BUCKET !== ""
          ? new R2ObjectStorage()
          : new MockObjectStorage(),
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
