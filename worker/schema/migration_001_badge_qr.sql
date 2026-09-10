/* Run this only if you already applied schema.sql before badge QR tokens
   existed. Fresh installs get this column directly from schema.sql and
   should NOT run this file. */
ALTER TABLE employees ADD COLUMN badge_qr_token TEXT UNIQUE;
