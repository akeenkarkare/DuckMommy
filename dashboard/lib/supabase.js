import { createClient } from '@supabase/supabase-js';

// Browser client: publishable key + the user's session. RLS limits it to the user's own rows.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
