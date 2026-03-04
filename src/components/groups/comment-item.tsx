"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type CommentItemProps = {
  commentId: string;
  body: string;
  createdAt: string;
  authorName: string;
  authorAvatarUrl: string | null;
  canManage: boolean;
  groupId: string;
  selectedDate: string;
};

export function CommentItem({
  commentId,
  body,
  createdAt,
  authorName,
  authorAvatarUrl,
  canManage,
  groupId,
  selectedDate
}: CommentItemProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const initials = (label: string) => label.slice(0, 2).toUpperCase();

  const saveEdit = async () => {
    const nextBody = draft.trim();
    if (!nextBody) {
      router.push(`/groups/${groupId}?date=${selectedDate}&notice=comment_empty`);
      return;
    }
    if (nextBody.length > 280) {
      router.push(`/groups/${groupId}?date=${selectedDate}&notice=comment_too_long`);
      return;
    }

    setIsSaving(true);
    const res = await fetch(`/api/comments/${commentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, body: nextBody })
    });
    setIsSaving(false);

    if (!res.ok) {
      router.push(`/groups/${groupId}?date=${selectedDate}&notice=comment_edit_failed`);
      return;
    }

    setIsEditing(false);
    router.push(`/groups/${groupId}?date=${selectedDate}&notice=comment_edited`);
    router.refresh();
  };

  const removeComment = async () => {
    if (!confirm("¿Eliminar este comentario? Esta acción no se puede deshacer.")) return;
    setIsDeleting(true);
    const res = await fetch(`/api/comments/${commentId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId })
    });
    setIsDeleting(false);

    if (!res.ok) {
      router.push(`/groups/${groupId}?date=${selectedDate}&notice=comment_delete_failed`);
      return;
    }

    router.push(`/groups/${groupId}?date=${selectedDate}&notice=comment_deleted`);
    router.refresh();
  };

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {authorAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={authorAvatarUrl} alt={authorName} className="h-7 w-7 rounded-full object-cover" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700">
              {initials(authorName)}
            </span>
          )}
          <p className="text-sm font-semibold">{authorName}</p>
        </div>
        <p className="text-xs text-slate-500">
          {new Date(createdAt).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>

      {isEditing ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await saveEdit();
          }}
        >
          <textarea
            name="body"
            maxLength={280}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-16 w-full rounded-lg border border-slate-300 p-2 text-sm outline-none focus:border-sky-500"
            required
          />
          <div className="flex items-center justify-end gap-2">
            <button
              disabled={isSaving}
              type="button"
              className="h-8 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100"
              onClick={() => {
                setDraft(body);
                setIsEditing(false);
              }}
            >
              Cancelar
            </button>
            <button
              disabled={isSaving}
              className="h-8 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
            >
              {isSaving ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-slate-700">{body}</p>
      )}

      {canManage ? (
        <div className="mt-2 flex items-center justify-end gap-1">
          {!isEditing ? (
            <button
              type="button"
              className="h-7 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100"
              onClick={() => setIsEditing(true)}
            >
              Editar
            </button>
          ) : null}
          <button
            type="button"
            onClick={removeComment}
            disabled={isDeleting}
            className="h-7 rounded-md px-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Eliminar comentario"
          >
            {isDeleting ? "Eliminando..." : "Eliminar"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
