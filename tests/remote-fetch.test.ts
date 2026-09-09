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
  redirectTo?: string;
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
    response.writeHead(200, {
      "content-type": route.contentType ?? "application/xml",
      ...(route.contentLength !== undefined && { "content-length": route.contentLength }),
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

const runCli = async (
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const logs: string[] = [];
  const errors: string[] = [];
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
