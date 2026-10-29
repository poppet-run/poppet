/** The page a browser shows after its callback; `received` tells the owner what happens next. */
export const callbackResponse = (accepted: boolean, received: string) => {
  const title = accepted ? "Authorization received" : "Sign-in could not be completed";

  const message = accepted
    ? received
    : "Return to your terminal for details, then start a new sign-in when you're ready.";

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Poppet</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100svh; display: grid; place-items: center;
      background: #faf7f2; color: #252b37; }
    main { max-width: 32rem; margin: 2rem; }
    .brand { font-weight: 650; color: #855032; }
    h1 { font-size: clamp(1.75rem, 5vw, 2.25rem); line-height: 1.2; }
    p { line-height: 1.6; }
    .close { color: #626774; font-size: .875rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #171e2e; color: #faf1e5; }
      .brand { color: #f4ba8e; }
      .close { color: #b1b7c5; }
    }
  </style>
</head>
<body>
  <main>
    <p class="brand">Poppet</p>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="close">You can close this tab.</p>
  </main>
</body>
</html>`,
    {
      status: accepted ? 200 : 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    },
  );
};
