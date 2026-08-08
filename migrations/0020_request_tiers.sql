-- Request tiering: a cheap-model classification of each feature request
-- (trivial = small localized change; standard = everything else) that scales
-- plan depth, acceptance-criteria count, and the generation agent's budget
-- to the size of the ask. Null = pre-tiering rows, treated as standard.
ALTER TABLE plans ADD COLUMN tier TEXT;
ALTER TABLE features ADD COLUMN tier TEXT;
