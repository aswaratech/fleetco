-- AlterTable: add the nullable User login link to Driver (ADR-0034 c4). Nullable
-- so existing drivers (created before driver logins existed) are unaffected; an
-- operator populates it when provisioning a login for a driver.
ALTER TABLE "driver" ADD COLUMN     "userId" TEXT;

-- CreateIndex: one login maps to at most one Driver (@unique).
CREATE UNIQUE INDEX "driver_userId_key" ON "driver"("userId");

-- AddForeignKey: Driver.userId -> User.id. onDelete: Restrict — a User with a
-- linked Driver cannot be deleted out from under it. onUpdate: Cascade is the
-- Prisma default for relations.
ALTER TABLE "driver" ADD CONSTRAINT "driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
