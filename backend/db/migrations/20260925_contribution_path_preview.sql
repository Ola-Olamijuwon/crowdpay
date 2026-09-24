-- Path-payment preview, actionable on-chain diagnostics and over-max
-- slippage retry (#688).
--
-- The new columns let a contribution record exactly which DEX route was
-- quoted (path_hops), what the quoted effective rate and slippage buffer
-- were (effective_rate, slippage_bps), how much the sender authorised as a
-- maximum send (send_max), whether the payment needed a re-quote before it
-- landed (retry_count) and the current on-chain status (diagnosis).
ALTER TABLE contributions
  ADD COLUMN path_hops      JSONB,
  ADD COLUMN effective_rate NUMERIC(30, 15),
  ADD COLUMN slippage_bps   INTEGER,
  ADD COLUMN send_max       NUMERIC(20, 7),
  ADD COLUMN retry_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN diagnosis      TEXT;