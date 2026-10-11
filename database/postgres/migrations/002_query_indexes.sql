CREATE INDEX IF NOT EXISTS idx_students_status ON students (status);
CREATE INDEX IF NOT EXISTS idx_students_class ON students (class_id);
CREATE INDEX IF NOT EXISTS idx_students_nationality ON students (nationality_id);
CREATE INDEX IF NOT EXISTS idx_visas_expiry ON visas (expiry_date);
CREATE INDEX IF NOT EXISTS idx_visas_status_expiry ON visas (status, expiry_date);
CREATE INDEX IF NOT EXISTS idx_grade_records_status ON grade_records (adapt_status);
CREATE INDEX IF NOT EXISTS idx_grade_records_audit_status ON grade_records (audit_status);
CREATE INDEX IF NOT EXISTS idx_study_records_warning ON study_records (warning_level);
