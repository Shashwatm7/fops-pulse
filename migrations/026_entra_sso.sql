-- Microsoft Entra ID (multi-tenant) SSO.
--
-- Identity key is (entra_tid, entra_oid), NOT email. `oid` is unique per user
-- per tenant and is immutable; email is mutable and can be reassigned to a new
-- person, so matching on it lets a renamed mailbox inherit someone's account.
-- `tid` is part of the key because oid is only unique WITHIN a tenant.
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_oid TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_tid TEXT;

-- SSO users never have a password. Existing local accounts keep theirs.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_identity
  ON users (entra_tid, entra_oid)
  WHERE entra_oid IS NOT NULL;
