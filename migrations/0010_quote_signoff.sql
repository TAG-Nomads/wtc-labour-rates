-- Client sign-off: a quote gets an unguessable link; the client opens it, reads the client-safe quote and accepts once.
-- accepted_hash is a SHA-256 of the quote's priced content at the moment of acceptance (evidence of what was agreed).
ALTER TABLE quotes ADD COLUMN share_token TEXT;
ALTER TABLE quotes ADD COLUMN shared_at TEXT;
ALTER TABLE quotes ADD COLUMN accepted_at TEXT;
ALTER TABLE quotes ADD COLUMN accepted_name TEXT;
ALTER TABLE quotes ADD COLUMN accepted_ip TEXT;
ALTER TABLE quotes ADD COLUMN accepted_ua TEXT;
ALTER TABLE quotes ADD COLUMN accepted_hash TEXT;
CREATE UNIQUE INDEX idx_quotes_share_token ON quotes(share_token) WHERE share_token IS NOT NULL;
