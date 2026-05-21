"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

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
import { authClient } from "@/lib/auth-client";

const schema = z.object({
  email: z.string().email("Enter a valid email."),
  password: z.string().min(1, "Password is required."),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    const result = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    if (result.error) {
      setSubmitError(result.error.message ?? "Sign in failed.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <main className="bg-surface-canvas flex min-h-svh items-center justify-center p-4">
      <div className="border-border-subtle bg-surface-raised w-full max-w-sm space-y-6 rounded border p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-text-primary text-2xl font-semibold">Sign in</h1>
          <p className="text-text-muted text-sm">FleetCo admin</p>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="current-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {submitError ? (
              <p role="alert" className="text-status-error text-sm">
                {submitError}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Form>
      </div>
    </main>
  );
}
