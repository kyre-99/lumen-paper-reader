import { createServerClient } from "@supabase/ssr";
import { env } from "cloudflare:workers";
import { cookies } from "next/headers";

function getSupabaseConfig() {
  const runtime = env as any;
  const url = runtime.SUPABASE_URL || process.env.SUPABASE_URL;
  const key = runtime.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase authentication is not configured");
  return { url, key };
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, key } = getSupabaseConfig();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Read-only render contexts cannot update cookies; route handlers can.
        }
      },
    },
  });
}

export async function getSupabaseUser() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.email) return null;
    return data.user;
  } catch {
    return null;
  }
}

export function requestOrigin(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || (host?.startsWith("localhost") ? "http" : "https");
  return host ? `${protocol}://${host}` : new URL(request.url).origin;
}
