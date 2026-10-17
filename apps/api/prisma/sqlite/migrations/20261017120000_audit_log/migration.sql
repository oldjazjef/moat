-- CreateTable
-- The audit log of an organisation (SEC-53): append-only and hash-chained per organisation. There
-- is deliberately no foreign key to organisation or account: a log must not be removable through
-- a cascade (and the triggers below refuse every UPDATE and DELETE anyway).
CREATE TABLE "audit_entry" (
    "organisation_id" TEXT NOT NULL CHECK (length("organisation_id") = 22 AND "organisation_id" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "seq" INTEGER NOT NULL CHECK ("seq" >= 1),
    "at" TEXT NOT NULL CHECK ("at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "actor" TEXT NOT NULL CHECK (length("actor") = 22 AND "actor" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "action" TEXT NOT NULL CHECK ("action" IN ('org.create', 'member.add_requested', 'member.change', 'member.remove', 'project.create', 'project.delete', 'config.edit', 'gate.add', 'gate.pull_token', 'secret.set', 'bundle.sign', 'bundle.upload')),
    "target" TEXT CHECK ("target" IS NULL OR (length("target") = 22 AND "target" NOT GLOB '*[^A-Za-z0-9_-]*')),
    "details" TEXT NOT NULL CHECK (json_valid("details") AND json_type("details") IS 'object' AND length("details") <= 1024),
    "prev_hash" TEXT NOT NULL CHECK (length("prev_hash") = 64 AND "prev_hash" NOT GLOB '*[^0-9a-f]*'),
    "hash" TEXT NOT NULL CHECK (length("hash") = 64 AND "hash" NOT GLOB '*[^0-9a-f]*'),

    PRIMARY KEY ("organisation_id", "seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_entry_hash_key" ON "audit_entry"("hash");

CREATE TRIGGER "audit_entry_no_update" BEFORE UPDATE ON "audit_entry"
BEGIN
    SELECT RAISE(ABORT, 'audit_entry is append-only');
END;

CREATE TRIGGER "audit_entry_no_delete" BEFORE DELETE ON "audit_entry"
BEGIN
    SELECT RAISE(ABORT, 'audit_entry is append-only');
END;
