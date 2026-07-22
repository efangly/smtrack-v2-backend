-- Recreate the LogDaysAll reporting view (created in 20260715010000_log_day_archive)
-- with the snake_case name/columns now that log_days and log_day_archive are snake_case.
CREATE VIEW "log_days_all" AS
  SELECT "id", "serial", "temp", "temp_display", "humidity", "humidity_display", "send_time",
         "plug", "door1", "door2", "door3", "internet", "probe", "battery", "temp_internal",
         "ext_memory", "create_at", "update_at"
  FROM "log_days"
  UNION ALL
  SELECT "id", "serial", "temp", "temp_display", "humidity", "humidity_display", "send_time",
         "plug", "door1", "door2", "door3", "internet", "probe", "battery", "temp_internal",
         "ext_memory", "create_at", "update_at"
  FROM "log_day_archive";

DROP VIEW "LogDaysAll";
