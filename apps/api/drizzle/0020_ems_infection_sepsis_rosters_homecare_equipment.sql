ALTER TYPE "public"."care_unit_type" ADD VALUE 'AMBULANCE_SERVICE';--> statement-breakpoint
ALTER TYPE "public"."care_unit_type" ADD VALUE 'COMMUNITY_NURSING';--> statement-breakpoint
ALTER TYPE "public"."care_unit_type" ADD VALUE 'INFECTION_CONTROL';--> statement-breakpoint
CREATE TABLE "ambulance_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_unit_id" uuid NOT NULL,
	"call_sign" varchar(20) NOT NULL,
	"level" varchar(4) NOT NULL,
	"status" varchar(14) DEFAULT 'AVAILABLE' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "antimicrobial_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"indication" varchar(300) NOT NULL,
	"justification" text NOT NULL,
	"status" varchar(10) DEFAULT 'REQUESTED' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" varchar(500),
	"review_due_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"review_outcome" varchar(12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ems_care_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"patient_id" uuid,
	"kind" varchar(12) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"text" varchar(500),
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ems_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(30) NOT NULL,
	"service_unit_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"caller_name" varchar(200),
	"caller_phone" varchar(40),
	"address" varchar(300) NOT NULL,
	"municipality" varchar(100),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"complaint" varchar(300) NOT NULL,
	"priority" varchar(2) NOT NULL,
	"status" varchar(12) DEFAULT 'RECEIVED' NOT NULL,
	"patient_id" uuid,
	"patient_description" varchar(300),
	"ambulance_unit_id" uuid,
	"dispatched_at" timestamp with time zone,
	"on_scene_at" timestamp with time zone,
	"left_scene_at" timestamp with time zone,
	"at_hospital_at" timestamp with time zone,
	"handed_over_at" timestamp with time zone,
	"destination_facility_id" uuid,
	"ed_visit_id" uuid,
	"outcome" varchar(20),
	"closed_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" varchar(8) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" varchar(500) NOT NULL,
	"status" varchar(14),
	"incident_id" uuid,
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_id" uuid,
	"asset_tag" varchar(40) NOT NULL,
	"category" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"manufacturer" varchar(120),
	"model" varchar(120),
	"serial_number" varchar(120),
	"criticality" varchar(6) NOT NULL,
	"status" varchar(14) DEFAULT 'IN_SERVICE' NOT NULL,
	"service_interval_days" smallint,
	"last_service_at" date,
	"next_service_due" date,
	"commissioned_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hai_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"admission_id" uuid,
	"unit_id" uuid,
	"type" varchar(20) NOT NULL,
	"organism" varchar(120),
	"onset_at" timestamp with time zone NOT NULL,
	"device_related" boolean DEFAULT false NOT NULL,
	"status" varchar(10) DEFAULT 'SUSPECTED' NOT NULL,
	"notes" text,
	"reported_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_care_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"team_unit_id" uuid NOT NULL,
	"referred_by_id" uuid NOT NULL,
	"reason" varchar(300) NOT NULL,
	"care_plan" text,
	"visit_address" varchar(300),
	"access_notes" varchar(300),
	"status" varchar(10) DEFAULT 'REFERRED' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"assigned_to_id" uuid,
	"status" varchar(10) DEFAULT 'PLANNED' NOT NULL,
	"tasks" text[] DEFAULT '{}'::text[] NOT NULL,
	"visited_at" timestamp with time zone,
	"notes" text,
	"missed_reason" varchar(300),
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "isolation_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"precaution" varchar(10) NOT NULL,
	"reason" varchar(200) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ordered_by_id" uuid NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_id" uuid,
	"end_reason" varchar(300)
);
--> statement-breakpoint
CREATE TABLE "roster_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" varchar(8) NOT NULL,
	"specialty" varchar(40),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" varchar(10) DEFAULT 'PLANNED' NOT NULL,
	"note" varchar(300),
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sepsis_screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"admission_id" uuid,
	"ed_visit_id" uuid,
	"early_warning_score_id" uuid,
	"trigger" varchar(10) NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"suspected_source" varchar(100),
	"red_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"screened_at" timestamp with time zone,
	"screened_by_id" uuid,
	"bundle" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bundle_started_at" timestamp with time zone,
	"bundle_completed_at" timestamp with time zone,
	"senior_review_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ambulance_units" ADD CONSTRAINT "ambulance_units_station_unit_id_care_units_id_fk" FOREIGN KEY ("station_unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antimicrobial_approvals" ADD CONSTRAINT "antimicrobial_approvals_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antimicrobial_approvals" ADD CONSTRAINT "antimicrobial_approvals_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antimicrobial_approvals" ADD CONSTRAINT "antimicrobial_approvals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antimicrobial_approvals" ADD CONSTRAINT "antimicrobial_approvals_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antimicrobial_approvals" ADD CONSTRAINT "antimicrobial_approvals_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_care_records" ADD CONSTRAINT "ems_care_records_incident_id_ems_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."ems_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_care_records" ADD CONSTRAINT "ems_care_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_care_records" ADD CONSTRAINT "ems_care_records_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_service_unit_id_care_units_id_fk" FOREIGN KEY ("service_unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_ambulance_unit_id_ambulance_units_id_fk" FOREIGN KEY ("ambulance_unit_id") REFERENCES "public"."ambulance_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_destination_facility_id_facilities_id_fk" FOREIGN KEY ("destination_facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_ed_visit_id_ed_visits_id_fk" FOREIGN KEY ("ed_visit_id") REFERENCES "public"."ed_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_events" ADD CONSTRAINT "equipment_events_item_id_equipment_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."equipment_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_events" ADD CONSTRAINT "equipment_events_incident_id_safety_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."safety_incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_events" ADD CONSTRAINT "equipment_events_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_care_episodes" ADD CONSTRAINT "home_care_episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_care_episodes" ADD CONSTRAINT "home_care_episodes_team_unit_id_care_units_id_fk" FOREIGN KEY ("team_unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_care_episodes" ADD CONSTRAINT "home_care_episodes_referred_by_id_users_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_episode_id_home_care_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."home_care_episodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_ordered_by_id_users_id_fk" FOREIGN KEY ("ordered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_ended_by_id_users_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_ed_visit_id_ed_visits_id_fk" FOREIGN KEY ("ed_visit_id") REFERENCES "public"."ed_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_early_warning_score_id_early_warning_scores_id_fk" FOREIGN KEY ("early_warning_score_id") REFERENCES "public"."early_warning_scores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_screened_by_id_users_id_fk" FOREIGN KEY ("screened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ambulance_units_call_sign_uq" ON "ambulance_units" USING btree ("call_sign");--> statement-breakpoint
CREATE UNIQUE INDEX "antimicrobial_approvals_prescription_uq" ON "antimicrobial_approvals" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "antimicrobial_approvals_facility_idx" ON "antimicrobial_approvals" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "ems_care_records_incident_idx" ON "ems_care_records" USING btree ("incident_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ems_incidents_reference_uq" ON "ems_incidents" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "ems_incidents_service_idx" ON "ems_incidents" USING btree ("service_unit_id","status","received_at");--> statement-breakpoint
CREATE INDEX "ems_incidents_patient_idx" ON "ems_incidents" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "equipment_events_item_idx" ON "equipment_events" USING btree ("item_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_items_tag_uq" ON "equipment_items" USING btree ("facility_id","asset_tag");--> statement-breakpoint
CREATE INDEX "equipment_items_status_idx" ON "equipment_items" USING btree ("facility_id","status","next_service_due");--> statement-breakpoint
CREATE INDEX "hai_events_facility_idx" ON "hai_events" USING btree ("facility_id","onset_at");--> statement-breakpoint
CREATE INDEX "home_care_episodes_team_idx" ON "home_care_episodes" USING btree ("team_unit_id","status");--> statement-breakpoint
CREATE INDEX "home_care_episodes_patient_idx" ON "home_care_episodes" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "home_visits_episode_idx" ON "home_visits" USING btree ("episode_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "home_visits_assignee_idx" ON "home_visits" USING btree ("assigned_to_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "isolation_orders_patient_idx" ON "isolation_orders" USING btree ("patient_id","ended_at");--> statement-breakpoint
CREATE INDEX "roster_shifts_facility_idx" ON "roster_shifts" USING btree ("facility_id","starts_at");--> statement-breakpoint
CREATE INDEX "roster_shifts_user_idx" ON "roster_shifts" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "sepsis_screens_patient_idx" ON "sepsis_screens" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "sepsis_screens_facility_idx" ON "sepsis_screens" USING btree ("facility_id","status");--> statement-breakpoint
ALTER TABLE "ambulance_units" ADD CONSTRAINT "ambulance_units_values_ck" CHECK ("level" IN ('BLS', 'ALS') AND "status" IN ('AVAILABLE', 'DISPATCHED', 'ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'OUT_OF_SERVICE'));
--> statement-breakpoint
ALTER TABLE "ems_incidents" ADD CONSTRAINT "ems_incidents_values_ck" CHECK ("priority" IN ('P1', 'P2', 'P3') AND "status" IN ('RECEIVED', 'DISPATCHED', 'ON_SCENE', 'TRANSPORTING', 'HANDED_OVER', 'CLOSED', 'CANCELLED') AND ("outcome" IS NULL OR "outcome" IN ('TRANSPORTED', 'TREATED_ON_SCENE', 'REFUSED_TRANSPORT', 'DECEASED_ON_SCENE', 'NO_PATIENT', 'CANCELLED')));
--> statement-breakpoint
ALTER TABLE "ems_care_records" ADD CONSTRAINT "ems_care_records_kind_ck" CHECK ("kind" IN ('OBSERVATION', 'INTERVENTION', 'MEDICATION', 'NOTE'));
--> statement-breakpoint
CREATE TRIGGER ems_care_records_append_only BEFORE UPDATE OR DELETE ON "ems_care_records"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
ALTER TABLE "isolation_orders" ADD CONSTRAINT "isolation_orders_values_ck" CHECK ("precaution" IN ('CONTACT', 'DROPLET', 'AIRBORNE', 'PROTECTIVE') AND ("ended_at" IS NULL OR "end_reason" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "hai_events" ADD CONSTRAINT "hai_events_values_ck" CHECK ("type" IN ('CLABSI', 'CAUTI', 'VAP', 'SSI', 'CDI', 'MRSA_BACTERAEMIA', 'OTHER') AND "status" IN ('SUSPECTED', 'CONFIRMED', 'RULED_OUT'));
--> statement-breakpoint
ALTER TABLE "antimicrobial_approvals" ADD CONSTRAINT "antimicrobial_approvals_values_ck" CHECK ("status" IN ('REQUESTED', 'APPROVED', 'DECLINED') AND ("review_outcome" IS NULL OR "review_outcome" IN ('CONTINUE', 'NARROW', 'SWITCH_ORAL', 'STOP')));
--> statement-breakpoint
ALTER TABLE "sepsis_screens" ADD CONSTRAINT "sepsis_screens_values_ck" CHECK ("trigger" IN ('PROMPTED', 'MANUAL') AND "status" IN ('PENDING', 'NOT_SEPSIS', 'SEPSIS_SUSPECTED', 'RED_FLAG'));
--> statement-breakpoint
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_values_ck" CHECK ("kind" IN ('DAY', 'LATE', 'NIGHT', 'ON_CALL') AND "status" IN ('PLANNED', 'CANCELLED') AND "ends_at" > "starts_at" AND "ends_at" - "starts_at" <= interval '36 hours');
--> statement-breakpoint
ALTER TABLE "home_care_episodes" ADD CONSTRAINT "home_care_episodes_status_ck" CHECK ("status" IN ('REFERRED', 'ACTIVE', 'ON_HOLD', 'DISCHARGED'));
--> statement-breakpoint
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_status_ck" CHECK ("status" IN ('PLANNED', 'DONE', 'MISSED', 'CANCELLED'));
--> statement-breakpoint
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_values_ck" CHECK ("category" IN ('VENTILATOR', 'MONITOR', 'DEFIBRILLATOR', 'INFUSION_PUMP', 'IMAGING', 'LAB_ANALYSER', 'DIALYSIS', 'OTHER') AND "criticality" IN ('HIGH', 'MEDIUM', 'LOW') AND "status" IN ('IN_SERVICE', 'OUT_OF_SERVICE', 'IN_MAINTENANCE', 'RETIRED') AND ("service_interval_days" IS NULL OR "service_interval_days" > 0));
--> statement-breakpoint
ALTER TABLE "equipment_events" ADD CONSTRAINT "equipment_events_kind_ck" CHECK ("kind" IN ('SERVICE', 'FAULT', 'REPAIR', 'STATUS'));
--> statement-breakpoint
CREATE TRIGGER equipment_events_append_only BEFORE UPDATE OR DELETE ON "equipment_events"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
