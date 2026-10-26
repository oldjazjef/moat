-- The audit log learns the actions `gate.remove` (a gate was deleted) and `invitation.revoke`. Only the CHECK changes; the
-- rows and their hashes are untouched, and a constraint change fires no row trigger.
ALTER TABLE "audit_entry" DROP CONSTRAINT "audit_entry_action_check";
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_action_check" CHECK ("action" IN ('org.create', 'member.add_requested', 'member.join', 'member.change', 'member.remove', 'invitation.revoke', 'project.create', 'project.delete', 'config.edit', 'gate.add', 'gate.remove', 'gate.pull_token', 'secret.set', 'bundle.sign', 'bundle.upload'));
