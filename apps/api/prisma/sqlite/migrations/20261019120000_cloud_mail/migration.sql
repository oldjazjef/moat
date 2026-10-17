-- Moat Cloud and e-mail: a verified address, one-time tokens, invitations for unknown addresses
-- (T-96 to T-99). Keep the CHECKs equal in meaning to ../../../postgresql/migrations.

-- AlterTable
-- NULL = not verified. A deployment without SMTP treats every account as verified (it has no way
-- to send the link); one with SMTP requires it at sign-in.
ALTER TABLE "account" ADD COLUMN "email_verified_at" TEXT CHECK ("email_verified_at" IS NULL OR "email_verified_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z');

-- CreateTable
-- A link token (verify an address, reset a password). Only the SHA-256 of the 256-bit token is
-- stored, so a database copy opens nothing. Single use: `used_at` is set by a compare-and-set.
CREATE TABLE "account_token" (
    "id" TEXT NOT NULL PRIMARY KEY CHECK (length("id") = 64 AND "id" NOT GLOB '*[^0-9a-f]*'),
    "account_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL CHECK ("purpose" IN ('verify_email', 'reset_password')),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "expires_at" TEXT NOT NULL CHECK ("expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "used_at" TEXT CHECK ("used_at" IS NULL OR "used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    CONSTRAINT "account_token_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "account_token_account_id_purpose_idx" ON "account_token"("account_id", "purpose");

-- CreateTable
-- An invitation to an address that has no verified account yet. Applied (once) when that address
-- is verified. The address sits here in the clear because the person it names has to be matched
-- and written to; the audit log only ever sees its hash.
CREATE TABLE "pending_invitation" (
    "id" TEXT NOT NULL PRIMARY KEY CHECK (length("id") = 22 AND "id" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "organisation_id" TEXT NOT NULL,
    "email" TEXT NOT NULL CHECK (length("email") BETWEEN 3 AND 254 AND "email" = lower("email") AND "email" GLOB '*@*'),
    "role" TEXT NOT NULL CHECK ("role" IN ('owner', 'admin', 'editor', 'viewer', 'billing')),
    "invited_by" TEXT NOT NULL CHECK (length("invited_by") = 22),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "expires_at" TEXT NOT NULL CHECK ("expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    CONSTRAINT "pending_invitation_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_invitation_organisation_id_email_key" ON "pending_invitation"("organisation_id", "email");

-- CreateIndex
CREATE INDEX "pending_invitation_email_idx" ON "pending_invitation"("email");
