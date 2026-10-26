-- Moat Cloud accounts: passkeys (WebAuthn) as a second factor next to TOTP (SEC-51, T-101 to
-- T-103). Keep the CHECKs equal in meaning to ../../../sqlite/migrations.

-- CreateTable
-- A passkey of an account: its credential id, the public key (the 65-byte P-256 point, base64url)
-- and the authenticator's counter. Nothing secret is stored: the private key never leaves the
-- authenticator.
CREATE TABLE "account_passkey" (
    "id" TEXT NOT NULL CHECK ("id" ~ '^[A-Za-z0-9_-]{22}$'),
    "account_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL CHECK (char_length("credential_id") BETWEEN 22 AND 1400 AND "credential_id" ~ '^[A-Za-z0-9_-]+$'),
    "public_key" TEXT NOT NULL CHECK ("public_key" ~ '^[A-Za-z0-9_-]{87}$'),
    "sign_count" INTEGER NOT NULL DEFAULT 0 CHECK ("sign_count" >= 0),
    "name" TEXT NOT NULL CHECK (char_length("name") BETWEEN 1 AND 60),
    "created_at" TEXT NOT NULL CHECK ("created_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),
    "last_used_at" TEXT CHECK ("last_used_at" IS NULL OR "last_used_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "account_passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- A challenge the server made for one registration or sign-in. Only the SHA-256 is stored; it is
-- used up by a compare-and-set (a delete), so an assertion cannot be replayed.
CREATE TABLE "webauthn_challenge" (
    "id" TEXT NOT NULL CHECK ("id" ~ '^[0-9a-f]{64}$'),
    "account_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL CHECK ("purpose" IN ('register', 'login')),
    "created_at" TEXT NOT NULL CHECK ("created_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),
    "expires_at" TEXT NOT NULL CHECK ("expires_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "webauthn_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_passkey_credential_id_key" ON "account_passkey"("credential_id");

-- CreateIndex
CREATE INDEX "account_passkey_account_id_idx" ON "account_passkey"("account_id");

-- CreateIndex
CREATE INDEX "webauthn_challenge_account_id_idx" ON "webauthn_challenge"("account_id");

-- AddForeignKey
ALTER TABLE "account_passkey" ADD CONSTRAINT "account_passkey_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_challenge" ADD CONSTRAINT "webauthn_challenge_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
