import { describe, expect, it } from "vitest";
import { lokiOptions, rotatorVersion } from "../src/telemetry.js";

describe("lokiOptions", () => {
  it("is off without TELEMETRY_LOKI_URL or with one that is not an http(s) URL", () => {
    expect(lokiOptions({})).toBeUndefined();
    expect(lokiOptions({ TELEMETRY_LOKI_URL: "192.168.30.11:8427 " })).toBeUndefined();
    expect(lokiOptions({ TELEMETRY_LOKI_URL: "loki:3100" })).toBeUndefined();
  });

  it("targets VictoriaLogs' Loki path with basic auth and job/event labels", () => {
    expect(lokiOptions({
      TELEMETRY_LOKI_URL: "https://192.168.30.11:8427",
      TELEMETRY_LOKI_USERNAME: "writer",
      TELEMETRY_LOKI_PASSWORD: "pw",
    })).toEqual({
      host: "https://192.168.30.11:8427",
      endpoint: "/insert/loki/api/v1/push?_msg_field=msg",
      basicAuth: { username: "writer", password: "pw" },
      labels: { job: "context7-key-rotator" },
      propsToLabels: ["event"],
      batching: { interval: 5 },
    });
  });

  it("sends no basic auth without a username, and honours an endpoint override", () => {
    const options = lokiOptions({ TELEMETRY_LOKI_URL: "http://loki:3100", TELEMETRY_LOKI_ENDPOINT: "/loki/api/v1/push" });
    expect(options?.basicAuth).toBeUndefined();
    expect(options?.endpoint).toBe("/loki/api/v1/push");
  });
});

describe("rotatorVersion", () => {
  it("is the CI build tag, or dev", () => {
    expect(rotatorVersion({ ROTATOR_VERSION: "main-20260922-abc1234-14.1" })).toBe("main-20260922-abc1234-14.1");
    expect(rotatorVersion({})).toBe("dev");
  });
});
