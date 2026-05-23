import { describe, it, expect } from "vitest";
import { checkBashCommand } from "../src/destructive-bash.js";

describe("checkBashCommand — destructive-bash blocklist", () => {
  describe("filesystem destroy", () => {
    it("blocks rm -rf /tmp/junk", () => {
      const r = checkBashCommand("rm -rf /tmp/junk");
      expect(r.allowed).toBe(false);
      expect(r.category).toBe("filesystem_destroy");
    });
    it("blocks rm -fr /some/path", () => {
      expect(checkBashCommand("rm -fr /some/path").allowed).toBe(false);
    });
    it("blocks rm --recursive --force /x", () => {
      expect(checkBashCommand("rm --recursive --force /x").allowed).toBe(false);
    });
    it("allows plain rm of a single file", () => {
      expect(checkBashCommand("rm /tmp/onefile.log").allowed).toBe(true);
    });
    it("allows rm -i for interactive removal", () => {
      expect(checkBashCommand("rm -i /tmp/onefile.log").allowed).toBe(true);
    });
  });

  describe("git destructive ops", () => {
    it("blocks git push --force", () => {
      expect(checkBashCommand("git push --force origin feat/x").allowed).toBe(false);
    });
    it("blocks git push --force-with-lease", () => {
      expect(checkBashCommand("git push --force-with-lease origin feat/x").allowed).toBe(false);
    });
    it("blocks git push -f", () => {
      expect(checkBashCommand("git push -f origin feat/x").allowed).toBe(false);
    });
    it("allows ordinary git push", () => {
      expect(checkBashCommand("git push origin feat/x").allowed).toBe(true);
    });
    it("blocks git reset --hard HEAD~1", () => {
      expect(checkBashCommand("git reset --hard HEAD~1").allowed).toBe(false);
    });
    it("allows git reset (soft)", () => {
      expect(checkBashCommand("git reset HEAD~1").allowed).toBe(true);
    });
    it("blocks git commit --amend", () => {
      expect(checkBashCommand("git commit --amend").allowed).toBe(false);
    });
    it("blocks git commit -a --amend", () => {
      expect(checkBashCommand("git commit -a --amend -m 'x'").allowed).toBe(false);
    });
    it("allows ordinary git commit", () => {
      expect(checkBashCommand("git commit -m 'feat: add x'").allowed).toBe(true);
    });
    it("blocks git rebase -i", () => {
      expect(checkBashCommand("git rebase -i main").allowed).toBe(false);
    });
    it("blocks git rebase --interactive", () => {
      expect(checkBashCommand("git rebase --interactive main").allowed).toBe(false);
    });
    it("allows non-interactive git rebase", () => {
      expect(checkBashCommand("git rebase main").allowed).toBe(true);
    });
    it("blocks git filter-branch", () => {
      expect(checkBashCommand("git filter-branch --tree-filter 'rm secret' HEAD").allowed).toBe(
        false,
      );
    });
    it("blocks git filter-repo", () => {
      expect(checkBashCommand("git filter-repo --invert-paths --path secret.txt").allowed).toBe(
        false,
      );
    });
  });

  describe("github PR lifecycle (loop owns merge)", () => {
    it("blocks gh pr close 123", () => {
      expect(checkBashCommand("gh pr close 123").allowed).toBe(false);
    });
    it("blocks gh pr merge 123 --merge", () => {
      expect(checkBashCommand("gh pr merge 123 --merge --delete-branch").allowed).toBe(false);
    });
    it("allows gh pr create", () => {
      expect(
        checkBashCommand("gh pr create --title 'feat: add x' --body 'description'").allowed,
      ).toBe(true);
    });
    it("allows gh pr view", () => {
      expect(checkBashCommand("gh pr view 123").allowed).toBe(true);
    });
    it("allows gh pr list", () => {
      expect(checkBashCommand("gh pr list --head feat/x").allowed).toBe(true);
    });
  });

  describe("database destroy (CLAUDE.md prohibition)", () => {
    it("blocks prisma db push", () => {
      expect(checkBashCommand("pnpm prisma db push").allowed).toBe(false);
    });
    it("blocks npx prisma db push", () => {
      expect(checkBashCommand("npx prisma db push").allowed).toBe(false);
    });
    it("blocks prisma migrate reset", () => {
      expect(checkBashCommand("pnpm prisma migrate reset").allowed).toBe(false);
    });
    it("blocks prisma migrate deploy", () => {
      expect(checkBashCommand("pnpm prisma migrate deploy").allowed).toBe(false);
    });
    it("allows prisma migrate dev", () => {
      expect(checkBashCommand("pnpm prisma migrate dev --name add_vehicles_table").allowed).toBe(
        true,
      );
    });
    it("blocks psql -c DROP TABLE", () => {
      expect(checkBashCommand("psql -c 'DROP TABLE users'").allowed).toBe(false);
    });
    it("blocks psql -c TRUNCATE", () => {
      expect(checkBashCommand("psql -c 'TRUNCATE TABLE users'").allowed).toBe(false);
    });
    it("blocks psql -c DELETE FROM", () => {
      expect(checkBashCommand("psql -c 'DELETE FROM users WHERE id = 1'").allowed).toBe(false);
    });
    it("allows psql -c SELECT (read-only)", () => {
      expect(checkBashCommand("psql -c 'SELECT count(*) FROM users'").allowed).toBe(true);
    });
  });

  describe("dependency removal (operator-only)", () => {
    it("blocks pnpm uninstall", () => {
      expect(checkBashCommand("pnpm uninstall some-pkg").allowed).toBe(false);
    });
    it("blocks pnpm remove", () => {
      expect(checkBashCommand("pnpm remove some-pkg").allowed).toBe(false);
    });
    it("blocks npm uninstall", () => {
      expect(checkBashCommand("npm uninstall some-pkg").allowed).toBe(false);
    });
    it("blocks yarn remove", () => {
      expect(checkBashCommand("yarn remove some-pkg").allowed).toBe(false);
    });
    it("blocks pnpm install --force", () => {
      expect(checkBashCommand("pnpm install --force").allowed).toBe(false);
    });
    it("allows pnpm install", () => {
      expect(checkBashCommand("pnpm install").allowed).toBe(true);
    });
    it("allows pnpm add", () => {
      expect(checkBashCommand("pnpm add some-pkg").allowed).toBe(true);
    });
  });

  describe("container destroy", () => {
    it("blocks docker system prune", () => {
      expect(checkBashCommand("docker system prune -af").allowed).toBe(false);
    });
    it("blocks docker volume rm", () => {
      expect(checkBashCommand("docker volume rm fleetco_pgdata").allowed).toBe(false);
    });
    it("blocks docker compose down -v", () => {
      expect(checkBashCommand("docker compose down -v").allowed).toBe(false);
    });
    it("allows docker compose down (without -v)", () => {
      expect(checkBashCommand("docker compose down").allowed).toBe(true);
    });
    it("allows docker compose up -d", () => {
      expect(checkBashCommand("docker compose up -d").allowed).toBe(true);
    });
  });

  describe("process kill", () => {
    it("blocks pkill", () => {
      expect(checkBashCommand("pkill -f some-process").allowed).toBe(false);
    });
    it("blocks killall", () => {
      expect(checkBashCommand("killall node").allowed).toBe(false);
    });
    it("blocks kill -9 1", () => {
      expect(checkBashCommand("kill -9 1").allowed).toBe(false);
    });
    it("allows kill of specific PID", () => {
      expect(checkBashCommand("kill 12345").allowed).toBe(true);
    });
  });

  describe("system path writes", () => {
    it("blocks redirection to /etc/", () => {
      expect(checkBashCommand("echo 'bad' > /etc/hosts").allowed).toBe(false);
    });
    it("blocks redirection to /usr/", () => {
      expect(checkBashCommand("echo 'bad' > /usr/bin/something").allowed).toBe(false);
    });
    it("blocks redirection to /System/", () => {
      expect(checkBashCommand("echo 'bad' > /System/foo").allowed).toBe(false);
    });
    it("blocks pipe to /etc/", () => {
      expect(checkBashCommand("cat secret | /etc/passwd").allowed).toBe(false);
    });
  });

  describe("approve everything else (default-allow)", () => {
    it("allows ls", () => {
      expect(checkBashCommand("ls -la").allowed).toBe(true);
    });
    it("allows pnpm test", () => {
      expect(checkBashCommand("pnpm test").allowed).toBe(true);
    });
    it("allows git status", () => {
      expect(checkBashCommand("git status").allowed).toBe(true);
    });
    it("allows complex but benign pipelines", () => {
      expect(checkBashCommand("find . -name '*.ts' | head -20").allowed).toBe(true);
    });
  });

  // Iter 1 of the Phase 1 Vehicles slice (2026-05-22) surfaced this false-
  // positive: the agent's `gh pr create --body "..."` was denied because the
  // PR body contained the literal text "prisma migrate reset" as documentation
  // (the body explained how to roll back). The fix strips quoted strings and
  // heredoc bodies before applying the patterns, so text inside an argument
  // is no longer mistaken for a command being run.
  describe("quoted/heredoc body false-positive prevention", () => {
    it("allows gh pr create with 'prisma migrate reset' in a double-quoted body", () => {
      const cmd =
        'gh pr create --title "feat: x" --body "Note: do not run pnpm prisma migrate reset in prod"';
      expect(checkBashCommand(cmd).allowed).toBe(true);
    });

    it("allows gh pr create with 'prisma migrate reset' inside a heredoc body", () => {
      const cmd = `gh pr create --title "feat: x" --body "$(cat <<'EOF'
This PR adds a migration.
DO NOT pnpm prisma migrate reset against production.
EOF
)"`;
      expect(checkBashCommand(cmd).allowed).toBe(true);
    });

    it("allows git commit -m with destructive-looking text in the message", () => {
      const cmd = `git commit -m "fix: avoid prisma db push in CI workflows"`;
      expect(checkBashCommand(cmd).allowed).toBe(true);
    });

    it("allows git commit -m mentioning DROP TABLE inside the quoted message", () => {
      const cmd = `git commit -m "docs: explain why we never DROP TABLE outside migrations"`;
      expect(checkBashCommand(cmd).allowed).toBe(true);
    });

    it("allows gh pr create with rm -rf mentioned inside a single-quoted body", () => {
      const cmd = `gh pr create --title 'feat: x' --body 'Reverting: do not rm -rf node_modules without lockfile backup'`;
      expect(checkBashCommand(cmd).allowed).toBe(true);
    });

    // Still-blocks-when-real: the strip mustn't gut the blocklist's ability to
    // catch genuinely destructive commands. These all run the destructive op
    // outside of a quoted arg.
    it("still blocks standalone prisma migrate reset (no quotes)", () => {
      expect(checkBashCommand("pnpm --filter @fleetco/api exec prisma migrate reset").allowed).toBe(
        false,
      );
    });
    it("still blocks prisma migrate reset chained after &&", () => {
      expect(checkBashCommand("cd apps/api && pnpm prisma migrate reset --force").allowed).toBe(
        false,
      );
    });
    it("still blocks rm -rf in a real command (no surrounding quotes)", () => {
      expect(checkBashCommand("rm -rf /tmp/junk-dir").allowed).toBe(false);
    });

    // psql -c "DROP ..." must remain blocked: the inspectQuoted flag on the
    // psql pattern means we check the ORIGINAL command including the quoted
    // content. The whole point of this pattern is to catch destructive SQL
    // inside the -c argument.
    it("still blocks psql -c with DROP inside double-quoted SQL", () => {
      expect(checkBashCommand('psql -c "DROP TABLE users"').allowed).toBe(false);
    });
    it("still blocks psql -c with DROP inside single-quoted SQL", () => {
      expect(checkBashCommand("psql -c 'DROP TABLE users'").allowed).toBe(false);
    });
    it('still blocks PGPASSWORD=... psql -c "DROP DATABASE ..."', () => {
      const cmd =
        'PGPASSWORD=fleetco psql -h localhost -p 55432 -U fleetco -d postgres -c "DROP DATABASE fleetco_shadow"';
      expect(checkBashCommand(cmd).allowed).toBe(false);
    });
  });
});
