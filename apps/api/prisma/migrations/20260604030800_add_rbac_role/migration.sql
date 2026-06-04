-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'OFFICE_STAFF', 'DRIVER');

-- AlterTable
-- The column default is OFFICE_STAFF (least privilege) so every NEW user
-- created after this migration is OFFICE_STAFF unless explicitly promoted.
ALTER TABLE "user" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'OFFICE_STAFF';

-- Backfill existing users to ADMIN (ADR-0028 commitment 8). The ADD COLUMN
-- above set every existing row to the OFFICE_STAFF default; the only user
-- that exists when this migration runs in production is the CEO admin
-- (ADR-0021's seeded single user), who must keep full access across this
-- change. Without this UPDATE the CEO would be silently downgraded to
-- OFFICE_STAFF and locked out of the ADMIN-only surfaces (raw GPS,
-- observability, user/role administration) the moment they land. The
-- OFFICE_STAFF default applies only to users created AFTER this point.
-- On a fresh database (e.g. the CI/test DB before any user is seeded) this
-- UPDATE matches zero rows and is a harmless no-op.
UPDATE "user" SET "role" = 'ADMIN';
