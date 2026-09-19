-- Every account gets its primary address, including accounts made after 0009.
--
-- 0009 backfilled the accounts that existed when it ran, which is necessary and
-- not sufficient: nothing guaranteed the same for the NEXT account. Sign-in
-- resolves through user_emails, so an account created without a row there
-- cannot sign in at all — and it fails silently, looking like a wrong code
-- rather than a missing row. This was caught by test/identity-model.test.ts
-- with twelve such accounts already present, all made by ordinary paths:
-- invitation sign-ups and the service accounts behind API keys.
--
-- Fixing the callers would work until somebody adds a thirteenth path. The
-- guarantee belongs where it cannot be forgotten.

--> statement-breakpoint

-- Catch up anything created between 0009 and this migration.
INSERT INTO user_emails (user_id, email, is_primary, verified_at, created_at)
SELECT u.id, lower(u.email), true, u.email_verified_at, u.created_at
  FROM users u
 WHERE u.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.is_primary)
ON CONFLICT (email) DO NOTHING;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_primary_email() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_emails (user_id, email, is_primary, verified_at, created_at)
  VALUES (NEW.id, lower(NEW.email), true, NEW.email_verified_at, NEW.created_at);
  RETURN NEW;
END;
$$;

--> statement-breakpoint

-- INSERT only, deliberately.
--
-- Changing the primary address goes through setPrimaryEmail(), which writes
-- both tables inside one transaction. A trigger on UPDATE would fight it — the
-- partial unique index permits exactly one primary per account, so a second
-- writer racing the first produces a constraint violation on an ordinary edit.
--
-- There is no ON CONFLICT here on purpose. A collision means the address is
-- already claimed — most plausibly as somebody else's unverified secondary,
-- which users.email's own unique constraint would not have caught. Failing the
-- INSERT rejects the sign-up loudly; swallowing it would create an account that
-- exists and can never sign in, which is the worse of the two by a distance.
CREATE TRIGGER users_primary_email_ins
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION users_primary_email();
