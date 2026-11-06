/** @jsxImportSource preact */
import { Wordmark } from "../shared/wordmark";

interface LoginProps {
  readonly accessKey: string;
  readonly sending: boolean;
  readonly error: string;
  readonly onAccessKeyChange: (value: string) => void;
  readonly onSignIn: () => void;
}

export const Login = ({ accessKey, sending, error, onAccessKeyChange, onSignIn }: LoginProps) => (
  <main class="grid min-h-dvh place-items-center p-6">
    <form
      class="flex w-full max-w-[400px] flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSignIn();
      }}
    >
      <Wordmark />
      <h1 class="mt-4 text-[1.375rem] leading-[1.3]">Your conversations, wherever you are.</h1>
      <p class="text-muted">Enter the access key configured on your Poppet host.</p>
      <label class="text-[0.85rem]" for="key">
        Access key
      </label>
      <input
        class="w-full rounded-md border border-line bg-surface p-[0.8rem] text-inherit mobile:text-base"
        id="key"
        type="password"
        autoComplete="current-password"
        value={accessKey}
        onInput={(event) => onAccessKeyChange(event.currentTarget.value)}
        required
      />
      <button
        class="border-transparent bg-accent font-[650] text-navy hover:bg-accent-hover"
        disabled={sending || !accessKey}
      >
        Sign in
      </button>
      {error && (
        <p class="text-[0.85rem] text-error" role="alert">
          {error}
        </p>
      )}
    </form>
  </main>
);
