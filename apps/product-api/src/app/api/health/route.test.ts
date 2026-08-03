import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";

afterEach(() => {
  delete process.env["CLIENTATLAS_MODE"];
});

describe("GET /api/health", () => {
  it("reports the service as ok", async () => {
    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("product-api");
  });

  it("defaults to local mode when CLIENTATLAS_MODE is unset", async () => {
    const body = await GET().json();

    expect(body.mode).toBe("local");
  });

  it("reports demo mode when configured", async () => {
    process.env["CLIENTATLAS_MODE"] = "demo";

    const body = await GET().json();

    expect(body.mode).toBe("demo");
  });
});
