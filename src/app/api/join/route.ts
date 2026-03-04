import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const formData = await request.formData();
  const code = String(formData.get("code") || "")
    .trim()
    .toUpperCase();

  if (!code) {
    return NextResponse.redirect(new URL("/groups", request.url));
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const { data: groupId } = await supabase.rpc("join_group_by_code", { p_code: code });
  return NextResponse.redirect(new URL(groupId ? `/groups/${groupId}` : "/groups", request.url));
}
