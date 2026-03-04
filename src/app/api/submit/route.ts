import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseShareText } from "@/lib/parseShareText";

export async function POST(request: Request) {
  const formData = await request.formData();
  const groupId = String(formData.get("groupId") || "").trim();
  const shareText = String(formData.get("shareText") || "").trim();
  const requestedPlayedOn = String(formData.get("playedOn") || "").trim();

  if (!groupId || !shareText) {
    return NextResponse.redirect(new URL("/groups", request.url));
  }

  let parsed: ReturnType<typeof parseShareText>;
  try {
    parsed = parseShareText(shareText);
  } catch {
    return NextResponse.redirect(new URL(`/submit?groupId=${groupId}`, request.url));
  }
  const today = new Date().toISOString().slice(0, 10);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const [{ data: membership }, { data: group }] = await Promise.all([
    supabase
      .from("group_members")
      .select("group_id")
      .eq("group_id", groupId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("groups").select("entry_mode").eq("id", groupId).maybeSingle()
  ]);

  if (!membership || !group) {
    return NextResponse.redirect(new URL("/groups", request.url));
  }

  const playedOn = group.entry_mode === "history" && requestedPlayedOn ? requestedPlayedOn : today;

  const { data: gameType } = await supabase
    .from("game_types")
    .select("id")
    .eq("key", parsed.gameKey === "unknown" ? "wordle" : parsed.gameKey)
    .single();

  if (!gameType) {
    throw new Error("Tipo de juego no configurado");
  }

  await supabase.from("submissions").upsert(
    {
      group_id: groupId,
      user_id: user.id,
      game_type_id: gameType.id,
      game_edition: parsed.edition,
      played_on: playedOn,
      attempts: parsed.attempts,
      is_failure: parsed.isFailure,
      raw_share_text: shareText,
      grid_rows: parsed.gridRows
    },
    { onConflict: "group_id,user_id,game_type_id,played_on" }
  );

  await supabase.rpc("recalc_member_score", {
    p_group_id: groupId,
    p_user_id: user.id,
    p_through: today
  });

  return NextResponse.redirect(new URL(`/groups/${groupId}`, request.url));
}
