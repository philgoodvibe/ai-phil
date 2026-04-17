import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Full handler implementation lands in Task 19.
// For now: 405 on non-POST, 200 ok on POST with zero work.

Deno.serve((req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  return new Response(
    JSON.stringify({ ok: true, processed: 0, errors: 0, note: 'skeleton — Task 19 pending' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
