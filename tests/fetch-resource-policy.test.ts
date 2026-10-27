import path from "node:path";
import { Response } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createFetchSchemaResolver } from "../src/fetchSchema.js";
import { RemoteSchemaStore } from "../src/remoteSchemaStore.js";
import { withTempDirAsync } from "./helpers.js";

const base = { kind: "url", url: "https://example.com/entry.xsd" } as const;

describe("remote resolver resource policy", () => {
  it.each([
    { status: 404, headers: {}, code: "remote-not-found" },
    { status: 500, headers: {}, code: "remote-http-status" },
    { status: 200, headers: { "content-type": "text/html" }, code: "remote-content-type" },
    {
      status: 200,
      headers: { "content-length": String(11 * 1024 * 1024) },
      code: "remote-file-too-large",
    },
  ])("cancels unread response bodies on $code", async ({ status, headers, code }) => {
    const cancel = vi.fn();
    const resolver = createFetchSchemaResolver({
      fetchImplementation: async () =>
        new Response(new ReadableStream({ cancel }), { status, headers }),
    });
    await expect(resolver.resolve(base.url, base)).rejects.toMatchObject({ code });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not reuse an ETag after same-origin redirect drift", async () => {
    await withTempDirAsync(async (cwd) => {
      const store = await RemoteSchemaStore.open({ cwd, cacheDir: path.join(cwd, "cache") });
      store.stage({
        requestedUrl: base.url,
        finalUrl: base.url,
        content: Buffer.from("old schema"),
        etag: '"shared-etag"',
      });
      await store.commit();
      const frozen = await RemoteSchemaStore.open({
        cwd,
        cacheDir: path.join(cwd, "cache"),
        frozen: true,
      });
      const validators: (string | undefined)[] = [];
      const resolver = createFetchSchemaResolver({
        store: frozen,
        revalidate: true,
        fetchImplementation: async (url, init) => {
          validators.push(init.headers?.["if-none-match"]);
          if (url.href === base.url) {
            return new Response(null, { status: 302, headers: { location: "/moved.xsd" } });
          }
          return init.headers?.["if-none-match"]
            ? new Response(null, { status: 304 })
            : new Response("new schema");
        },
      });
      await expect(resolver.resolve(base.url, base)).rejects.toMatchObject({
        code: "remote-final-url-mismatch",
      });
      expect(validators).toEqual(['"shared-etag"', undefined]);
    });
  });

  it.each(["file", "total", "count"] as const)(
    "enforces the %s budget on offline cache hits",
    async (budget) => {
      await withTempDirAsync(async (cwd) => {
        const cacheDir = path.join(cwd, "cache");
        const store = await RemoteSchemaStore.open({ cwd, cacheDir });
        const count = budget === "count" ? 101 : budget === "total" ? 6 : 1;
        const content = Buffer.alloc(
          budget === "count" ? 1 : (budget === "file" ? 11 : 10) * 1024 * 1024,
          "x",
        );
        const urls = Array.from({ length: count }, (_, i) => `https://example.com/${i}.xsd`);
        for (const url of urls) {
          store.stage({ requestedUrl: url, finalUrl: url, content });
        }
        await store.commit();
        const offline = await RemoteSchemaStore.open({ cwd, cacheDir, offline: true });
        const resolver = createFetchSchemaResolver({ store: offline, offline: true });
        for (const url of urls.slice(0, -1)) {
          await resolver.resolve(url, base);
        }
        const code = {
          file: "remote-file-too-large",
          total: "remote-total-too-large",
          count: "remote-file-limit",
        }[budget];
        await expect(resolver.resolve(urls.at(-1) ?? "", base)).rejects.toMatchObject({ code });
      });
    },
  );
});
