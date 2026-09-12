import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { createFetchSchemaResolver } from "../src/fetchSchema.js";
import { withTempDirAsync } from "./helpers.js";

type Route = {
  body: string;
  contentLength?: number;
  contentType?: string;
  etag?: string;
  redirectTo?: string;
  status?: number;
};

type TestServer = {
  origin: string;
  requests: string[];
  close: () => Promise<void>;
};

const startServer = async (routes: Record<string, Route>): Promise<TestServer> => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push(pathname);
    const route = routes[pathname];
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    if (route.redirectTo !== undefined) {
      response.writeHead(302, { location: route.redirectTo });
      response.end();
      return;
    }
    response.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "application/xml",
      ...(route.contentLength !== undefined && { "content-length": route.contentLength }),
      ...(route.etag !== undefined && { etag: route.etag }),
    });
    response.end(route.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const withServer = async (
  routes: Record<string, Route>,
  run: (server: TestServer) => Promise<void>,
): Promise<void> => {
  const server = await startServer(routes);
  try {
    await run(server);
  } finally {
    await server.close();
  }
};

let cacheCounter = 0;

const runCli = async (
  args: string[],
  options?: { cacheDir?: string },
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const outIndex = args.findIndex((arg) => arg === "-o" || arg === "--out");
  const cwd = outIndex >= 0 ? path.resolve(args[outIndex + 1] ?? "") : undefined;
  const previousCwd = process.cwd();
  const previousCacheHome = process.env["XDG_CACHE_HOME"];
  if (cwd !== undefined) {
    fs.mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
    process.env["XDG_CACHE_HOME"] =
      options?.cacheDir ?? path.join(cwd, `.cache-${process.pid}-${cacheCounter++}`);
  }
  const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  try {
    return { code: await main(args), stdout: logs.join("\n"), stderr: errors.join("\n") };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (cwd !== undefined) {
      process.chdir(previousCwd);
      if (previousCacheHome === undefined) {
        delete process.env["XDG_CACHE_HOME"];
      } else {
        process.env["XDG_CACHE_HOME"] = previousCacheHome;
      }
    }
  }
};

const typeSchema = (name: string): string => `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:t="urn:types" targetNamespace="urn:types">
  <xs:complexType name="${name}">
    <xs:sequence><xs:element name="value" type="xs:string"/></xs:sequence>
  </xs:complexType>
</xs:schema>`;

describe("CLI remote schema input", () => {
  it("generates from a URL and resolves relative and root-absolute remote imports", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/api/my%20entry.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="types/common.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
          },
          "/api/types/common.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:types">
              <xs:include schemaLocation="/shared.xsd"/>
              <xs:complexType name="ThingType">
                <xs:sequence><xs:element name="shared" type="t:SharedType"/></xs:sequence>
              </xs:complexType>
            </xs:schema>`,
          },
          "/shared.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
              <xs:simpleType name="SharedType"><xs:restriction base="xs:string"/></xs:simpleType>
            </xs:schema>`,
          },
        },
        async (server) => {
          const result = await runCli([
            `${server.origin}/api/my%20entry.xsd?version=1`,
            "-o",
            dir,
            "--allow-http",
            "--allow-host",
            "127.0.0.1",
          ]);

          expect(result.code).toBe(0);
          expect(server.requests).toEqual([
            "/api/my%20entry.xsd",
            "/api/types/common.xsd",
            "/shared.xsd",
          ]);
          expect(result.stderr).toContain("fetching ");
          expect(fs.existsSync(path.join(dir, "my entry.zod.ts"))).toBe(true);
          expect(fs.readFileSync(path.join(dir, "my entry.zod.ts"), "utf8")).toContain(
            "ThingTypeSchema",
          );
        },
      );
    });
  });

  it("keeps local remote imports offline by default and resolves them with --fetch", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer({ "/types.xsd": { body: typeSchema("ThingType") } }, async (server) => {
        const input = path.join(dir, "main.xsd");
        fs.writeFileSync(
          input,
          `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="${server.origin}/types.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
        );

        const offline = await runCli([input, "-o", dir]);
        expect(offline.code).toBe(0);
        expect(offline.stderr).toContain("remote-schema-location");
        expect(offline.stderr).toContain("re-run with --fetch");
        expect(server.requests).toEqual([]);

        const fetched = await runCli([input, "-o", dir, "--fetch", "--allow-http"]);
        expect(fetched.code).toBe(0);
        expect(server.requests).toEqual(["/types.xsd"]);
        expect(fetched.stderr).toContain(`fetching ${server.origin}/types.xsd`);
        expect(fs.readFileSync(path.join(dir, "main.zod.ts"), "utf8")).toContain("ThingTypeSchema");
      });
    });
  });

  it("--no-fetch fetches a remote entry but skips its remote imports", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/entry.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="types.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
          },
          "/types.xsd": { body: typeSchema("ThingType") },
        },
        async (server) => {
          const result = await runCli([
            `${server.origin}/entry.xsd`,
            "-o",
            dir,
            "--allow-http",
            "--no-fetch",
          ]);

          expect(result.code).toBe(0);
          expect(server.requests).toEqual(["/entry.xsd"]);
          expect(result.stderr).toContain("remote-schema-location");
          expect(result.stderr).not.toContain("re-run with --fetch");
          expect(fs.existsSync(path.join(dir, "entry.zod.ts"))).toBe(true);
        },
      );
    });
  });

  it("--no-fetch skips transitive imports without applying policy checks", async () => {
    await withTempDirAsync(async (dir) => {
      const entryRoute: Route = { body: "" };
      await withServer({ "/entry.xsd": entryRoute }, async (server) => {
        entryRoute.body = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="http://user:secret@${new URL(server.origin).host}/types.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`;

        const result = await runCli([
          `${server.origin}/entry.xsd`,
          "-o",
          dir,
          "--allow-http",
          "--no-fetch",
        ]);

        expect(result.code).toBe(0);
        expect(server.requests).toEqual(["/entry.xsd"]);
        expect(result.stderr).toContain("remote-schema-location");
        expect(result.stderr).not.toContain("remote-credentials-not-allowed");
      });
    });
  });

  it("skips policy checks for transitive imports when fetchTransitive is false", async () => {
    const entry = "https://schemas.example.test/entry.xsd";
    const resolveSchema = createFetchSchemaResolver({
      entryUrls: [entry],
      fetchTransitive: false,
      fetchImplementation: async () => {
        throw new Error("must not fetch");
      },
    });

    const skipped = await resolveSchema("http://user:secret@other.example.test/types.xsd", {
      kind: "url",
      url: entry,
    });
    expect(skipped).toBeUndefined();
  });

  it("skips policy checks for local-file remote imports when fetchRemoteFromLocal is false", async () => {
    const resolveSchema = createFetchSchemaResolver({
      fetchRemoteFromLocal: false,
      fetchImplementation: async () => {
        throw new Error("must not fetch");
      },
    });

    const skipped = await resolveSchema("http://user:secret@example.test/types.xsd", {
      kind: "file",
      path: "/tmp/main.xsd",
    });
    expect(skipped).toBeUndefined();
  });

  it("refuses plain http and disallowed hosts before fetching", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer({ "/entry.xsd": { body: typeSchema("ThingType") } }, async (server) => {
        const insecure = await runCli([`${server.origin}/entry.xsd`, "-o", dir]);
        expect(insecure.code).toBe(1);
        expect(insecure.stderr).toContain("Refusing insecure http");
        expect(server.requests).toEqual([]);

        const blocked = await runCli([
          `${server.origin}/entry.xsd`,
          "-o",
          dir,
          "--allow-http",
          "--allow-host",
          "example.com",
        ]);
        expect(blocked.code).toBe(1);
        expect(blocked.stderr).toContain(`host "${new URL(server.origin).host}" is not allowed`);
        expect(server.requests).toEqual([]);

        const withCredentials = await runCli([
          `${server.origin.replace("://", "://user:secret@")}/entry.xsd`,
          "-o",
          dir,
          "--allow-http",
        ]);
        expect(withCredentials.code).toBe(1);
        expect(withCredentials.stderr).toContain("must not contain credentials");
        expect(withCredentials.stderr).toContain("[remote-credentials-not-allowed]");
        expect(server.requests).toEqual([]);
      });
    });
  });

  it("does not follow redirects to non-http schemes", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        { "/entry.xsd": { body: "", redirectTo: "file:///etc/passwd" } },
        async (server) => {
          const result = await runCli([`${server.origin}/entry.xsd`, "-o", dir, "--allow-http"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("unsupported scheme");
          expect(result.stderr).toContain("[remote-scheme-not-allowed]");
        },
      );
    });
  });

  it("reports missing and non-XML remote schemas distinctly", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        { "/login.xsd": { body: "<html>login</html>", contentType: "text/html" } },
        async (server) => {
          const missing = await runCli([`${server.origin}/missing.xsd`, "-o", dir, "--allow-http"]);
          expect(missing.code).toBe(1);
          expect(missing.stderr).toContain("Remote schema not found (404)");
          expect(missing.stderr).toContain("[remote-not-found]");

          const html = await runCli([`${server.origin}/login.xsd`, "-o", dir, "--allow-http"]);
          expect(html.code).toBe(1);
          expect(html.stderr).toContain("Expected XSD");
          expect(html.stderr).toContain("text/html");
          expect(html.stderr).toContain("[remote-content-type]");
        },
      );
    });
  });

  it("rejects XHTML and sniffed HTML error pages served as plain text", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/login.xhtml": { body: "<html>login</html>", contentType: "application/xhtml+xml" },
          "/error.xsd": {
            body: "<!DOCTYPE html><html><body>oops</body></html>",
            contentType: "text/plain",
          },
          "/real.xsd": { body: typeSchema("ThingType"), contentType: "text/plain" },
        },
        async (server) => {
          const xhtml = await runCli([`${server.origin}/login.xhtml`, "-o", dir, "--allow-http"]);
          expect(xhtml.code).toBe(1);
          expect(xhtml.stderr).toContain("Expected XSD");
          expect(xhtml.stderr).toContain("application/xhtml+xml");
          expect(xhtml.stderr).toContain("[remote-content-type]");

          const sniffed = await runCli([`${server.origin}/error.xsd`, "-o", dir, "--allow-http"]);
          expect(sniffed.code).toBe(1);
          expect(sniffed.stderr).toContain("Expected XSD");
          expect(sniffed.stderr).toContain("[remote-content-type]");

          const plain = await runCli([`${server.origin}/real.xsd`, "-o", dir, "--allow-http"]);
          expect(plain.code).toBe(0);
          expect(fs.existsSync(path.join(dir, "real.zod.ts"))).toBe(true);
        },
      );
    });
  });

  it("keeps local inputs offline in mixed runs unless --fetch is passed", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/remote-entry.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="types-remote.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
          },
          "/types-remote.xsd": { body: typeSchema("ThingType") },
          "/local-types.xsd": { body: typeSchema("LocalType") },
        },
        async (server) => {
          const localMain = path.join(dir, "local-main.xsd");
          fs.writeFileSync(
            localMain,
            `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="${server.origin}/local-types.xsd"/>
              <xs:element name="localDoc" type="t:LocalType"/>
            </xs:schema>`,
          );

          const mixed = await runCli([
            localMain,
            `${server.origin}/remote-entry.xsd`,
            "-o",
            dir,
            "-n",
            "mixed",
            "--allow-http",
          ]);
          expect(mixed.code).toBe(0);
          expect(server.requests).toEqual(["/remote-entry.xsd", "/types-remote.xsd"]);
          expect(mixed.stderr).toContain("remote-schema-location");

          server.requests.length = 0;
          const fetched = await runCli([
            localMain,
            `${server.origin}/remote-entry.xsd`,
            "-o",
            dir,
            "-n",
            "mixed",
            "--allow-http",
            "--fetch",
          ]);
          expect(fetched.code).toBe(0);
          expect(server.requests).toEqual([
            "/local-types.xsd",
            "/remote-entry.xsd",
            "/types-remote.xsd",
          ]);
        },
      );
    });
  });

  it("enforces the import depth limit on long remote chains", async () => {
    await withTempDirAsync(async (dir) => {
      const chainLength = 40;
      const routes: Record<string, Route> = {};
      for (let level = 0; level < chainLength; level++) {
        routes[`/s${level}.xsd`] = {
          body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
            <xs:import namespace="urn:chain" schemaLocation="s${level + 1}.xsd"/>
          </xs:schema>`,
        };
      }
      routes[`/s${chainLength}.xsd`] = { body: typeSchema("ThingType") };
      await withServer(routes, async (server) => {
        const result = await runCli([`${server.origin}/s0.xsd`, "-o", dir, "--allow-http"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("[remote-depth-limit]");
      });
    });
  });
  it("reports DNS failures distinctly", async () => {
    const url = "https://schemas.example.test/entry.xsd";
    const resolveSchema = createFetchSchemaResolver({
      fetchImplementation: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      },
    });

    await expect(resolveSchema(url, { kind: "url", url })).rejects.toMatchObject({
      code: "remote-dns",
    });
  });

  it("reports wrapped timeout failures distinctly", async () => {
    const url = "https://schemas.example.test/slow.xsd";
    const resolveSchema = createFetchSchemaResolver({
      fetchImplementation: async () => {
        throw new TypeError("fetch failed", {
          cause: new DOMException("The operation timed out", "TimeoutError"),
        });
      },
    });

    await expect(resolveSchema(url, { kind: "url", url })).rejects.toMatchObject({
      code: "remote-timeout",
    });
  });

  it("refuses a response whose declared size exceeds the file cap", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/large.xsd": {
            body: "<xs:schema/>",
            contentLength: 10 * 1024 * 1024 + 1,
          },
        },
        async (server) => {
          const result = await runCli([`${server.origin}/large.xsd`, "-o", dir, "--allow-http"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("exceeds the 10485760-byte file limit");
          expect(result.stderr).toContain("[remote-file-too-large]");
        },
      );
    });
  });

  it("follows a cross-origin redirect and resolves relative imports from the final URL", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/final.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="types.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
          },
          "/types.xsd": { body: typeSchema("ThingType") },
        },
        async (target) => {
          await withServer(
            { "/entry.xsd": { body: "", redirectTo: `${target.origin}/final.xsd` } },
            async (redirector) => {
              const result = await runCli([
                `${redirector.origin}/entry.xsd`,
                "-o",
                dir,
                "--allow-http",
              ]);

              expect(result.code).toBe(0);
              expect(target.requests).toEqual(["/final.xsd", "/types.xsd"]);
              expect(result.stderr).toContain("warning: cross-origin redirect:");
              expect(fs.existsSync(path.join(dir, "entry.zod.ts"))).toBe(true);
            },
          );
        },
      );
    });
  });

  it("fetches a duplicate remote import only once", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer(
        {
          "/entry.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="types.xsd"/>
              <xs:import namespace="urn:types" schemaLocation="types.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
          },
          "/types.xsd": { body: typeSchema("ThingType") },
        },
        async (server) => {
          const result = await runCli([`${server.origin}/entry.xsd`, "-o", dir, "--allow-http"]);
          expect(result.code).toBe(0);
          expect(server.requests).toEqual(["/entry.xsd", "/types.xsd"]);
        },
      );
    });
  });

  it("rejects conflicting or inapplicable fetch flags", async () => {
    await withTempDirAsync(async (dir) => {
      const input = path.join(dir, "schema.xsd");
      fs.writeFileSync(input, typeSchema("ThingType"));

      const conflict = await runCli([input, "-o", dir, "--fetch", "--no-fetch"]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain("cannot be used together");

      const inapplicable = await runCli([input, "-o", dir, "--no-fetch"]);
      expect(inapplicable.code).toBe(1);
      expect(inapplicable.stderr).toContain("only applies to remote");
    });
  });
});

type Lockfile = {
  version: number;
  schemas: Record<string, { sha256: string; finalUrl: string; fetchedAt: string; etag?: string }>;
};

const readLockfile = (dir: string): Lockfile =>
  JSON.parse(fs.readFileSync(path.join(dir, "xsd-to-zod.lock.json"), "utf8")) as Lockfile;

const storedCacheDir = (cacheRoot: string): string => path.join(cacheRoot, "xsd-to-zod", "schemas");

describe("remote schema lockfile and cache", () => {
  const entrySchema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:t="urn:types" targetNamespace="urn:main">
    <xs:import namespace="urn:types" schemaLocation="types.xsd"/>
    <xs:element name="doc" type="t:ThingType"/>
  </xs:schema>`;

  it("writes a lockfile and serves later runs, including --offline, from the cache", async () => {
    await withTempDirAsync(async (dir) => {
      const cacheDir = path.join(dir, "cache");
      await withServer(
        {
          "/entry.xsd": { body: entrySchema, etag: '"entry-v1"' },
          "/types.xsd": { body: typeSchema("ThingType") },
        },
        async (server) => {
          const args = [`${server.origin}/entry.xsd`, "-o", dir, "--allow-http"];
          const first = await runCli(args, { cacheDir });
          expect(first.code).toBe(0);
          expect(first.stdout).toContain("recorded 2 remote schemas");
          expect(server.requests).toEqual(["/entry.xsd", "/types.xsd"]);

          const lockfile = readLockfile(dir);
          expect(lockfile.version).toBe(1);
          expect(Object.keys(lockfile.schemas)).toEqual([
            `${server.origin}/entry.xsd`,
            `${server.origin}/types.xsd`,
          ]);
          expect(lockfile.schemas[`${server.origin}/entry.xsd`]?.etag).toBe('"entry-v1"');
          expect(
            fs.readdirSync(storedCacheDir(cacheDir)).filter((file) => file.endsWith(".xsd")),
          ).toHaveLength(2);

          server.requests.length = 0;
          const cached = await runCli(args, { cacheDir });
          expect(cached.code).toBe(0);
          expect(cached.stdout).not.toContain("recorded");
          expect(cached.stderr).not.toContain("fetching ");
          expect(server.requests).toEqual([]);

          const offline = await runCli([...args, "--offline"], { cacheDir });
          expect(offline.code).toBe(0);
          expect(server.requests).toEqual([]);

          const missing = await runCli(
            [`${server.origin}/missing.xsd`, "-o", dir, "--allow-http", "--offline"],
            { cacheDir },
          );
          expect(missing.code).toBe(1);
          expect(missing.stderr).toContain("[remote-cache-miss]");
          expect(server.requests).toEqual([]);
        },
      );
    });
  });

  it("enforces --frozen against cached and fetched content without rewriting the lockfile", async () => {
    await withTempDirAsync(async (dir) => {
      const cacheDir = path.join(dir, "cache");
      const routes: Record<string, Route> = {
        "/entry.xsd": { body: entrySchema },
        "/types.xsd": { body: typeSchema("ThingType") },
      };
      await withServer(routes, async (server) => {
        const args = [`${server.origin}/entry.xsd`, "-o", dir, "--allow-http"];
        expect((await runCli(args, { cacheDir })).code).toBe(0);
        const lockfileText = fs.readFileSync(path.join(dir, "xsd-to-zod.lock.json"), "utf8");

        server.requests.length = 0;
        const frozen = await runCli([...args, "--frozen"], { cacheDir });
        expect(frozen.code).toBe(0);
        expect(server.requests).toEqual([]);
        expect(fs.readFileSync(path.join(dir, "xsd-to-zod.lock.json"), "utf8")).toBe(lockfileText);

        const cachedFiles = fs
          .readdirSync(storedCacheDir(cacheDir))
          .filter((file) => file.endsWith(".xsd"))
          .map((file) => path.join(storedCacheDir(cacheDir), file));
        fs.appendFileSync(cachedFiles[0]!, "tampered");
        const tampered = await runCli([...args, "--frozen"], { cacheDir });
        expect(tampered.code).toBe(1);
        expect(tampered.stderr).toContain("[remote-integrity]");
        expect(server.requests).toEqual([]);

        fs.rmSync(cacheDir, { recursive: true, force: true });
        routes["/types.xsd"]!.body = typeSchema("ChangedType");
        const changed = await runCli([...args, "--frozen"], { cacheDir });
        expect(changed.code).toBe(1);
        expect(changed.stderr).toContain("[remote-integrity]");
        expect(fs.readFileSync(path.join(dir, "xsd-to-zod.lock.json"), "utf8")).toBe(lockfileText);
        expect(fs.existsSync(cacheDir)).toBe(false);

        const missing = await runCli(
          [`${server.origin}/other.xsd`, "-o", dir, "--allow-http", "--frozen"],
          { cacheDir },
        );
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("[remote-lock-missing]");
      });
    });
  });

  it("requires an existing lockfile for --frozen and --offline", async () => {
    await withTempDirAsync(async (dir) => {
      await withServer({ "/entry.xsd": { body: entrySchema } }, async (server) => {
        for (const flag of ["--frozen", "--offline"]) {
          const result = await runCli(
            [`${server.origin}/entry.xsd`, "-o", dir, "--allow-http", flag],
            { cacheDir: path.join(dir, `cache-${flag.slice(2)}`) },
          );
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("[remote-lockfile-missing]");
          expect(result.stderr).toContain(flag);
        }
      });
      expect(fs.existsSync(path.join(dir, "xsd-to-zod.lock.json"))).toBe(false);
    });
  });

  it("detects final-URL drift under --frozen", async () => {
    await withTempDirAsync(async (dir) => {
      const cacheDir = path.join(dir, "cache");
      const rootSchema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
        <xs:element name="doc" type="xs:string"/>
      </xs:schema>`;
      const routes: Record<string, Route> = {
        "/entry.xsd": { body: "", redirectTo: "" },
        "/v1.xsd": { body: rootSchema },
        "/v2.xsd": { body: rootSchema },
      };
      await withServer(routes, async (server) => {
        routes["/entry.xsd"]!.redirectTo = `${server.origin}/v1.xsd`;
        const args = [`${server.origin}/entry.xsd`, "-o", dir, "--allow-http"];
        expect((await runCli(args, { cacheDir })).code).toBe(0);

        fs.rmSync(cacheDir, { recursive: true, force: true });
        routes["/entry.xsd"]!.redirectTo = `${server.origin}/v2.xsd`;
        const drifted = await runCli([...args, "--frozen"], { cacheDir });
        expect(drifted.code).toBe(1);
        expect(drifted.stderr).toContain("[remote-final-url-mismatch]");
      });
    });
  });

  it("rejects malformed lockfile entries before reading the cache", async () => {
    await withTempDirAsync(async (dir) => {
      const url = "https://schemas.example.test/entry.xsd";
      fs.writeFileSync(
        path.join(dir, "xsd-to-zod.lock.json"),
        `${JSON.stringify({
          version: 1,
          schemas: {
            [url]: {
              sha256: "not-a-sha256",
              finalUrl: url,
              fetchedAt: new Date().toISOString(),
            },
          },
        })}\n`,
      );

      const result = await runCli([url, "-o", dir, "--frozen"], {
        cacheDir: path.join(dir, "cache"),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("[remote-lockfile-invalid]");
    });
  });

  it("leaves no committed cache or lockfile after a partially fetched closure", async () => {
    await withTempDirAsync(async (dir) => {
      const cacheDir = path.join(dir, "cache");
      await withServer(
        {
          "/entry.xsd": {
            body: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
              xmlns:t="urn:types" targetNamespace="urn:main">
              <xs:import namespace="urn:types" schemaLocation="broken.xsd"/>
              <xs:element name="doc" type="t:ThingType"/>
            </xs:schema>`,
          },
          "/broken.xsd": { body: "broken", status: 500 },
        },
        async (server) => {
          const result = await runCli([`${server.origin}/entry.xsd`, "-o", dir, "--allow-http"], {
            cacheDir,
          });
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("[remote-http-status]");
          expect(fs.existsSync(path.join(dir, "xsd-to-zod.lock.json"))).toBe(false);
          expect(fs.existsSync(cacheDir)).toBe(false);
        },
      );
    });
  });
});
