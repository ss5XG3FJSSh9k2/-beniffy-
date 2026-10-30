-- Round WhatsApp & Notifications: 041-whatsapp-opt-in.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;
