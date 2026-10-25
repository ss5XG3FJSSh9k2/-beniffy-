-- Round Support Settings: 039-support-settings.sql
CREATE TABLE IF NOT EXISTS support_settings (
  id TEXT PRIMARY KEY,
  support_phone TEXT,
  support_whatsapp TEXT,
  support_email TEXT,
  support_hours TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);
