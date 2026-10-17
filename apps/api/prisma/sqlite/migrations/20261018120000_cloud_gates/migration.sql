-- CreateTable
-- A Cloud project's moat.yaml (never a secret: the config schema allows none, SEC-20). `revision`
-- is the optimistic lock: a change names the revision it was made from.
CREATE TABLE "cloud_config" (
    "project_id" TEXT NOT NULL PRIMARY KEY CHECK (length("project_id") = 22 AND "project_id" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "text" TEXT NOT NULL CHECK (length(CAST("text" AS BLOB)) <= 262144),
    "revision" INTEGER NOT NULL CHECK ("revision" >= 1),
    "updated_at" TEXT NOT NULL CHECK ("updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    CONSTRAINT "cloud_config_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "org_project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
-- A gate of a project. `managed` (trust mode 0): Moat Cloud signs its bundles with its installation
-- key. `signed` (modes 1 to 3): the customer's public key is pinned here and the Cloud only stores
-- and serves what that key signed (SEC-01, SEC-02) — it has no key to sign with.
CREATE TABLE "cloud_gate" (
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL CHECK (length("name") BETWEEN 1 AND 63 AND substr("name", 1, 1) BETWEEN 'a' AND 'z' AND "name" NOT GLOB '*[^a-z0-9-]*'),
    "gate_id" TEXT NOT NULL CHECK (length("gate_id") = 22 AND "gate_id" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "box_key" TEXT NOT NULL CHECK (length("box_key") = 43 AND "box_key" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "mode" TEXT NOT NULL CHECK ("mode" IN ('managed', 'signed')),
    "signer_kid" TEXT CHECK ("signer_kid" IS NULL OR (length("signer_kid") = 22 AND "signer_kid" NOT GLOB '*[^A-Za-z0-9_-]*')),
    "signer_key" TEXT CHECK ("signer_key" IS NULL OR (length("signer_key") = 43 AND "signer_key" NOT GLOB '*[^A-Za-z0-9_-]*')),
    "pull_token_hash" TEXT CHECK ("pull_token_hash" IS NULL OR (length("pull_token_hash") = 64 AND "pull_token_hash" NOT GLOB '*[^0-9a-f]*')),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),

    PRIMARY KEY ("project_id", "name"),
    CONSTRAINT "cloud_gate_signer" CHECK (("mode" = 'signed') = ("signer_kid" IS NOT NULL AND "signer_key" IS NOT NULL)),
    CONSTRAINT "cloud_gate_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "org_project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
-- Ciphertext only (SEC-31): the text must be a sealed secret of this version, nothing else.
CREATE TABLE "cloud_secret" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "name" TEXT NOT NULL CHECK (length("name") BETWEEN 1 AND 63 AND substr("name", 1, 1) BETWEEN 'a' AND 'z' AND "name" NOT GLOB '*[^a-z0-9-]*'),
    "secret_version" INTEGER NOT NULL CHECK ("secret_version" >= 1),
    "text" TEXT NOT NULL CHECK (json_valid("text") AND json_extract("text", '$.alg') IS 'x25519-blake2b-xchacha20poly1305' AND json_extract("text", '$.secretVersion') IS "secret_version" AND json_type("text", '$.epk') IS 'text' AND json_type("text", '$.nonce') IS 'text' AND json_type("text", '$.ct') IS 'text' AND length("text") <= 65536),
    "updated_at" TEXT NOT NULL CHECK ("updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),

    PRIMARY KEY ("project_id", "gate", "name"),
    CONSTRAINT "cloud_secret_gate_fkey" FOREIGN KEY ("project_id", "gate") REFERENCES "cloud_gate" ("project_id", "name") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
-- A signed bundle exactly as signed (the gate verifies these bytes). Never replaced: a new version
-- is a new row (SEC-04).
CREATE TABLE "cloud_bundle" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "version" INTEGER NOT NULL CHECK ("version" BETWEEN 1 AND 999999999),
    "digest" TEXT NOT NULL CHECK (length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
    "text" TEXT NOT NULL CHECK (json_valid("text") AND json_extract("text", '$.moat') IS 'bundle' AND json_type("text", '$.payload') IS 'text' AND length(CAST("text" AS BLOB)) <= 1048576),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),

    PRIMARY KEY ("project_id", "gate", "version"),
    CONSTRAINT "cloud_bundle_gate_fkey" FOREIGN KEY ("project_id", "gate") REFERENCES "cloud_gate" ("project_id", "name") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_gate_pull_token_hash_key" ON "cloud_gate"("pull_token_hash");

-- A signed bundle is never replaced (SEC-04): its key is the lock, a new version is a new row.
CREATE TRIGGER "cloud_bundle_no_update" BEFORE UPDATE ON "cloud_bundle"
BEGIN
    SELECT RAISE(ABORT, 'cloud_bundle rows are never replaced');
END;
