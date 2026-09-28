ALTER TABLE myfin.transactions ADD COLUMN quote_id text;
ALTER TABLE myfin.transactions ADD COLUMN converted_to text;
UPDATE myfin.transactions SET quote_id=nullif(data->>'quoteId',''), converted_to=nullif(data->>'convertedTo','') WHERE source='manual';
ALTER TABLE myfin.transactions ADD CONSTRAINT transaction_quote_fk
 FOREIGN KEY(company_id,quote_id) REFERENCES myfin.transactions(company_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE myfin.transactions ADD CONSTRAINT transaction_conversion_fk
 FOREIGN KEY(company_id,converted_to) REFERENCES myfin.transactions(company_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX transaction_quote_idx ON myfin.transactions(company_id,quote_id);
