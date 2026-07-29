-- Login looks employees up by lower(trim(email)), but the original unique
-- constraint on employees.email is case-sensitive and doesn't account for
-- whitespace. That let create-admin insert two rows for the same real email
-- (differing only in casing), and login's lookup silently picked whichever
-- one Postgres returned first — not necessarily the one matching the PIN
-- just set. Normalize existing data and enforce the same rule login already
-- assumes, so a case/whitespace variant can never collide again.

update employees set email = lower(trim(email)) where email is not null;

create unique index employees_email_normalized_key
  on employees (lower(trim(email)));
