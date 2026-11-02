-- One channel per name per facility (and per name nationally); makes default creation idempotent.
CREATE UNIQUE INDEX "channels_name_uq" ON "channels" (coalesce("facility_id", '00000000-0000-0000-0000-000000000000'::uuid), "name");
