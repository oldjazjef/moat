-- CreateTable
-- A Cloud project's moat.yaml (never a secret: the config schema allows none, SEC-20). `revision`
-- is the optimistic lock: a change names the revision it was made from.
CREATE TABLE "cloud_config" (
    "project_id" TEXT NOT NULL CHECK ("project_id" ~ '^[A-Za-z0-9_-]{22}$'),
    "text" TEXT NOT NULL CHECK (octet_length("text") <= 262144),
    "revision" INTEGER NOT NULL CHECK ("revision" >= 1),
    "updated_at" TEXT NOT NULL CHECK ("updated_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "cloud_config_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
-- A gate of a project. `managed` (trust mode 0): Moat Cloud signs its bundles with its installation
-- key. `signed` (modes 1 to 3): the customer's public key is pinned here and the Cloud only stores
-- and serves what that key signed (SEC-01, SEC-02) — it has no key to sign with.
CREATE TABLE "cloud_gate" (
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL CHECK ("name" ~ '^[a-z][a-z0-9-]{0,62}$'),
    "gate_id" TEXT NOT NULL CHECK ("gate_id" ~ '^[A-Za-z0-9_-]{22}$'),
    "box_key" TEXT NOT NULL CHECK ("box_key" ~ '^[A-Za-z0-9_-]{43}$'),
    "mode" TEXT NOT NULL CHECK ("mode" IN ('managed', 'signed')),
    "signer_kid" TEXT CHECK ("signer_kid" IS NULL OR "signer_kid" ~ '^[A-Za-z0-9_-]{22}$'),
    "signer_key" TEXT CHECK ("signer_key" IS NULL OR "signer_key" ~ '^[A-Za-z0-9_-]{43}$'),
    "pull_token_hash" TEXT CHECK ("pull_token_hash" IS NULL OR "pull_token_hash" ~ '^[0-9a-f]{64}$'),
    "created_at" TEXT NOT NULL CHECK ("created_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "cloud_gate_pkey" PRIMARY KEY ("project_id","name"),
    CONSTRAINT "cloud_gate_signer" CHECK (("mode" = 'signed') = ("signer_kid" IS NOT NULL AND "signer_key" IS NOT NULL))
);

-- CreateTable
-- Ciphertext only (SEC-31): the text must be a sealed secret of this version, nothing else.
CREATE TABLE "cloud_secret" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "name" TEXT NOT NULL CHECK ("name" ~ '^[a-z][a-z0-9-]{0,62}$'),
    "secret_version" INTEGER NOT NULL CHECK ("secret_version" >= 1),
    "text" TEXT NOT NULL CHECK (("text"::jsonb ->> 'alg') IS NOT DISTINCT FROM 'x25519-blake2b-xchacha20poly1305' AND ("text"::jsonb -> 'secretVersion') IS NOT DISTINCT FROM to_jsonb("secret_version") AND jsonb_typeof("text"::jsonb -> 'epk') IS NOT DISTINCT FROM 'string' AND jsonb_typeof("text"::jsonb -> 'nonce') IS NOT DISTINCT FROM 'string' AND jsonb_typeof("text"::jsonb -> 'ct') IS NOT DISTINCT FROM 'string' AND length("text") <= 65536),
    "updated_at" TEXT NOT NULL CHECK ("updated_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "cloud_secret_pkey" PRIMARY KEY ("project_id","gate","name")
);

-- CreateTable
-- A signed bundle exactly as signed (the gate verifies these bytes). Never replaced: a new version
-- is a new row (SEC-04).
CREATE TABLE "cloud_bundle" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "version" INTEGER NOT NULL CHECK ("version" BETWEEN 1 AND 999999999),
    "digest" TEXT NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
    "text" TEXT NOT NULL CHECK (("text"::jsonb ->> 'moat') IS NOT DISTINCT FROM 'bundle' AND jsonb_typeof("text"::jsonb -> 'payload') IS NOT DISTINCT FROM 'string' AND octet_length("text") <= 1048576),
    "created_at" TEXT NOT NULL CHECK ("created_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "cloud_bundle_pkey" PRIMARY KEY ("project_id","gate","version")
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_gate_pull_token_hash_key" ON "cloud_gate"("pull_token_hash");

-- AddForeignKey
ALTER TABLE "cloud_config" ADD CONSTRAINT "cloud_config_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "org_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_gate" ADD CONSTRAINT "cloud_gate_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "org_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_secret" ADD CONSTRAINT "cloud_secret_gate_fkey" FOREIGN KEY ("project_id","gate") REFERENCES "cloud_gate"("project_id","name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_bundle" ADD CONSTRAINT "cloud_bundle_gate_fkey" FOREIGN KEY ("project_id","gate") REFERENCES "cloud_gate"("project_id","name") ON DELETE CASCADE ON UPDATE CASCADE;

-- A signed bundle is never replaced (SEC-04): its key is the lock, a new version is a new row.
CREATE TRIGGER "cloud_bundle_no_update" BEFORE UPDATE ON "cloud_bundle"
    FOR EACH ROW EXECUTE FUNCTION "moat_refuse_change"();
