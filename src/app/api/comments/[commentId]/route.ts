import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Payload = {
  groupId?: string;
  body?: string;
};

export async function PATCH(request: Request, context: { params: Promise<{ commentId: string }> }) {
  const { commentId } = await context.params;
  const payload = (await request.json()) as Payload;
  const groupId = String(payload.groupId || "").trim();
  const body = String(payload.body || "").trim();

  if (!commentId || !groupId || !body || body.length > 280) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const { error } = await supabase.from("group_comments").update({ body }).eq("id", commentId).eq("group_id", groupId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: { params: Promise<{ commentId: string }> }) {
  const { commentId } = await context.params;
  const payload = (await request.json()) as Payload;
  const groupId = String(payload.groupId || "").trim();

  if (!commentId || !groupId) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const { error } = await supabase.from("group_comments").delete().eq("id", commentId).eq("group_id", groupId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });

  return NextResponse.json({ ok: true });
}
