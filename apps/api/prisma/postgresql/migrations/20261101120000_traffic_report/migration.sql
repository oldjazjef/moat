-- FR-50, FR-51, T-110: what gates report about their traffic. A gate's report address holds a
-- 256-bit token; only its SHA-256 is kept. The traffic is sums per gate, route and UTC hour, never
-- a single request, a client, a path or an address; `route` '' stands for requests that matched no
-- route. Both tables go with their gate (foreign keys cascade).
CREATE TABLE "cloud_report_address" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    "created_at" TEXT NOT NULL CHECK ("created_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "cloud_report_address_pkey" PRIMARY KEY ("project_id","gate")
);

CREATE TABLE "cloud_traffic" (
    "project_id" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "hour" BIGINT NOT NULL CHECK ("hour" >= 0 AND "hour" % 3600 = 0),
    "route" TEXT NOT NULL CHECK ("route" = '' OR "route" ~ '^[a-z][a-z0-9-]{0,62}$'),
    "requests" INTEGER NOT NULL CHECK ("requests" >= 1),
    "s2" INTEGER NOT NULL CHECK ("s2" >= 0),
    "s3" INTEGER NOT NULL CHECK ("s3" >= 0),
    "s4" INTEGER NOT NULL CHECK ("s4" >= 0),
    "s5" INTEGER NOT NULL CHECK ("s5" >= 0),
    "errors" TEXT NOT NULL CHECK (jsonb_typeof("errors"::jsonb) IS NOT DISTINCT FROM 'object' AND length("errors") <= 2048),
    "ms_total" BIGINT NOT NULL CHECK ("ms_total" >= 0),
    "ms_max" INTEGER NOT NULL CHECK ("ms_max" >= 0 AND "ms_max" <= "ms_total"),
    "received_at" TEXT NOT NULL CHECK ("received_at" ~ '^[0-9]{4}-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9]\.[0-9]{3}Z$'),

    CONSTRAINT "cloud_traffic_pkey" PRIMARY KEY ("project_id","gate","hour","route"),
    CONSTRAINT "cloud_traffic_classes" CHECK ("s2" + "s3" + "s4" + "s5" = "requests")
);

CREATE UNIQUE INDEX "cloud_report_address_token_hash_key" ON "cloud_report_address"("token_hash");

CREATE INDEX "cloud_traffic_project_id_hour_idx" ON "cloud_traffic"("project_id", "hour");

ALTER TABLE "cloud_report_address" ADD CONSTRAINT "cloud_report_address_project_id_gate_fkey" FOREIGN KEY ("project_id", "gate") REFERENCES "cloud_gate"("project_id", "name") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cloud_traffic" ADD CONSTRAINT "cloud_traffic_project_id_gate_fkey" FOREIGN KEY ("project_id", "gate") REFERENCES "cloud_gate"("project_id", "name") ON DELETE CASCADE ON UPDATE CASCADE;

-- The audit log learns `gate.report_token`. Only the CHECK changes; the rows and their hashes are
-- untouched, and a constraint change fires no row trigger.
ALTER TABLE "audit_entry" DROP CONSTRAINT "audit_entry_action_check";
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_action_check" CHECK ("action" IN ('org.create', 'member.add_requested', 'member.join', 'member.change', 'member.remove', 'invitation.revoke', 'project.create', 'project.delete', 'config.edit', 'gate.add', 'gate.remove', 'gate.pull_token', 'gate.report_token', 'secret.set', 'bundle.sign', 'bundle.upload'));
