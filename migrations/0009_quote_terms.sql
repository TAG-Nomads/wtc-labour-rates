-- Terms shown on a quote: minimum engagement per shift, and ordinary hours per day before overtime applies.
-- NULL = not specified (older quotes, or awards the shift calculator doesn't cover).
ALTER TABLE quotes ADD COLUMN min_engagement_hours REAL;
ALTER TABLE quotes ADD COLUMN daily_ot_hours REAL;
