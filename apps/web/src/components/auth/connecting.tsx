/** @jsxImportSource preact */
interface ConnectingProps {
  readonly error: string;
  readonly onRetry: () => void;
}

export const Connecting = ({ error, onRetry }: ConnectingProps) => (
  <main class="grid min-h-dvh place-items-center p-6">
    <p>Connecting to Poppet…</p>
    {error && (
      <>
        <p class="text-[0.85rem] text-error" role="alert">
          {error}
        </p>
        <button onClick={onRetry}>Try connecting again</button>
      </>
    )}
  </main>
);
