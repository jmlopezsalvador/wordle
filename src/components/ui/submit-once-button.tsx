"use client";

import { useFormStatus } from "react-dom";

type SubmitOnceButtonProps = {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
};

export function SubmitOnceButton({ children, pendingText = "Enviando...", className }: SubmitOnceButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingText : children}
    </button>
  );
}
