-- Proposed shifts, their per-shift hour split, warnings and any manual overrides
-- for quotes built with the shift calculator (NULL for by-category quotes).
ALTER TABLE quotes ADD COLUMN shifts_json TEXT;
