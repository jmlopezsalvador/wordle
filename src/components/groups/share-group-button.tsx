"use client";

import { useState } from "react";

type ShareGroupButtonProps = {
  groupCode: string;
};

export function ShareGroupButton({ groupCode }: ShareGroupButtonProps) {
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const baseUrl = window.location.origin;
    const joinUrl = `${baseUrl}/groups`;
    const text = `Unete a mi grupo en Wordle Score! Codigo: ${groupCode}. ${joinUrl}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: "Wordle Score!",
          text,
          url: joinUrl
        });
        return;
      } catch {
        // User cancelled or share failed; fallback to clipboard below.
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard permissions: no-op.
    }
  };

  return (
    <button
      type="button"
      className="button-secondary h-10 rounded-full px-4"
      onClick={share}
      aria-label={copied ? "Copiado" : "Compartir grupo"}
      title={copied ? "Copiado" : "Compartir grupo"}
    >
      {copied ? "Copiado" : "Compartir"}
    </button>
  );
}
