/** Cuts text to at most `bytes` UTF-8 bytes without splitting a character. */
export const clip = (text: string, bytes: number) => {
  let used = 0;
  let end = 0;

  for (const character of text) {
    used += Buffer.byteLength(character);

    if (used > bytes) break;
    end += character.length;
  }

  return text.slice(0, end);
};

/** The largest count up to `max` that fits, or -1 when even zero does not; `fits` must not fit again after it stops. */
export const longestFit = (max: number, fits: (count: number) => boolean) => {
  if (!fits(0)) return -1;
  let low = 0;
  let high = max;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (fits(middle)) low = middle;
    else high = middle - 1;
  }

  return low;
};

/** The longest prefix that fits without splitting a surrogate pair; null when even "" does not fit. */
export const fitPrefix = (text: string, fits: (prefix: string) => boolean) => {
  const prefix = (length: number) => text.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
  const length = longestFit(text.length, (count) => fits(prefix(count)));

  return length < 0 ? null : prefix(length);
};

/**
 * Renders the whole text when it fits in `limit` bytes, otherwise its longest fitting prefix
 * marked truncated; null when even an empty prefix does not fit.
 */
export const fitText = (
  text: string,
  limit: number,
  render: (text: string, truncated: boolean) => string,
) => {
  const fits = (output: string) => Buffer.byteLength(output) <= limit;
  const whole = render(text, false);

  if (fits(whole)) return whole;
  const shown = fitPrefix(text, (prefix) => fits(render(prefix, true)));

  return shown === null ? null : render(shown, true);
};
