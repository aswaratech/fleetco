"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { LinkDriverLoginFormSchema, type LinkDriverLoginFormValues } from "@/lib/drivers-schema";

import { linkDriverLoginAction, unlinkDriverLoginAction } from "../actions";

interface LoginLinkPanelProps {
  driverId: string;
  loginEmail: string | null;
}

// The driver-detail login-link panel (ADR-0034 c8's linking write path):
// an independent action alongside the read-only fields above it, NOT part
// of EditDriverForm's diff-PATCH — linking has its own endpoint, its own
// success/error shape, and (unlike every other write on this page) does
// not navigate away on success, so bundling it into the edit form's single
// submit would confuse two unrelated requests into one button. Mirrors
// DeleteDriverDialog's AlertDialog-confirm pattern for the destructive
// (unlink) half; the link half is a small inline form, matching
// EditDriverForm's Form/FormField/Input/form.setError conventions.
export function LoginLinkPanel({
  driverId,
  loginEmail: initialLoginEmail,
}: LoginLinkPanelProps): React.ReactElement {
  const [loginEmail, setLoginEmail] = useState(initialLoginEmail);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [unlinkPending, setUnlinkPending] = useState(false);

  const form = useForm<LinkDriverLoginFormValues>({
    resolver: zodResolver(LinkDriverLoginFormSchema),
    defaultValues: { email: "" },
  });

  async function onLink(values: LinkDriverLoginFormValues): Promise<void> {
    form.clearErrors();
    const result = await linkDriverLoginAction(driverId, values);
    if (!result.ok) {
      form.setError("email", { type: "server", message: result.message });
      return;
    }
    setLoginEmail(result.loginEmail);
    form.reset({ email: "" });
  }

  async function onUnlink(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    // Keep the dialog open on failure, matching DeleteDriverDialog.
    event.preventDefault();
    setUnlinkError(null);
    setUnlinkPending(true);
    const result = await unlinkDriverLoginAction(driverId);
    setUnlinkPending(false);
    if (!result.ok) {
      setUnlinkError(result.message);
      return;
    }
    setLoginEmail(null);
    setUnlinkOpen(false);
  }

  return (
    <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
      <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
        Mobile app login
      </h2>

      {loginEmail !== null ? (
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Badge variant="success">Login linked</Badge>
            <span className="text-text-primary font-mono text-sm">{loginEmail}</span>
          </div>
          <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="outline">Unlink</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unlink mobile login?</AlertDialogTitle>
                <AlertDialogDescription>
                  This driver loses mobile app access (trips, fuel logs) until a login is linked
                  again. Their login itself is not deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {unlinkError ? (
                <p role="alert" className="text-status-error text-sm">
                  {unlinkError}
                </p>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={unlinkPending}>Keep login</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={unlinkPending}
                  onClick={onUnlink}
                >
                  {unlinkPending ? "Unlinking…" : "Unlink login"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : (
        <div className="space-y-3">
          <Badge variant="neutral">No mobile login linked</Badge>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onLink)} className="flex items-start gap-3">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="sr-only">Login email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        autoComplete="off"
                        placeholder="the login's email, e.g. driver@example.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Linking…" : "Link login"}
              </Button>
            </form>
          </Form>
        </div>
      )}
    </section>
  );
}
