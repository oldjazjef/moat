-- CreateTable
-- The audit log of an organisation (SEC-53): append-only and hash-chained per organisation. There
-- is deliberately no foreign key to organisation or account: a log must not be removable through
-- a cascade (and the triggers below refuse every UPDATE and DELETE anyway).
CREATE TABLE "audit_entry" (
    "organisation_id" TEXT NOT NULL CHECK ("organisation_id" ~ '^[A-Za-z0-9_-]{22}$'),
    "seq" INTEGER NOT NULL CHECK ("seq" >= 1),
    "at" TEXT NOT NULL CHECK ("at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),
    "actor" TEXT NOT NULL CHECK ("actor" ~ '^[A-Za-z0-9_-]{22}$'),
    "action" TEXT NOT NULL CHECK ("action" IN ('org.create', 'member.add_requested', 'member.change', 'member.remove', 'project.create', 'project.delete', 'config.edit', 'gate.add', 'gate.pull_token', 'secret.set', 'bundle.sign', 'bundle.upload')),
    "target" TEXT CHECK ("target" IS NULL OR "target" ~ '^[A-Za-z0-9_-]{22}$'),
    "details" TEXT NOT NULL CHECK (jsonb_typeof("details"::jsonb) IS NOT DISTINCT FROM 'object' AND length("details") <= 1024),
    "prev_hash" TEXT NOT NULL CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
    "hash" TEXT NOT NULL CHECK ("hash" ~ '^[0-9a-f]{64}$'),

    CONSTRAINT "audit_entry_pkey" PRIMARY KEY ("organisation_id","seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_entry_hash_key" ON "audit_entry"("hash");

CREATE TRIGGER "audit_entry_append_only" BEFORE UPDATE OR DELETE ON "audit_entry"
    FOR EACH ROW EXECUTE FUNCTION "moat_refuse_change"();

-- TRUNCATE skips row triggers: refuse it too.
CREATE TRIGGER "audit_entry_no_truncate" BEFORE TRUNCATE ON "audit_entry"
    FOR EACH STATEMENT EXECUTE FUNCTION "moat_refuse_change"();
