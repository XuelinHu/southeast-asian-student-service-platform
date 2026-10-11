ALTER TABLE users ADD COLUMN oidc_subject TEXT;
CREATE UNIQUE INDEX uq_users_oidc_subject
  ON users (oidc_subject)
  WHERE oidc_subject IS NOT NULL;
