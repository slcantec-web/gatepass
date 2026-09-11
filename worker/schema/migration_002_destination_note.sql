/* Run this only if you already applied schema.sql before destination_note
   existed. Fresh installs get this column directly from schema.sql and
   should NOT run this file.

   Backs the "Other destination" free-text field on Create Pass, for trips to
   a real place that simply isn't registered in Location Master (a one-off
   customer/vendor site, somewhere you won't visit again, etc). It's a plain
   text note, not a foreign key to locations - if it turns out to be a
   recurring destination, an Admin can add it properly to Location Master
   later and it'll show up in the route picker from then on. */
ALTER TABLE gate_passes ADD COLUMN destination_note TEXT;
