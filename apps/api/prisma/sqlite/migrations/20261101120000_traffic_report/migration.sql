-- FR-50, FR-51, T-110: what gates report about their traffic. A gate's report address holds a
-- 256-bit token; only its SHA-256 is kept. The traffic is sums per gate, route and UTC hour, never
-- a single request, a client, a path or an address; `route` '' stands for requests that matched no
-- route. Both tables go with their gate (foreign keys cascade).
CREATE TABLE "cloud_report_address" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL CHECK (length("token_hash") = 64 AND "token_hash" NOT GLOB '*[^0-9a-f]*'),
    "created_at" TEXT NOT NULL CHECK ("created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),

    PRIMARY KEY ("project_id", "gate"),
    CONSTRAINT "cloud_report_address_project_id_gate_fkey" FOREIGN KEY ("project_id", "gate") REFERENCES "cloud_gate" ("project_id", "name") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "cloud_traffic" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "hour" BIGINT NOT NULL CHECK ("hour" >= 0 AND "hour" % 3600 = 0),
    "route" TEXT NOT NULL CHECK ("route" = '' OR (length("route") BETWEEN 1 AND 63 AND substr("route", 1, 1) BETWEEN 'a' AND 'z' AND "route" NOT GLOB '*[^a-z0-9-]*')),
    "requests" INTEGER NOT NULL CHECK ("requests" >= 1),
    "s2" INTEGER NOT NULL CHECK ("s2" >= 0),
    "s3" INTEGER NOT NULL CHECK ("s3" >= 0),
    "s4" INTEGER NOT NULL CHECK ("s4" >= 0),
    "s5" INTEGER NOT NULL CHECK ("s5" >= 0),
    "errors" TEXT NOT NULL CHECK (json_valid("errors") AND json_type("errors") IS 'object' AND length("errors") <= 2048),
    "ms_total" BIGINT NOT NULL CHECK ("ms_total" >= 0),
    "ms_max" INTEGER NOT NULL CHECK ("ms_max" >= 0 AND "ms_max" <= "ms_total"),
    "received_at" TEXT NOT NULL CHECK ("received_at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),

    PRIMARY KEY ("project_id", "gate", "hour", "route"),
    CONSTRAINT "cloud_traffic_classes" CHECK ("s2" + "s3" + "s4" + "s5" = "requests"),
    CONSTRAINT "cloud_traffic_project_id_gate_fkey" FOREIGN KEY ("project_id", "gate") REFERENCES "cloud_gate" ("project_id", "name") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "cloud_report_address_token_hash_key" ON "cloud_report_address"("token_hash");

CREATE INDEX "cloud_traffic_project_id_hour_idx" ON "cloud_traffic"("project_id", "hour");

-- The audit log learns `gate.report_token`. SQLite cannot change a CHECK in place, so the table is
-- redefined: the rows are copied unchanged (they keep their hashes, the chain is not touched),
-- then the index and the append-only triggers are created again.
CREATE TABLE "new_audit_entry" (
    "organisation_id" TEXT NOT NULL CHECK (length("organisation_id") = 22 AND "organisation_id" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "seq" INTEGER NOT NULL CHECK ("seq" >= 1),
    "at" TEXT NOT NULL CHECK ("at" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
    "actor" TEXT NOT NULL CHECK (length("actor") = 22 AND "actor" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "action" TEXT NOT NULL CHECK ("action" IN ('org.create', 'member.add_requested', 'member.join', 'member.change', 'member.remove', 'invitation.revoke', 'project.create', 'project.delete', 'config.edit', 'gate.add', 'gate.remove', 'gate.pull_token', 'gate.report_token', 'secret.set', 'bundle.sign', 'bundle.upload')),
    "target" TEXT CHECK ("target" IS NULL OR (length("target") = 22 AND "target" NOT GLOB '*[^A-Za-z0-9_-]*')),
    "details" TEXT NOT NULL CHECK (json_valid("details") AND json_type("details") IS 'object' AND length("details") <= 1024),
    "prev_hash" TEXT NOT NULL CHECK (length("prev_hash") = 64 AND "prev_hash" NOT GLOB '*[^0-9a-f]*'),
    "hash" TEXT NOT NULL CHECK (length("hash") = 64 AND "hash" NOT GLOB '*[^0-9a-f]*'),

    PRIMARY KEY ("organisation_id", "seq")
);

INSERT INTO "new_audit_entry" ("organisation_id", "seq", "at", "actor", "action", "target", "details", "prev_hash", "hash")
SELECT "organisation_id", "seq", "at", "actor", "action", "target", "details", "prev_hash", "hash" FROM "audit_entry";

DROP TABLE "audit_entry";
ALTER TABLE "new_audit_entry" RENAME TO "audit_entry";

CREATE UNIQUE INDEX "audit_entry_hash_key" ON "audit_entry"("hash");

CREATE TRIGGER "audit_entry_no_update" BEFORE UPDATE ON "audit_entry"
BEGIN
    SELECT RAISE(ABORT, 'audit_entry is append-only');
END;

CREATE TRIGGER "audit_entry_no_delete" BEFORE DELETE ON "audit_entry"
BEGIN
    SELECT RAISE(ABORT, 'audit_entry is append-only');
END;
