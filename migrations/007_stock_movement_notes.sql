-- Keep the reason supplied by a manager/owner for manual stock adjustments.
ALTER TABLE stock_movements ADD COLUMN note TEXT;
