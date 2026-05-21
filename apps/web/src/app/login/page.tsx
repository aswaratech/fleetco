export default function LoginPage() {
  return (
    <main className="bg-surface-canvas flex min-h-svh items-center justify-center p-4">
      <div className="border-border-subtle bg-surface-raised w-full max-w-sm space-y-6 rounded border p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-text-primary text-2xl font-semibold">Sign in</h1>
          <p className="text-text-muted text-sm">FleetCo admin</p>
        </div>
        <form className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="email" className="text-text-secondary block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="border-border-strong bg-surface-raised text-text-primary placeholder:text-text-muted focus:border-border-focus focus:ring-border-focus block h-9 w-full rounded border px-3 text-sm focus:outline-none focus:ring-1"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="text-text-secondary block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className="border-border-strong bg-surface-raised text-text-primary placeholder:text-text-muted focus:border-border-focus focus:ring-border-focus block h-9 w-full rounded border px-3 text-sm focus:outline-none focus:ring-1"
            />
          </div>
          <button
            type="button"
            className="bg-accent-primary text-accent-foreground hover:bg-accent-primary-hover focus:ring-border-focus block h-9 w-full rounded text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
