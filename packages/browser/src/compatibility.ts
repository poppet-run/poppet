/** Supported release lines; exact binaries used by CI live in test-versions.json. */
export interface BrowserCompatibility {
  readonly status: "supported" | "untested" | "unsupported";
  readonly message: string;
}

const release = (version: string) => {
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return null;

  return version.split(".").map(Number);
};

export const agentBrowserCompatibility = (version: string): BrowserCompatibility => {
  const parts = release(version);

  if (parts === null)
    return { status: "untested", message: "The agent-browser version could not be recognized." };
  const [major = 0, minor = 0, patch = 0] = parts;

  if (major === 0 && (minor < 39 || (minor === 39 && patch < 4)))
    return {
      status: "unsupported",
      message: `agent-browser ${version} is older than the minimum supported version, 0.39.4.`,
    };

  if (major === 0 && minor >= 39 && minor < 42)
    return {
      status: "supported",
      message: `agent-browser ${version} is within the supported range, 0.39.4 through 0.41.x.`,
    };

  return {
    status: "untested",
    message: `agent-browser ${version} has not been validated with Poppet. Supported versions are 0.39.4 through 0.41.x.`,
  };
};

export const chromiumCompatibility = (version: string): BrowserCompatibility => {
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))
    return {
      status: "untested",
      message: "The Chrome for Testing version could not be recognized.",
    };
  const major = Number(version.split(".")[0]);

  if (major === 156)
    return {
      status: "supported",
      message: `Chrome for Testing ${version} is within the supported Chrome 156 release line.`,
    };

  return {
    status: "untested",
    message: `Chrome for Testing ${version} has not been validated with Poppet. Use a Chrome 156 release.`,
  };
};

/** Only parse expected version banners; never echo arbitrary executable output. */
export const browserVersionCompatibility = (agentOutput: string, chromeOutput: string) => ({
  agentBrowser: agentBrowserCompatibility(
    /^agent-browser (\d+\.\d+\.\d+)$/.exec(agentOutput.trim())?.[1] ?? "",
  ),
  chromium: chromiumCompatibility(
    /^Google Chrome for Testing (\d+\.\d+\.\d+\.\d+)$/.exec(chromeOutput.trim())?.[1] ?? "",
  ),
});
