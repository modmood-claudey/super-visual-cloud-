-- conversations table for chat history sidebar
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        REFERENCES users(id) ON DELETE CASCADE,
  session_id  text        NOT NULL UNIQUE,
  platform    text        NOT NULL DEFAULT 'dashboard',
  title       text        NOT NULL DEFAULT 'New conversation',
  last_message text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated
  ON conversations (user_id, updated_at DESC);
