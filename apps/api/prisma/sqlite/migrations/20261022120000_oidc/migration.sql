-- Moat Cloud accounts: single sign-on with OpenID Connect (SEC-51, T-104 to T-106). Keep the
-- CHECKs equal in meaning to ../../../postgresql/migrations.

-- CreateTable
-- An identity at an identity provider, linked to an account: the provider's id (from the operator's
-- configuration) and the `sub` claim, which is the only stable name for a person there. The
-- address is never the link: it can change or be reassigned at the provider.
CREATE TABLE "account_identity" (
    "id" TEXT NOT NULL PRIMARY KEY CHECK (length("id") = 22 AND "id" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "account_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL CHECK (length("provider") BETWEEN 1 AND 31 AND "provider" NOT GLOB '*[^a-z0-9-]*'),
    "subject" TEXT NOT NULL CHECK (length("subject") BETWEEN 1 AND 255),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "last_login_at" TEXT CHECK ("last_login_at" IS NULL OR "last_login_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    CONSTRAINT "account_identity_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "account_identity_provider_subject_key" ON "account_identity"("provider", "subject");

-- CreateIndex
CREATE INDEX "account_identity_account_id_idx" ON "account_identity"("account_id");

-- CreateTable
-- One sign-in or link in progress: `id` is the SHA-256 of the `state` sent to the provider, the
-- nonce and the PKCE verifier are what the callback must match, and `browser_hash` is the SHA-256
-- of the secret cookie of the browser that started it (a callback from another browser fails).
-- Used up by a delete; lives 10 minutes.
CREATE TABLE "oidc_login" (
    "id" TEXT NOT NULL PRIMARY KEY CHECK (length("id") = 64 AND "id" NOT GLOB '*[^0-9a-f]*'),
    "provider" TEXT NOT NULL CHECK (length("provider") BETWEEN 1 AND 31 AND "provider" NOT GLOB '*[^a-z0-9-]*'),
    "purpose" TEXT NOT NULL CHECK ("purpose" IN ('login', 'link')),
    "account_id" TEXT,
    "nonce" TEXT NOT NULL CHECK (length("nonce") BETWEEN 16 AND 128),
    "verifier" TEXT NOT NULL CHECK (length("verifier") BETWEEN 43 AND 128),
    "browser_hash" TEXT NOT NULL CHECK (length("browser_hash") = 64 AND "browser_hash" NOT GLOB '*[^0-9a-f]*'),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "expires_at" TEXT NOT NULL CHECK ("expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    CONSTRAINT "oidc_login_purpose_account" CHECK (("purpose" = 'link') = ("account_id" IS NOT NULL)),
    CONSTRAINT "oidc_login_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "oidc_login_expires_at_idx" ON "oidc_login"("expires_at");
