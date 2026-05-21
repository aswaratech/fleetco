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
});
