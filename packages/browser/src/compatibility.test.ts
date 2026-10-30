import { describe, expect, test } from "bun:test";

import {
  agentBrowserCompatibility,
  browserVersionCompatibility,
  chromiumCompatibility,
} from "#src/compatibility";

describe("browser compatibility", () => {
  test.each(["0.39.4", "0.39.9", "0.40.0", "0.41.0", "0.41.9"])(
    "accepts supported agent-browser release %s",
    (version) => {
      expect(agentBrowserCompatibility(version).status).toBe("supported");
    },
  );
  test.each(["0.39.3", "0.38.9", "0.0.0"])(
    "rejects agent-browser %s below the supported baseline",
    (version) => {
      expect(agentBrowserCompatibility(version).status).toBe("unsupported");
    },
  );
  test.each(["0.42.0", "1.0.0", "0.41.0-beta", "secret-version"])(
    "reports untested agent-browser %s without claiming it is missing",
    (version) => {
      expect(agentBrowserCompatibility(version).status).toBe("untested");
    },
  );
  test("accepts Chrome patch updates but keeps a new major release untested", () => {
    expect(chromiumCompatibility("156.0.8078.80").status).toBe("supported");
    expect(chromiumCompatibility("156.1.9999.101").status).toBe("supported");
    expect(chromiumCompatibility("157.0.0.0").status).toBe("untested");
  });
  test("does not trust partial banners, other Chrome products, or arbitrary version output", () => {
    const result = browserVersionCompatibility(
      "secret agent-browser 0.41.0",
      "Google Chrome 156.0.8078.80 secret",
    );

    expect(result.agentBrowser.status).toBe("untested");
    expect(result.chromium.status).toBe("untested");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
