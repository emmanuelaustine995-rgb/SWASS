-- Record the person presenting an item when its identifier is checked against the lost register.
ALTER TABLE lost_item_searches ADD COLUMN IF NOT EXISTS presented_by_name TEXT;
ALTER TABLE lost_item_searches ADD COLUMN IF NOT EXISTS presented_by_phone TEXT;
