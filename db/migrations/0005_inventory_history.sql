ALTER TABLE myfin.stock_movements ADD COLUMN sale_id text;
UPDATE myfin.stock_movements SET sale_id=id;
ALTER TABLE myfin.stock_movements DROP CONSTRAINT stock_movements_company_id_id_fkey;
ALTER TABLE myfin.stock_movements ADD CONSTRAINT stock_movement_sale_fk
 FOREIGN KEY(company_id,sale_id) REFERENCES myfin.transactions(company_id,id);
-- sale_id is null for an authorized opening balance or stock adjustment.
CREATE INDEX stock_movements_sale_idx ON myfin.stock_movements(company_id,sale_id);
