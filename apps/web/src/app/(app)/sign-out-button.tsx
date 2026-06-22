"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [isPending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={isPending}>
      {isPending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
